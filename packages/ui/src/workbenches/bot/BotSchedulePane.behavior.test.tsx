import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduledTask, ThreadFamilyAPI } from '@varin/application-client';
import type { CalendarOccurrence, FamilyHistoryEntry } from '@varin/protocol';
import { BotSchedulePane } from './BotSchedulePane';
import { BotPanelContext, type BotPanelModel } from './botPanelModel';
import { readCalendarReply } from './calendarReply';

const state = vi.hoisted(() => ({ page: vi.fn(), reveal: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: Object.assign(() => false, { getState: () => ({ setScheduledTasksDialogOpen: state.page }) }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en-US' }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./BotScheduleResult', () => ({
  BotScheduleResult: ({ record, open }: { record: CalendarOccurrence; open: boolean }) =>
    open ? <div role="dialog" data-result={record.id}>{record.failure_code}</div> : null,
}));

const entry = { runtime: 'agent' as const, threadId: 'bot-entry', branchId: 'main' };
const selected = { ...entry, branchId: 'sub-branch' };
const record: CalendarOccurrence = {
  id: 'occurrence', definition_id: 'schedule', generation: 1, revision: 1, reason: { kind: 'manual', key: 'click' },
  observed_at_ms: 100, target_kind: 'existing_work', thread_id: entry.threadId, branch_id: 'other-branch',
  input_id: 'calendar-input:occurrence', history_item_id: 'original-history-item', run_id: 'specific-run', execution_id: null, goal_id: null, state: 'completed',
  hold_reason: null, failure_code: null,
};
const failure: CalendarOccurrence = {
  ...record, id: 'failed-preparation', observed_at_ms: 90, target_kind: 'new_work', run_id: null,
  input_id: null, state: 'held', failure_code: 'calendar_preparation:model:model-unavailable',
};
const independent: CalendarOccurrence = { ...record, id: 'independent', observed_at_ms: 80, target_kind: 'new_work' };
const task = {
  id: 'schedule', name: 'Deployment check', schedule: { kind: 'daily' }, enabled: true,
  target: { kind: 'existing_work', threadId: entry.threadId, branchId: entry.branchId },
  calendar: { definition: { next_at_ms: 180 }, occurrences: [independent, failure, record] },
} as ScheduledTask;
const model = {
  bot: { id: 'bot', entry, name: 'Varin', homeDir: '/bot' }, scheduleIdentity: selected,
  sessions: [{ identity: entry, branches: [selected] }], sessionTitle: () => 'Release preparation',
  facts: { tasks: { status: 'ready', value: [task] } }, openScheduleTurn: state.reveal,
} as unknown as BotPanelModel;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  state.page.mockReset(); state.reveal.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('keeps one row per definition and uses each execution’s saved destination', async () => {
  await act(async () => root.render(<BotPanelContext.Provider value={model}><BotSchedulePane /></BotPanelContext.Provider>));
  expect(container.querySelectorAll('.bot-schedule-trigger')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('.bot-schedule-trigger')!.click());
  const [continueWork, failed, newWork] = [...container.querySelectorAll<HTMLButtonElement>('.bot-schedule-record')];
  await act(async () => continueWork!.click());
  expect(state.reveal).toHaveBeenCalledWith(task.id, record, expect.any(Function));
  await act(async () => failed!.click());
  expect(container.querySelector('[role=dialog]')?.textContent).toBe(failure.failure_code);
  await act(async () => newWork!.click());
  expect(container.querySelector('[role=dialog]')?.getAttribute('data-result')).toBe(independent.id);
  expect(state.reveal).toHaveBeenCalledTimes(1);
});

it('opens the real management and editor pages with the resolved Bot branch', async () => {
  await act(async () => root.render(<BotPanelContext.Provider value={model}><BotSchedulePane /></BotPanelContext.Provider>));
  const [manage, create] = [...container.querySelectorAll<HTMLButtonElement>('footer button')];
  await act(async () => manage!.click());
  expect(state.page).toHaveBeenLastCalledWith(true, { identity: selected, botPage: { kind: 'arrangements' } });
  await act(async () => create!.click());
  expect(state.page).toHaveBeenLastCalledWith(true, expect.objectContaining({
    identity: selected, botPage: expect.objectContaining({ kind: 'editor', task: null, project: expect.objectContaining({ id: 'bot:bot' }) }),
  }));
  await act(async () => container.querySelector<HTMLButtonElement>('.bot-schedule-trigger')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('.bot-schedule-records header button')!.click());
  expect(state.page).toHaveBeenLastCalledWith(true, expect.objectContaining({ botPage: expect.objectContaining({ task }) }));
});

const historyEntry = (id: string, text: string, patch: Partial<FamilyHistoryEntry> = {}): FamilyHistoryEntry => ({
  id, parentId: null, sequence: 1, runId: 'specific-run', source: 'assistant', kind: 'text',
  body: { content: { kind: 'text', text } }, bodyBytes: 0, bodyTruncated: false, tool: null, ...patch,
});

it('joins only the original final reply across pages and reads an unabridged long item', async () => {
  const read = vi.fn().mockResolvedValueOnce({
    anchor: 'fixed', nextCursor: 'earlier',
    items: [
      historyEntry('tail', '', { assistantPhase: 'final_answer', assistantResponse: 'answer', bodyTruncated: true, body: null }),
      historyEntry('different-run', '# Later user conversation', { runId: 'later-run' }),
    ],
  }).mockResolvedValueOnce({
    anchor: 'fixed', nextCursor: null,
    items: [
      historyEntry('working', 'I will check', { assistantResponse: 'work' }),
      historyEntry('tool', '', { kind: 'tool_call', assistantResponse: 'work' }),
      historyEntry('heading', '## Result', { assistantPhase: 'final_answer', assistantResponse: 'answer' }),
      historyEntry('commentary', 'Progress update', { assistantPhase: 'commentary', assistantResponse: 'answer' }),
    ],
  });
  const item = vi.fn().mockResolvedValueOnce({ text: '{"content":{"kind":"text","text":"- **Original', nextOffset: 45 })
    .mockResolvedValueOnce({ text: ' Markdown**"}}', nextOffset: null });
  const signal = new AbortController().signal;
  const reply = await readCalendarReply({ read, item } as unknown as ThreadFamilyAPI, selected, 'specific-run', signal);
  expect(reply.flatMap(value => value.parts)).toEqual([{ kind: 'text', text: '## Result' }, { kind: 'text', text: '- **Original Markdown**' }]);
  expect(read).toHaveBeenCalledWith(selected, expect.objectContaining({ runId: 'specific-run', branchId: selected.branchId, cursor: 'earlier' }), signal);
  expect(item).toHaveBeenLastCalledWith(selected, expect.objectContaining({ runId: 'specific-run', anchor: 'fixed', itemId: 'tail', offset: 45 }), signal);
});
