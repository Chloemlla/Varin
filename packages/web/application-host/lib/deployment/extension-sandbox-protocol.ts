import { createHmac } from 'node:crypto';
import { isVarinExtensionId } from '@varin/extension-contract';

export const extensionNodeBase = '/api/harness/managed-execution/v1';
export const extensionBrokerPath = extensionNodeBase + '/extension-brokers/';
export const extensionIntegrity = /^sha256-[a-f0-9]{64}$/u;
export const extensionNodeCredential = '/run/varin-extension-private/node.json';
export const extensionSandboxProtocolVersion = 2;

export const extensionIdentityRoute = (extensionId: string) => extensionNodeBase + '/extension-identity/' + encodeURIComponent(extensionId);

export function parseExtensionIdentityRoute(url: string | undefined) {
  const prefix = extensionNodeBase + '/extension-identity/';
  if (!url?.startsWith(prefix)) return undefined;
  let id: string;
  try { id = decodeURIComponent(url.slice(prefix.length)); } catch { return undefined; }
  return isVarinExtensionId(id) ? id : undefined;
}

export const extensionBrokerRoute = (extensionId: string, integrity: string) =>
  extensionBrokerPath + encodeURIComponent(extensionId) + '/' + integrity;

export function parseExtensionBrokerRoute(url: string | undefined) {
  if (!url?.startsWith(extensionBrokerPath)) return undefined;
  const [encoded, integrity, extra] = url.slice(extensionBrokerPath.length).split('/');
  if (!encoded || !integrity || extra !== undefined || !extensionIntegrity.test(integrity)) return undefined;
  let extensionId: string;
  try { extensionId = decodeURIComponent(encoded); } catch { return undefined; }
  return isVarinExtensionId(extensionId) ? { extensionId, integrity } : undefined;
}

export const extensionChannelToken = (nodeToken: string, extensionId: string) =>
  createHmac('sha256', nodeToken).update('varin.extension-broker.v2:').update(extensionId).digest('base64url');

export const brokerFrame = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
