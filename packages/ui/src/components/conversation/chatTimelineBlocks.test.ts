import { expect, it } from 'vitest';
import { projectChatTimeline } from './chatTimelineProjection';
import { HistoryPresentation } from './historyPresentation';
import type { ThreadHistoryItem, ThreadRunUsage } from '@varin/application-client';
import { projectChatTimelineBlocks, type ChatTimelineBlockAliases } from './chatTimelineBlocks';
import type { ChatAssistantMessage, ChatSessionEntry, ChatSessionMessageEntry } from './types';

const user: ChatSessionMessageEntry = { id: 'prompt', parentId: null, runId: 'run', timestamp: '', type: 'message', message: { role: 'user', content: 'Question', timestamp: 0 } };
const answer = (id: string, content: ChatAssistantMessage['content']): ChatSessionMessageEntry => ({ id, parentId: user.id, runId: 'run', timestamp: '', type: 'message',
  message: { id, role: 'assistant', model: 'model', provider: '', api: '', stopReason: 'stop', timestamp: 0, content } });

it.each(['dialogue', 'live', 'sorted'])('folds one successful Run across supplementary user inputs in %s layout', mode => {
  const history: ThreadHistoryItem[] = [];
  const add = (id: string, source: 'user' | 'assistant', content: unknown) => history.push({
    id, parent: history.at(-1)?.id ?? null, run_id: 'run', thread_id: 'thread', provider: null, source, content,
  } as ThreadHistoryItem);
  add('question', 'user', { text: 'Review this' });
  add('comment', 'assistant', { id: 'model-item:2:r1:a', content: { kind: 'text', text: 'Checking now' } });
  add('tool', 'assistant', { id: 'model-item:2:r1:b', content: { kind: 'tool_call', call: { call_id: 'read', name: 'file_read', arguments: {} } } });
  add('supplement', 'user', { text: 'Also check the footer' });
  add('thought', 'assistant', { id: 'model-item:2:r2:a', content: { kind: 'reasoning_summary', text: 'Inspect the result' } });
  add('aside', 'assistant', { id: 'model-item:2:r2:b', content: { kind: 'text', text: 'Finishing up' }, opaque: { value: { phase: 'commentary' } } });
  add('result', 'assistant', { id: 'model-item:2:r2:c', content: { kind: 'text', text: 'First paragraph' } });
  add('conclusion', 'assistant', { id: 'model-item:2:r2:d', content: { kind: 'text', text: 'Second paragraph' } });
  const presenter = new HistoryPresentation('thread');
  const rows = (outcome?: ThreadRunUsage['outcome'], open = false, enabled = true) => {
    const view = presenter.project(history, undefined, outcome ? [{ runId: 'run', throughId: 'conclusion', requests: [], outcome }] : []);
    return projectChatTimelineBlocks(projectChatTimeline(view.entries), { dialogue: mode === 'dialogue', sorted: mode === 'sorted',
      collapseCompletedWork: enabled, expanded: () => open }).items;
  };
  for (const state of [undefined, 'failed', 'cancelled'] as const) expect(rows(state).some(row => row.kind === 'work-header')).toBe(false);
  const folded = rows('completed');
  expect(folded.filter(row => row.kind === 'work-header')).toHaveLength(1);
  expect(folded.filter(row => row.kind === 'user')).toHaveLength(2);
  const sources = (blocks: typeof folded) => blocks.flatMap(row => row.kind === 'work-part' && row.item.kind !== 'process' ? [row.item.sourceId] : []);
  expect(sources(folded)).toEqual(['result', 'conclusion']);
  expect(sources(rows('completed', true))).toEqual(['comment', 'tool', 'thought', 'aside', 'result', 'conclusion']);
  expect(rows('completed', false, false).some(row => row.kind === 'work-header')).toBe(false);
});

it('lifts a newly received image out of a cached folded process without loading its bytes', () => {
  const call = answer('images-call', [{ type: 'thinking', thinking: 'Inspect the image' },
    { type: 'toolCall', id: 'image-call', name: 'script_run', arguments: {} }]);
  const initial = projectChatTimeline([user, call]);
  const before = projectChatTimelineBlocks(initial, { sorted: false, dialogue: true, expanded: () => false });
  const receipt: ChatSessionMessageEntry = { id: 'image-receipt', parentId: call.id, runId: 'run', timestamp: '', type: 'message', message: {
    role: 'toolResult', toolCallId: 'image-call', toolName: 'script_run', content: [], timestamp: 0, isError: false, historyId: 'image-receipt',
    imageParts: [{ partIndex: 2, media: { media_type: 'image/png', source: { kind: 'operation', operation_id: 'image-op' }, content_ref: { content_object: 'image-bytes' } } }],
  } };
  const complete = projectChatTimeline([user, call, receipt], undefined, undefined, initial);
  const after = projectChatTimelineBlocks(complete, { sorted: false, dialogue: true, expanded: () => false, previous: before });
  expect(after.items.some(item => item.kind === 'dialogue' && item.itemId === 'tool:image-call')).toBe(true);
  const sorted = projectChatTimelineBlocks(complete, { sorted: true, expanded: () => false });
  expect(sorted.items.some(item => item.kind === 'activity' && item.activityId === 'tool:image-call')).toBe(true);
});

it('keeps direct answers and usable output visible without an empty disclosure', () => {
  const result = answer('result', [{ type: 'thinking', thinking: 'Private preview' }, { type: 'text', text: 'Result' }]);
  const image = answer('image', [{ type: 'toolCall', id: 'generate', name: 'image_generate', arguments: {} }]);
  const receipt: ChatSessionEntry = { id: 'end', parentId: result.id, runId: 'run', timestamp: '', type: 'run_usage', outcome: 'completed', usages: [] };
  const projection = projectChatTimeline([user, image, result, receipt]);
  const options = { sorted: false, dialogue: true, collapseCompletedWork: true, expanded: () => false };
  const shown = projectChatTimelineBlocks(projection, options).items;
  expect(shown.filter(item => item.kind === 'work-part').map(item => item.item.kind)).toEqual(['tool', 'text']);
  expect(projectChatTimelineBlocks(projection, { ...options, showThinking: false }).items.some(item => item.kind === 'work-header')).toBe(false);
});

it('keeps native message keys when an earlier prompt is discovered and virtualizes a long Run into small rows', () => {
  const messages = Array.from({ length: 200 }, (_, index) => answer(`answer:${index}`, [{ type: 'text', text: `${index}` }]));
  const aliases: ChatTimelineBlockAliases = new Map();
  const orphan = projectChatTimelineBlocks(projectChatTimeline(messages), { sorted: false, expanded: () => true, aliases });
  const joined = projectChatTimelineBlocks(projectChatTimeline([user, ...messages]), { sorted: false, expanded: () => true, previous: orphan, aliases });
  expect(joined.items.filter(item => item.kind === 'entry').map(item => item.id)).toEqual(orphan.items.filter(item => item.kind === 'entry').map(item => item.id));
  expect(joined.items.filter(item => item.kind === 'entry')).toHaveLength(messages.length);
  expect(joined.items.filter(item => item.kind === 'footer')).toHaveLength(1);
  expect(joined.items.find(item => item.kind === 'chrome')?.id).toBe(orphan.items.find(item => item.kind === 'chrome')?.id);
  expect(joined.items.find(item => item.kind === 'footer')?.id).toBe(orphan.items.find(item => item.kind === 'footer')?.id);
  expect(joined.items[0]).toMatchObject({ id: 'turn:prompt', kind: 'user' });
  const returned = projectChatTimelineBlocks(projectChatTimeline([user, ...messages]), { sorted: false, expanded: () => true, aliases });
  expect(returned.items.map(item => item.id)).toEqual(joined.items.map(item => item.id));
});

it('keeps sorted activities separately virtualized and preserves row identity across streaming deltas', () => {
  const call = answer('call', [{ type: 'thinking', thinking: 'Reason' }, { type: 'toolCall', id: 'call-id', name: 'read', arguments: {} }]);
  const entries = [user, call];
  const live: ChatAssistantMessage = { ...answer('live', [{ type: 'text', text: 'A' }]).message as ChatAssistantMessage, runId: 'run', stopReason: 'pending' };
  const first = projectChatTimeline(entries, live);
  const before = projectChatTimelineBlocks(first, { sorted: true, expanded: () => true });
  const next = projectChatTimeline(entries, { ...live, content: [{ type: 'text', text: 'Answer continues' }] }, undefined, first);
  const after = projectChatTimelineBlocks(next, { sorted: true, expanded: () => true, previous: before });
  expect(after.items).toBe(before.items);
  expect(after.items.filter(item => item.kind === 'activity')).toHaveLength(2);
  const closed = projectChatTimelineBlocks(next, { sorted: true, expanded: () => false, previous: after });
  expect(closed.items.filter(item => item.kind === 'activity')).toHaveLength(0);
  expect(closed.items.filter(item => item.kind === 'activity-header')).toHaveLength(1);
  expect(closed.items.some(item => item.kind === 'entry' && item.entry.id === call.id)).toBe(false);
  const custom = projectChatTimelineBlocks(next, { sorted: true, expanded: () => true, customIds: new Set([call.id]) });
  expect(custom.items.some(item => item.kind === 'entry' && item.entry.id === call.id)).toBe(true);
  expect(custom.items.some(item => item.kind === 'activity')).toBe(false);
  const summary: ChatSessionEntry = { id: 'run-usage:run', parentId: call.id, timestamp: '', type: 'run_usage', runId: 'run', usages: [{ requestId: 'request', input: 100, output: 20, measurement: 'actual', unknownReceipts: 0 }] };
  const ended = projectChatTimelineBlocks(projectChatTimeline([...entries, summary]), { sorted: true, expanded: () => true, previous: after });
  expect(ended.items.filter(item => item.kind === 'footer')).toHaveLength(1);
  expect(ended.items.filter(item => item.kind === 'entry').some(item => item.entry.type === 'run_usage')).toBe(false);
});
