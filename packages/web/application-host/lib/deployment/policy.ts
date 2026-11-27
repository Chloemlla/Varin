import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { VarinExtensionPackageSourceKind } from '@varin/extension-contract';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

const credentialSources = ['api-key', 'oauth', 'environment', 'google-adc', 'aws-chain', 'anthropic-federation', 'none'] as const;
export type ModelCredentialSource = typeof credentialSources[number];
export interface ModelCredentialPolicy {
  readonly sources: readonly ModelCredentialSource[];
  readonly oauthIssuers: readonly string[];
}
export interface DeploymentEgressPolicy {
  readonly userDestinations: 'all' | 'public';
  readonly requiredProxy?: string;
}
export interface McpDeploymentPolicy {
  readonly transports: readonly ('http' | 'stdio')[];
  readonly stdioPlacement: 'any' | 'managed';
}
const localInferenceOptions = ['embedding', 'speech', 'componentDownloads', 'tokenizerFiles', 'llamaCpp'] as const;
export type LocalInferencePolicy = { readonly [Key in typeof localInferenceOptions[number]]?: boolean };
const extensionSources = ['builtin', 'git', 'local', 'npm', 'source_view', 'github-release', 'release-archive'] as const satisfies readonly VarinExtensionPackageSourceKind[];
const extensionRealms = ['native', 'brokered', 'surface'] as const;
export interface ExtensionDeploymentPolicy {
  readonly sources?: readonly VarinExtensionPackageSourceKind[];
  readonly realms?: readonly typeof extensionRealms[number][];
  readonly artifactIntegrities?: readonly string[];
  readonly agentStaging?: boolean;
  readonly brokeredTransport?: 'child' | 'sandbox';
  readonly sandboxScope?: 'user' | 'extension';
}
export interface ExternalAgentDeploymentPolicy {
  readonly profiles?: readonly string[];
  readonly managedInstalls?: boolean;
  readonly placement?: 'any' | 'managed';
}
export interface DeploymentPolicy {
  readonly version: 1;
  readonly modelCredentials?: ModelCredentialPolicy;
  readonly connections?: { readonly staticHosts: boolean; readonly ssh: boolean };
  readonly ingress?: { readonly mode: 'gateway' };
  readonly egress?: DeploymentEgressPolicy;
  readonly mcp?: McpDeploymentPolicy;
  readonly localInference?: LocalInferencePolicy;
  readonly extensions?: ExtensionDeploymentPolicy;
  readonly externalAgents?: ExternalAgentDeploymentPolicy;
  readonly resourceProvider?: { readonly id: string; readonly socketPath: string; readonly credentialFile: string };
  readonly execution?: {
    readonly mode?: 'local' | 'none';
    readonly defaultWorkspace?: { readonly resourceId: string; readonly hostId: string; readonly path: string };
  };
  readonly background?: {
    readonly modelDirectorySnapshot?: string;
    readonly pluginCatalogSnapshot?: string;
    readonly updateChecks?: boolean;
  };
}

export class DeploymentPolicyDeniedError extends Error {
  readonly code = 'deployment-policy-denied';
  constructor(readonly section: keyof Omit<DeploymentPolicy, 'version'>, message: string) { super(message); }
}

function fields(value: unknown, section: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(section + ' must be an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error('Unknown deployment policy field ' + section + '.' + key);
  }
  return value as Record<string, unknown>;
}

function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v || v !== v.trim())) {
    throw new Error(field + ' must be an array of nonempty names');
  }
  return [...new Set<string>(value)];
}

function requiredName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(field + ' must be a nonempty string');
  return value;
}

function httpOrigin(value: unknown, field: string): string {
  if (typeof value === 'string') {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* report the policy field below */ }
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash) return url.origin;
  }
  throw new Error(field + ' must be an HTTP(S) origin without credentials, path, query or fragment');
}

export function parseDeploymentPolicy(value: unknown): DeploymentPolicy {
  const input = fields(value, 'policy', ['version', 'modelCredentials', 'ingress', 'egress', 'background', 'mcp', 'localInference', 'extensions', 'externalAgents', 'resourceProvider', 'execution', 'connections']);
  if (input.version !== 1) throw new Error('Unsupported deployment policy version (expected 1)');
  let modelCredentials: ModelCredentialPolicy | undefined;
  if (input.modelCredentials !== undefined) {
    const rule = fields(input.modelCredentials, 'modelCredentials', ['sources', 'oauthIssuers']);
    const sources = names(rule.sources, 'modelCredentials.sources');
    if (sources.some(source => !credentialSources.some(option => option === source))) throw new Error('Unknown modelCredentials.sources value');
    const issuers = names(rule.oauthIssuers === undefined ? [] : rule.oauthIssuers, 'modelCredentials.oauthIssuers');
    if (issuers.length && !sources.includes('oauth')) throw new Error('modelCredentials.oauthIssuers requires the oauth source');
    modelCredentials = { sources: sources as ModelCredentialSource[], oauthIssuers: issuers };
  }
  if (input.ingress !== undefined && fields(input.ingress, 'ingress', ['mode']).mode !== 'gateway') {
    throw new Error('Unknown ingress.mode (expected gateway)');
  }
  let egress: DeploymentEgressPolicy | undefined;
  if (input.egress !== undefined) {
    const rule = fields(input.egress, 'egress', ['userDestinations', 'requiredProxy']);
    if (rule.userDestinations !== 'all' && rule.userDestinations !== 'public') throw new Error('Unknown egress.userDestinations (expected all or public)');
    egress = {
      userDestinations: rule.userDestinations,
      ...(rule.requiredProxy === undefined ? {} : { requiredProxy: httpOrigin(rule.requiredProxy, 'egress.requiredProxy') }),
    };
  }
  let background: DeploymentPolicy['background'];
  if (input.background !== undefined) {
    const rule = fields(input.background, 'background', ['modelDirectorySnapshot', 'pluginCatalogSnapshot', 'updateChecks']);
    const snapshot = (name: string) => {
      const file = rule[name];
      if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('background.' + name + ' must be an absolute path');
      return file as string | undefined;
    };
    const modelDirectorySnapshot = snapshot('modelDirectorySnapshot');
    const pluginCatalogSnapshot = snapshot('pluginCatalogSnapshot');
    if (rule.updateChecks !== undefined && typeof rule.updateChecks !== 'boolean') throw new Error('background.updateChecks must be a boolean');
    background = {
      ...(modelDirectorySnapshot && { modelDirectorySnapshot }),
      ...(pluginCatalogSnapshot && { pluginCatalogSnapshot }),
      ...(rule.updateChecks !== undefined && { updateChecks: rule.updateChecks }),
    };
  }
  let mcp: McpDeploymentPolicy | undefined;
  if (input.mcp !== undefined) {
    const rule = fields(input.mcp, 'mcp', ['transports', 'stdioPlacement']);
    const transports = names(rule.transports, 'mcp.transports');
    if (!transports.every(name => name === 'http' || name === 'stdio')) throw new Error('Unknown mcp.transports value');
    const placement = rule.stdioPlacement === undefined ? 'any' : rule.stdioPlacement;
    if (placement !== 'any' && placement !== 'managed') throw new Error('Unknown mcp.stdioPlacement (expected any or managed)');
    mcp = { transports, stdioPlacement: placement };
  }
  let localInference: LocalInferencePolicy | undefined;
  if (input.localInference !== undefined) {
    const rule = fields(input.localInference, 'localInference', localInferenceOptions);
    for (const [name, enabled] of Object.entries(rule)) {
      if (typeof enabled !== 'boolean') throw new Error('localInference.' + name + ' must be a boolean');
    }
    localInference = { ...rule };
  }
  let extensions: ExtensionDeploymentPolicy | undefined;
  if (input.extensions !== undefined) {
    const rule = fields(input.extensions, 'extensions', ['sources', 'realms', 'artifactIntegrities', 'agentStaging', 'brokeredTransport', 'sandboxScope']);
    const sources = rule.sources === undefined ? undefined : names(rule.sources, 'extensions.sources');
    const realms = rule.realms === undefined ? undefined : names(rule.realms, 'extensions.realms');
    const artifactIntegrities = rule.artifactIntegrities === undefined ? undefined : names(rule.artifactIntegrities, 'extensions.artifactIntegrities');
    if (sources?.some(source => !extensionSources.some(known => known === source))) throw new Error('Unknown extensions.sources value');
    if (realms?.some(realm => !extensionRealms.some(known => known === realm))) throw new Error('Unknown extensions.realms value');
    if (artifactIntegrities?.some(integrity => !/^sha256-[a-f0-9]{64}$/.test(integrity))) throw new Error('extensions.artifactIntegrities must contain Varin SHA-256 artifact identifiers');
    if (rule.agentStaging !== undefined && typeof rule.agentStaging !== 'boolean') throw new Error('extensions.agentStaging must be a boolean');
    if (rule.brokeredTransport !== undefined && rule.brokeredTransport !== 'child' && rule.brokeredTransport !== 'sandbox')
      throw new Error('extensions.brokeredTransport must be child or sandbox');
    if (rule.sandboxScope !== undefined && rule.sandboxScope !== 'user' && rule.sandboxScope !== 'extension')
      throw new Error('extensions.sandboxScope must be user or extension');
    extensions = {
      ...(rule.sandboxScope !== undefined && { sandboxScope: rule.sandboxScope }),
      ...(sources && { sources: sources as VarinExtensionPackageSourceKind[] }),
      ...(realms && { realms: realms as typeof extensionRealms[number][] }),
      ...(artifactIntegrities && { artifactIntegrities }),
      ...(rule.agentStaging !== undefined && { agentStaging: rule.agentStaging }),
      ...(rule.brokeredTransport !== undefined && { brokeredTransport: rule.brokeredTransport }),
    };
  }
  let externalAgents: ExternalAgentDeploymentPolicy | undefined;
  if (input.externalAgents !== undefined) {
    const rule = fields(input.externalAgents, 'externalAgents', ['profiles', 'managedInstalls', 'placement']);
    const profiles = rule.profiles === undefined ? undefined : names(rule.profiles, 'externalAgents.profiles');
    if (rule.managedInstalls !== undefined && typeof rule.managedInstalls !== 'boolean') throw new Error('externalAgents.managedInstalls must be a boolean');
    if (rule.placement !== undefined && rule.placement !== 'any' && rule.placement !== 'managed') throw new Error('Unknown externalAgents.placement (expected any or managed)');
    externalAgents = {
      ...(profiles && { profiles }),
      ...(rule.managedInstalls !== undefined && { managedInstalls: rule.managedInstalls }),
      ...(rule.placement && { placement: rule.placement }),
    };
  }
  let resourceProvider: DeploymentPolicy['resourceProvider'];
  if (input.resourceProvider !== undefined) {
    const rule = fields(input.resourceProvider, 'resourceProvider', ['id', 'socketPath', 'credentialFile']);
    const socketPath = requiredName(rule.socketPath, 'resourceProvider.socketPath');
    const credentialFile = requiredName(rule.credentialFile, 'resourceProvider.credentialFile');
    if (!path.isAbsolute(socketPath) || !path.isAbsolute(credentialFile)) throw new Error('Resource provider socket and credential paths must be absolute');
    resourceProvider = { id: requiredName(rule.id, 'resourceProvider.id'), socketPath, credentialFile };
  }
  if (extensions?.brokeredTransport === 'sandbox' && !resourceProvider) throw new Error('The extension sandbox requires a resourceProvider');
  let execution: DeploymentPolicy['execution'];
  if (input.execution !== undefined) {
    const rule = fields(input.execution, 'execution', ['mode', 'defaultWorkspace']);
    if (rule.mode !== undefined && rule.mode !== 'local' && rule.mode !== 'none') throw new Error('execution.mode must be local or none');
    if (rule.mode === 'none' && rule.defaultWorkspace === undefined) throw new Error('Managed execution requires a default provider workspace');
    if (rule.mode !== undefined) execution = { mode: rule.mode };
    if (rule.defaultWorkspace !== undefined) {
      if (!resourceProvider) throw new Error('execution.defaultWorkspace requires a resourceProvider');
      const workspace = fields(rule.defaultWorkspace, 'execution.defaultWorkspace', ['resourceId', 'hostId', 'path']);
      const root = requiredName(workspace.path, 'execution.defaultWorkspace.path');
      if (!path.posix.isAbsolute(root) && !path.win32.isAbsolute(root)) throw new Error('execution.defaultWorkspace.path must be absolute on the Resource Node');
      execution = { ...execution, defaultWorkspace: {
        resourceId: requiredName(workspace.resourceId, 'execution.defaultWorkspace.resourceId'),
        hostId: requiredName(workspace.hostId, 'execution.defaultWorkspace.hostId'),
        path: root,
      } };
    }
  }
  if (execution?.mode === 'none') {
    if (extensions?.brokeredTransport === 'child') throw new Error('Managed execution requires the sandbox transport for third-party Host extensions');
    extensions = { ...extensions, brokeredTransport: 'sandbox' };
    mcp = { transports: mcp?.transports ?? ['http', 'stdio'], stdioPlacement: 'managed' };
    externalAgents = { ...externalAgents, placement: 'managed' };
  }
  let connections: DeploymentPolicy['connections'];
  const constrained = egress?.userDestinations === 'public' || Boolean(egress?.requiredProxy);
  const allowStatic = !constrained && input.ingress === undefined && execution?.mode !== 'none';
  if (input.connections !== undefined || !allowStatic) {
    const rule = input.connections === undefined ? {} : fields(input.connections, 'connections', ['staticHosts', 'ssh']);
    for (const [key, value] of Object.entries(rule)) {
      if (typeof value !== 'boolean') throw new Error('connections.' + key + ' must be a boolean');
      if (value && constrained) throw new Error('Restricted egress requires provider-managed connections');
    }
    connections = { staticHosts: (rule.staticHosts ?? allowStatic) === true, ssh: (rule.ssh ?? allowStatic) === true };
  }
  return { version: 1, ...(connections && { connections }), ...(modelCredentials && { modelCredentials }), ...(egress && { egress }), ...(background && { background }),
    ...(mcp && { mcp }), ...(localInference && { localInference }), ...(extensions && { extensions }), ...(externalAgents && { externalAgents }),
    ...(resourceProvider && { resourceProvider }), ...(execution && { execution }),
    ...(input.ingress !== undefined && { ingress: { mode: 'gateway' as const } }) };
}

export async function readDeploymentJson(file: string, dataDir: string, field: string): Promise<unknown> {
  if (!path.isAbsolute(file)) throw new Error(field + ' must be an absolute path');
  const [source, state] = await Promise.all([realpath(file), canonicalizePathIdentity(dataDir, { allowMissing: true })]);
  if (isPathWithinRoot(source, state)) throw new Error(field + ' must be outside VARIN_DATA_DIR');
  const raw = await readFile(source, 'utf8');
  try { return JSON.parse(raw); } catch { throw new Error(field + ' contains invalid JSON'); }
}

export async function readDeploymentPolicy(file: string | undefined, dataDir: string): Promise<DeploymentPolicy | undefined> {
  if (file === undefined) return undefined;
  return parseDeploymentPolicy(await readDeploymentJson(file, dataDir, 'VARIN_DEPLOYMENT_POLICY'));
}
