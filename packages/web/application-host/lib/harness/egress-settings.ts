import type { EgressHostConfiguration } from './egress.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type OutboundMode = 'auto' | 'direct' | 'proxy';
type NormalizedOutboundNetwork = { mode: OutboundMode; proxyUrl: string; noProxy: string; credentialRef?: string };

/** Validate a UI write without silently discarding a malformed security choice. */
export function normalizeOutboundNetwork(value: unknown): NormalizedOutboundNetwork {
  if (!record(value) || (value.mode !== 'auto' && value.mode !== 'direct' && value.mode !== 'proxy')) {
    throw new Error('Outbound network mode must be auto, direct, or proxy');
  }
  const mode = value.mode;
  if (value.proxyUrl !== undefined && typeof value.proxyUrl !== 'string') throw new Error('Proxy URL must be a string');
  if (value.noProxy !== undefined && typeof value.noProxy !== 'string') throw new Error('NO_PROXY must be a string');
  if (value.credentialRef !== undefined && typeof value.credentialRef !== 'string') throw new Error('Proxy credential binding must be a string');
  const proxyUrl = typeof value.proxyUrl === 'string' ? value.proxyUrl.trim() : '';
  if (mode === 'proxy') {
    let url: URL;
    try { url = new URL(proxyUrl); } catch { throw new Error('A valid proxy URL is required'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Proxy URL must be an HTTP(S) origin without credentials or path');
    }
  }
  return { mode, proxyUrl, noProxy: typeof value.noProxy === 'string' ? value.noProxy.trim() : '',
    ...(typeof value.credentialRef === 'string' ? { credentialRef: value.credentialRef } : {}) };
}

/** Fixed secret reference in the executing Host's service credential store. */
export const OUTBOUND_PROXY_CREDENTIAL_REF = 'varin-host-egress-proxy';

export function outboundProxyBinding(document: RecordValue): { credentialRef: string; proxyOrigin: string } | null {
  if (document.outboundNetwork === undefined) return null;
  const setting = normalizeOutboundNetwork(document.outboundNetwork);
  if (setting.mode !== 'proxy' || typeof setting.credentialRef !== 'string' || !setting.credentialRef) return null;
  return { credentialRef: setting.credentialRef, proxyOrigin: new URL(setting.proxyUrl).origin };
}

export function encodeOutboundProxyAuth(credentialRef: string, proxyOrigin: string, username: string, password: string): string {
  return Buffer.from(JSON.stringify({ credentialRef, proxyOrigin, username, password }), 'utf8').toString('base64');
}

export function readOutboundProxyAuth(auth: RecordValue, credentialRef: string, proxyOrigin: string): { username: string; password: string } | undefined {
  const entry = auth[OUTBOUND_PROXY_CREDENTIAL_REF];
  if (entry === undefined) return undefined;
  if (!record(entry) || entry.type !== 'api_key' || typeof entry.key !== 'string') {
    throw new Error('Proxy credential reference is malformed');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(entry.key, 'base64').toString('utf8')); }
  catch { throw new Error('Proxy credential reference is malformed'); }
  if (!record(decoded) || typeof decoded.username !== 'string' || typeof decoded.password !== 'string'
    || typeof decoded.credentialRef !== 'string' || typeof decoded.proxyOrigin !== 'string') {
    throw new Error('Proxy credential reference is malformed');
  }
  if (decoded.credentialRef !== credentialRef || decoded.proxyOrigin !== proxyOrigin) return undefined;
  return { username: decoded.username, password: decoded.password };
}

type EgressSettingsProjection =
  | { mode: 'proxy'; invalid: string }
  | { mode: OutboundMode; proxyUrl: string; noProxy: string; credential?: { ref: string; origin: string } }
  | undefined;

const invalidEgress = (error: unknown): { mode: 'proxy'; invalid: string } => ({
  mode: 'proxy',
  invalid: error instanceof Error ? error.message : 'invalid Host egress configuration',
});

/** Project only non-secret settings; malformed external policy remains fail closed. */
export function projectEgressSettings(document: RecordValue): EgressSettingsProjection {
  if (document.outboundNetwork === undefined) return undefined;
  try {
    const { mode, proxyUrl, noProxy, credentialRef } = normalizeOutboundNetwork(document.outboundNetwork);
    return {
      mode, proxyUrl, noProxy,
      ...(mode === 'proxy' && credentialRef ? { credential: { ref: credentialRef, origin: new URL(proxyUrl).origin } } : {}),
    };
  } catch (error) {
    return invalidEgress(error);
  }
}

const resolveEgressSettings = (
  projection: EgressSettingsProjection, readAuth: () => RecordValue,
): EgressHostConfiguration | undefined => {
  if (!projection || 'invalid' in projection) return projection;
  try {
    const { mode, proxyUrl, noProxy, credential } = projection;
    // Secrets have their own writer and may change without any settings write.
    const proxyAuth = credential ? readOutboundProxyAuth(readAuth(), credential.ref, credential.origin) : undefined;
    return { mode, proxyUrl, noProxy, ...(proxyAuth ? { proxyAuth } : {}) };
  } catch (error) {
    return invalidEgress(error);
  }
};

export function readEgressHostConfiguration(document: RecordValue, auth: RecordValue = {}): EgressHostConfiguration | undefined {
  return resolveEgressSettings(projectEgressSettings(document), () => auth);
}

export const bindEgressHostConfiguration = (
  projection: { read(): Promise<EgressSettingsProjection> },
  readAuth: () => RecordValue,
) => async (): Promise<EgressHostConfiguration | undefined> => resolveEgressSettings(await projection.read(), readAuth);
