import { viewedImages } from './viewedImages';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { toolRecord } from './toolInvocation';

/** Existing collaboration, user input and usable output views stay independent. */
export const isStandaloneTool = (name: string, execution?: ChatToolExecutionState, result?: ChatToolResultMessage) =>
  ['dispatch', 'send', 'ask_user', 'render_ui', 'image_generate', 'image_edit'].includes(name) || viewedImages(name, result, execution).length > 0;

const emptyDescendants: ReadonlyMap<string, ChatToolCall[]> = new Map();
const descendantsByExecutionSnapshot = new WeakMap<Record<string, ChatToolExecutionState>, ReadonlyMap<string, ChatToolCall[]>>();

/** All timeline turns share one index of the observed descendants in this snapshot. */
export function standaloneDescendants(executions?: Record<string, ChatToolExecutionState>): ReadonlyMap<string, ChatToolCall[]> {
  if (!executions) return emptyDescendants;
  const cached = descendantsByExecutionSnapshot.get(executions);
  if (cached) return cached;
  const groups = new Map<string, ChatToolCall[]>(), seen = new Set<string>();
  for (const execution of Object.values(executions)) {
    if (!execution.parentToolCallId || !isStandaloneTool(execution.name)
      || toolRecord(toolRecord(execution.operation?.intent).call).name === 'tool_invoke') continue;
    let root = execution.parentToolCallId;
    const visited = new Set([execution.toolCallId]);
    while (!visited.has(root) && executions[root]?.parentToolCallId) { visited.add(root); root = executions[root]!.parentToolCallId!; }
    const operation = execution.operationId ?? execution.toolCallId;
    if (visited.has(root) || seen.has(operation) || execution.operationId && executions[root]?.operationId === execution.operationId) continue;
    seen.add(operation);
    const calls = groups.get(root) ?? [];
    calls.push({ type: 'toolCall', id: execution.toolCallId, name: execution.name, arguments: execution.args ?? {} });
    groups.set(root, calls);
  }
  descendantsByExecutionSnapshot.set(executions, groups);
  return groups;
}
