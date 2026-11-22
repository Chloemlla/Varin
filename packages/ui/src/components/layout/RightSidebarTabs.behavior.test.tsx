import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ProjectContextPanel } from './RightSidebarTabs';

const fixture = vi.hoisted(() => ({
  projects: [{ id: 'qa', path: '/workspaces/qa' }, { id: 'other', path: '/workspaces/other' }],
  activeProjectId: null as string | null,
  observed: ['qa'],
}));
type Selector = (state: unknown) => unknown;
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: Selector) => select(fixture) }));
vi.mock('@/stores/useThreadStore', () => ({
  selectedComposerKey: () => 'thread',
  useThreadStore: (select: Selector) => select({ selectedIdentity: { threadId: 'thread' }, threads: [{ thread_id: 'thread', observer_project_ids: fixture.observed }] }),
}));
vi.mock('@/stores/useThreadDraftStore', () => ({ useThreadDraftStore: (select: Selector) => select({ drafts: {} }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: () => '/home' }));
vi.mock('@/stores/useGitStore', () => ({ useGitStore: () => new Map() }));
vi.mock('@/components/session/ProjectNotesTodoPanel', () => ({
  ProjectNotesTodoPanel: ({ projectRef }: { projectRef: { id: string } | null }) => <span>{projectRef?.id ?? 'unbound'}</span>,
}));

it('opens notes for the conversation project before file navigation and after navigating to another project', () => {
  const panel = () => renderToStaticMarkup(<ProjectContextPanel />);
  expect(panel()).toContain('<span>qa</span>');
  fixture.activeProjectId = 'other';
  expect(panel()).toContain('<span>qa</span>');
  fixture.observed = [];
  expect(panel()).toContain('<span>unbound</span>');
});
