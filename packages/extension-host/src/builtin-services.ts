// Host-owned service implementations. No module from an installed package is imported here.
// The caller has already resolved the exact selected artifact against the running distribution.
import * as builtins from '@varin/extension-builtins';
import {
  parseVarinToolJson, parseVarinRuntimeContractRequest,
  VARIN_CONTEXT_FRAGMENTS_CONTRACT, VARIN_CONTEXT_FRAGMENTS_METHOD,
  VARIN_EXTENSION_PACKAGES_CAPABILITY, VARIN_RUNTIME_CONTRACTS_CAPABILITY,
  type JsonValue, type VarinExtensionManifest,
} from '@varin/extension-contract';
import type { HostServiceInvocationContext, HostServiceProvision } from './service-registry.js';

type Dispatch = (capability: string, method: string, input: JsonValue, context: HostServiceInvocationContext) => Promise<JsonValue>;
type Route = { capability: string; method: string; runtimeQuery?: boolean };
const routes = new Map<string, Map<string, Route>>();
function family(owner: string, declarations: readonly { id: string; version: number }[], capability: string,
  method: (id: string) => string, runtimeQuery = false) {
  const services = routes.get(owner) ?? new Map<string, Route>();
  for (const declaration of declarations) services.set(`${declaration.id}@${declaration.version}`, {
    capability, method: method(declaration.id), runtimeQuery,
  });
  routes.set(owner, services);
}
const suffix = (prefix: string) => (id: string) => {
  if (!id.startsWith(prefix)) throw new Error(`Unexpected bundled service namespace: ${id}`);
  return id.slice(prefix.length);
};
family(builtins.VARIN_BUILTIN_WEB_EXTENSION_ID, builtins.WEB_TOOL_DECLARATIONS, builtins.WEB_CAPABILITY, suffix('varin.web.'));
family(builtins.VARIN_BUILTIN_OFFICE_EXTENSION_ID, builtins.OFFICE_TOOL_DECLARATIONS, builtins.OFFICE_CAPABILITY, suffix('varin.office.'));
family(builtins.VARIN_BUILTIN_BROWSER_EXTENSION_ID, builtins.BROWSER_TOOL_DECLARATIONS, builtins.BROWSER_CAPABILITY, suffix('varin.browser.'));
family(builtins.VARIN_BUILTIN_CODE_EXCHANGE_EXTENSION_ID, builtins.CODE_EXCHANGE_TOOL_DECLARATIONS, builtins.CODE_EXCHANGE_CAPABILITY, suffix('varin.code.'));
family(builtins.VARIN_BUILTIN_IMAGES_EXTENSION_ID, builtins.IMAGE_TOOL_DECLARATIONS, builtins.IMAGES_CAPABILITY, suffix('varin.images.'));
family(builtins.VARIN_BUILTIN_INTERACTIVE_UI_EXTENSION_ID, builtins.INTERACTIVE_UI_TOOL_DECLARATIONS, builtins.INTERACTIVE_UI_CAPABILITY, () => 'render');
family(builtins.VARIN_BUILTIN_ENVIRONMENT_FORWARD_EXTENSION_ID, builtins.ENVIRONMENT_FORWARD_TOOL_DECLARATIONS, builtins.ENVIRONMENT_FORWARD_CAPABILITY, suffix('varin.environment.'));
family(builtins.VARIN_BUILTIN_COMPUTER_EXTENSION_ID, builtins.COMPUTER_TOOL_DECLARATIONS, builtins.COMPUTER_CAPABILITY, suffix('varin.computer.'));
family(builtins.VARIN_BUILTIN_SCRIPT_EXTENSION_ID, builtins.SCRIPT_TOOL_DECLARATIONS, builtins.SCRIPT_CAPABILITY, suffix('varin.script.'));
family(builtins.VARIN_BUILTIN_RESEARCH_DISCOVERY_EXTENSION_ID, builtins.RESEARCH_DISCOVERY_TOOL_DECLARATIONS, builtins.RESEARCH_DISCOVERY_CAPABILITY, suffix('varin.research.'));
const management = builtins.VARIN_BUILTIN_RUNTIME_CONTRACTS_EXTENSION_ID;
family(management, builtins.RUNTIME_CONTRACT_TOOL_DECLARATIONS, VARIN_RUNTIME_CONTRACTS_CAPABILITY, () => 'query', true);
family(management, [builtins.EXTENSION_PACKAGE_TOOL_DECLARATION], VARIN_EXTENSION_PACKAGES_CAPABILITY, () => 'manage');
family(management, builtins.SETTINGS_TOOL_DECLARATIONS, builtins.SETTINGS_CAPABILITY, suffix('varin.settings.'));
family(management, builtins.VARIN_BUILTIN_RUNTIME_CONTRACTS_EXTENSION.manifest.provides!.services!.filter(s => s.id.startsWith('varin.bot-group.')), builtins.BOT_GROUP_CAPABILITY, suffix('varin.bot-group.'));

export function builtinServiceProvisions(manifest: VarinExtensionManifest, dispatch: Dispatch): HostServiceProvision[] | undefined {
  const services = manifest.provides?.services ?? [];
  if (manifest.id === builtins.VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID) {
    return services.map(descriptor => ({ descriptor, handler: (method, args, context) => {
      context.signal.throwIfAborted();
      if (args.length !== 0) throw new Error('Context fragments takes no arguments');
      if (method === 'inspect') return parseVarinToolJson(VARIN_CONTEXT_FRAGMENTS_CONTRACT);
      if (method !== VARIN_CONTEXT_FRAGMENTS_METHOD) throw new Error('Unknown context fragments method');
      return { sections: [{ name: 'execution-reporting', kind: 'instruction',
        content: 'Distinguish completed work, attempted work, and proposed next steps. Preserve uncertainty when an operation has no confirmed outcome. Describe a missing capability honestly.' }] };
    } }));
  }
  const targets = routes.get(manifest.id);
  if (!targets) return undefined;
  return services.map(descriptor => {
    const target = targets.get(`${descriptor.id}@${descriptor.version}`);
    if (!descriptor.tool || !target) throw new Error(`Bundled tool has no Host implementation: ${descriptor.id}`);
    return { descriptor, handler: (method, args, context) => {
      context.signal.throwIfAborted();
      if (method === 'inspect' && !args.length) return parseVarinToolJson(descriptor);
      if (method !== 'execute' || args.length !== 1) throw new Error('Expected one input to the bundled tool');
      const input = args[0]!;
      if (target.runtimeQuery) parseVarinRuntimeContractRequest(input);
      return dispatch(target.capability, target.method, input, context);
    } };
  });
}

// No extension module, process, storage or disposable resources. Registry pins own actual calls.
export const declarationLifecycle = {
  async request(method: string) {
    if (method === 'storage.sync') return null;
    throw new Error(`Host declaration has no extension transport: ${method}`);
  },
  async terminate() {},
  forceTerminate() {},
};
