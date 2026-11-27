use super::{failure, ModelFailure, ReqwestTransport};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Destinations {
    All,
    Public,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    user_destinations: Destinations,
    required_proxy: Option<String>,
}

struct Routes {
    user: ReqwestTransport,
    public_direct: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("deployment policy requires public addresses")]
pub(super) struct DestinationDenied;

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(
                (a, b, c),
                (0 | 10 | 127 | 224..=255, _, _)
                    | (100, 64..=127, _)
                    | (169, 254, _)
                    | (172, 16..=31, _)
                    | (192, 168, _)
                    | (192, 0, 0 | 2)
                    | (192, 88, 99)
                    | (198, 18 | 19, _)
                    | (198, 51, 100)
                    | (203, 0, 113)
            )
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public(mapped.into());
            }
            let [first, second, ..] = ip.segments();
            first & 0xe000 == 0x2000
                && first != 0x2002
                && !(first == 0x2001 && (second < 0x200 || second == 0xdb8))
                && !(first == 0x3fff && second < 0x1000)
        }
    }
}

struct PublicResolver;
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses.iter().any(|address| !is_public(address.ip())) {
                return Err(DestinationDenied.into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn invalid_policy() -> ModelFailure {
    failure("transport_setup", "invalid Host deployment egress policy")
}

fn routes() -> Result<Option<Routes>, ModelFailure> {
    let raw = match std::env::var("VARIN_KERNEL_DEPLOYMENT_EGRESS") {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(_) => return Err(invalid_policy()),
    };
    let policy: Policy = serde_json::from_str(&raw).map_err(|_| invalid_policy())?;
    let public_direct =
        policy.required_proxy.is_none() && matches!(policy.user_destinations, Destinations::Public);
    let user = if let Some(proxy) = policy.required_proxy {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| invalid_policy())?;
        ReqwestTransport::new(move || reqwest::Client::builder().no_proxy().proxy(proxy.clone()))
    } else if public_direct {
        ReqwestTransport::new(|| {
            reqwest::Client::builder()
                .no_proxy()
                .dns_resolver(Arc::new(PublicResolver))
        })
    } else {
        return Ok(None);
    };
    Ok(Some(Routes {
        user,
        public_direct,
    }))
}

pub(super) fn transport(endpoint: &str) -> Result<Option<&'static ReqwestTransport>, ModelFailure> {
    static ROUTES: OnceLock<Result<Option<Routes>, ModelFailure>> = OnceLock::new();
    let Some(routes) = ROUTES.get_or_init(routes).as_ref().map_err(Clone::clone)? else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(endpoint).map_err(|_| invalid_policy())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(denied());
    }
    if routes.public_direct {
        let address = url
            .host_str()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok());
        if address.is_some_and(|address| !is_public(address)) {
            return Err(denied());
        }
    }
    Ok(Some(&routes.user))
}

pub(super) fn denied() -> ModelFailure {
    failure(
        "deployment-policy-denied",
        "Deployment policy egress requires a public HTTP(S) destination",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[tokio::test]
    async fn restricted_connector_rejects_non_public_dns_answers() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .dns_resolver(Arc::new(PublicResolver))
            .build()
            .unwrap();
        let error = client
            .get("http://localhost:8080")
            .send()
            .await
            .unwrap_err();
        let mut source = error.source();
        while let Some(cause) = source {
            if cause.is::<DestinationDenied>() {
                return;
            }
            source = cause.source();
        }
        panic!("destination policy error did not reach the transport: {error:?}");
    }
}
