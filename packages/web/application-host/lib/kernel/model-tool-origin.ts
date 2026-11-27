import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ToolOrigin } from './protocol.generated.js';

/** The disclosure gateway preserves model authority. Policy and script callbacks have their own origin. */
export async function isModelToolOrigin(runtime: Pick<AgentRuntimeClient, 'operation'>, runId: string, origin: ToolOrigin, signal: AbortSignal) {
  if (origin.kind === 'model_step') return true;
  if (origin.kind !== 'nested_call') return false;
  const parent = await runtime.operation(origin.parent_operation_id, signal);
  return parent.run_id === runId && parent.phase === 'running' && !parent.cancel_requested
    && parent.executor === 'tool_invoke'
    && (parent.intent as { origin?: ToolOrigin } | null)?.origin?.kind === 'model_step';
}
