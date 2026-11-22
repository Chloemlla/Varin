use std::{error::Error, io};

/// Persist diagnostic labels and OS codes. Arbitrary source text can contain a
/// signed endpoint, proxy credentials or peer-controlled certificate names.
pub(super) fn cause(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "operation timed out".into();
    }
    let mut parts = Vec::new();
    let mut next = error.source();
    while let Some(source) = next {
        next = source.source();
        let label = if let Some(io) = source.downcast_ref::<io::Error>() {
            // io::Error::source skips the wrapped error itself (e.g. a TLS error).
            if let Some(inner) = io.get_ref() {
                next = Some(inner);
            }
            match io.raw_os_error() {
                Some(code) => format!("{} (OS error {code})", io.kind()),
                None => io.kind().to_string(),
            }
        } else if let Some(tls) = source.downcast_ref::<rustls::Error>() {
            match tls {
                rustls::Error::InvalidCertificate(cert) => certificate_cause(cert).into(),
                rustls::Error::AlertReceived(alert) => format!("TLS alert: {alert:?}"),
                _ => "TLS protocol error".into(),
            }
        } else if let Some(http) = source.downcast_ref::<hyper::Error>() {
            // Hyper's Display describes the HTTP error kind, excluding its source.
            http.to_string()
        } else {
            // The connector does not export its DNS and CONNECT error types.
            match source.to_string().as_str() {
                "dns error" => "DNS resolution failed",
                "tunnel error: proxy authorization required" => "proxy authentication required",
                message if message.starts_with("tunnel error:") => "proxy tunnel failed",
                _ => continue,
            }
            .into()
        };
        parts.push(label);
    }
    if parts.is_empty() {
        // reqwest attaches the request URL even to ordinary connection errors.
        return error.without_url().to_string();
    }
    parts.join(": ")
}

fn certificate_cause(cert: &rustls::CertificateError) -> &'static str {
    use rustls::CertificateError::*;
    match cert {
        UnknownIssuer => "TLS certificate has an unknown issuer",
        Expired | ExpiredContext { .. } => "TLS certificate has expired",
        NotValidYet | NotValidYetContext { .. } => "TLS certificate is not yet valid",
        NotValidForName | NotValidForNameContext { .. } => "TLS certificate hostname mismatch",
        Revoked => "TLS certificate has been revoked",
        _ => "TLS certificate validation failed",
    }
}
