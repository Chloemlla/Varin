import { SCRIPT_TOOL_DECLARATIONS, VARIN_BUILTIN_SCRIPT_EXTENSION_ID } from '@varin/extension-builtins';
import type { VarinExtensionServiceProvision } from '@varin/extension-contract';
import type { LazyWorkLocation } from './protocol.generated.js';

export const DORMANT_SCRIPT_IDENTITY = 'deferred-local-script-v1';
export { VARIN_BUILTIN_SCRIPT_EXTENSION_ID };
export const isScriptService = (id: string, version: number): boolean =>
  SCRIPT_TOOL_DECLARATIONS.some(entry => entry.id === id && entry.version === version);

export const isDormantScriptDefault = (location: LazyWorkLocation | null | undefined): boolean =>
  location != null;

export function dormantScriptDeclaration(descriptor: VarinExtensionServiceProvision, managed = false): VarinExtensionServiceProvision {
  const declaration = structuredClone(descriptor);
  if (!isScriptService(declaration.id, declaration.version) || !declaration.tool) return declaration;
  delete declaration.tool.requirements;
  if (declaration.tool.name === 'script_open') {
    const input = declaration.tool.inputSchema;
    if (typeof input === 'boolean') throw new Error('Built-in script input schema is not an object');
    input.properties = {
      ...(input.properties as object),
      resource_context: { type: 'string', minLength: 1, maxLength: 512, description: 'Use the returned context revision after reading the saved location instructions.' },
    };
    declaration.tool.description += managed
      ? ' This Run uses the recorded remote work location. If the result requires work-location context, read the instructions and use a new call with the returned resource_context.'
      : ' This Run uses its recorded local default; no alternate location is accepted. If the result requires work-location context, read the instructions and use a new call with the returned resource_context.';
  }
  // The original tool remains hidden from contexts without its physical
  // authority. The admitted dormant variant is available for explicit use.
  return declaration;
}
