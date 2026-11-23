/** One reply may span several items. Prefer an explicit final phase, then
 * the last spoken response. Older protocols can identify only a text segment. */
export type WorkPartRole = 'step' | 'tool' | 'kept-tool' | 'keep' | 'reply' | 'commentary' | 'final_answer';

export function completedWorkSteps<T>(parts: readonly T[], roleOf: (part: T) => WorkPartRole, responseOf: (part: T) => string | undefined): Set<T> {
  const steps = new Set<T>();
  const explicitFinal = parts.some(part => roleOf(part) === 'final_answer');
  let lastResponse: string | undefined;
  let foundReply = false;
  let beforeReply = false;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    const role = roleOf(part);
    switch (role) {
      case 'reply': {
        const response = responseOf(part);
        if (!foundReply) { lastResponse = response; foundReply = true; }
        if (beforeReply || explicitFinal || response !== lastResponse) steps.add(part);
        break;
      }
      case 'tool':
      case 'kept-tool':
        if (foundReply) beforeReply = true;
        if (role === 'tool') steps.add(part);
        break;
      case 'step':
      case 'commentary':
        steps.add(part);
        break;
    }
  }
  return steps;
}
