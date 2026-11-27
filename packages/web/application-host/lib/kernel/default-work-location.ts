import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { resourceThreadSource } from './thread-context.js';
import { freezeProjectSourceSelection, parseWorkspaceLocations, parseDefaultWorkspaceLocationId, workspaceLocationSource,
  type ThreadLocationDirectory, type ProjectEntry, type ProjectSourceSelection, type ThreadIdentity, type ThreadPrepareSource, type ThreadPreparedSource } from '@varin/application-client';
import type { SourceResourceOwner, ThreadSummary } from '@varin/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { SourceDirectory } from './thread-sources.js';
import { SourceAdmissionError } from './source-admission-error.js';
import type { DocumentRootGuard } from '../documents/allowed-roots.js';
import { canonicalizePathIdentity } from '../workspace/path-safety.js';

/** A Bot owns its data directory even when a deployment only exposes a separate
 * workspace for tools. Choose a starting path before ordinary source admission. */
export function createBotWorkingDirectoryResolver(workspace: { root: string; lockdown: boolean }, allowedRoot: DocumentRootGuard) {
  return async (homeDir: string): Promise<string> => {
    if (!workspace.lockdown) return homeDir;
    const home = await canonicalizePathIdentity(homeDir, { allowMissing: true });
    return await allowedRoot(home) ? home : workspace.root;
  };
}

/** Only for a first use, after branch history/explicit chat-only and task limits
 * have been considered. Never substitute the coordinator when a saved owner is unavailable. */
export function preferredWorkLocation(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown }, projects: ProjectEntry[]) {
  const id = parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null);
  if (id === null) return null;
  const selected = parseWorkspaceLocations(settings.workspaceLocations).find(row => row.id === id);
  if (!selected) throw new Error('The default workspace location is no longer saved; choose another location');
  return workspaceLocationSource(selected, projects);
}

type WorkLocation = { resourceOwner: SourceResourceOwner; path: string; workspaceId?: string | null; selection?: ProjectSourceSelection; requiresProjectContext?: boolean };
export type LazyDefaultWorkLocation = { resourceOwner: SourceResourceOwner; path: string; workspaceId?: string };
export type DefaultWorkLocationSelection = ThreadPreparedSource['source'] | { lazyWorkLocation: LazyDefaultWorkLocation } | null;

async function resolveWorkLocation(location: WorkLocation, directory: Pick<SourceDirectory, 'resolve'>, signal?: AbortSignal) {
  const selected = location.selection?.mode === 'native_workspace'
    ? { resourceOwner: location.resourceOwner, workspaceId: location.selection.workspaceId }
    : await directory.resolve({ resourceOwner: location.resourceOwner, path: location.path }, signal);
  if (!isDeepStrictEqual(location.resourceOwner, selected.resourceOwner) || location.workspaceId && selected.workspaceId !== location.workspaceId) {
    throw new SourceAdmissionError('source_changed');
  }
  return { resourceOwner: selected.resourceOwner, workspaceId: selected.workspaceId,
    mode: location.selection?.mode ?? 'live_root', ...(location.selection ? { selection: location.selection } : {}),
  } as const;
}

export function listWorkLocations(settings: { workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown },
  projects: ProjectEntry[], servicePath: string, providerDefault?: LazyDefaultWorkLocation, managedOnly = false): ThreadLocationDirectory & { projects: ThreadLocationDirectory['locations'] } {
  const favorites = parseWorkspaceLocations(settings.workspaceLocations ?? []);
  const defaultId = parseDefaultWorkspaceLocationId(settings.defaultWorkspaceLocationId ?? null);
  const providerLocation = providerDefault && { id: 'deployment:workspace', name: 'Managed workspace', ...providerDefault };
  const locations = [...(providerLocation ? [providerLocation] : []), ...favorites.map(row => {
      if (row.kind === 'project' && !projects.some(project => project.id === row.projectId)) {
        return { id: row.id, name: row.projectId, unavailable: 'Project no longer registered' };
      }
      const { name, resourceOwner, path, workspaceId, selection } = workspaceLocationSource(row, projects);
      return { id: row.id, name, resourceOwner, path, ...(workspaceId ? { workspaceId } : {}), ...(selection ? { selection } : {}) };
    })].filter(location => !managedOnly || 'resourceOwner' in location && location.resourceOwner.kind === 'managed_host');
  return { servicePath, defaultId: (managedOnly && !locations.some(location => location.id === defaultId) ? null : defaultId) ?? providerLocation?.id ?? null,
    projects: projects.filter(project => (!managedOnly || project.source?.resourceOwner.kind === 'managed_host') && !favorites.some(row => row.kind === 'project' && row.projectId === project.id)).map(project => {
      const id = `project:${project.id}`;
      return { id, ...workspaceLocationSource({ kind: 'project', id, projectId: project.id }, projects) };
    }),
    locations };
}

/** The ordinary native input and cold work paths share this resolver. A completed
 * branch, even with no source, is not eligible for creation preferences. */
export function createConversationWorkLocation({ agentRuntime, sourceDirectory, readWorkspaceSettings, prepare, botWorkingDirectory, servicePath, providerDefault, denyLocal }: {
  agentRuntime: Pick<AgentRuntimeClient, 'context' | 'launch' | 'sourceTools' | 'principalCanUseHostResources' | 'organizationCreationDefaults'>;
  sourceDirectory: Pick<SourceDirectory, 'resolve'>;
  readWorkspaceSettings(): Promise<{ projects: ProjectEntry[]; workspaceLocations?: unknown; defaultWorkspaceLocationId?: unknown }>;
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  botWorkingDirectory(id: string): Promise<string>;
  servicePath: string;
  providerDefault?: LazyDefaultWorkLocation;
  denyLocal?(): never;
}) {
  async function creationLocation(thread: ThreadSummary, signal?: AbortSignal): Promise<WorkLocation> {
    const defaults = await agentRuntime.organizationCreationDefaults(thread.thread_id, signal);
    if (defaults?.source) return { ...defaults.source, ...(defaults.projectId ? { requiresProjectContext: true } : {}) };
    if (defaults?.projectId) {
      const project = (await readWorkspaceSettings()).projects.find(project => project.id === defaults.projectId);
      if (!project) throw new Error('The conversation’s original default project is no longer registered. Select a source explicitly.');
      return { path: project.path, resourceOwner: project.source?.resourceOwner ?? { kind: 'local' },
        ...(project.source ? { workspaceId: project.source.workspaceId } : {}), selection: freezeProjectSourceSelection(project) };
    }
    if (thread.bot_id) {
      return providerDefault ?? { resourceOwner: { kind: 'local' }, path: await botWorkingDirectory(thread.bot_id) };
    }
    const saved = await readWorkspaceSettings();
    const preferred = preferredWorkLocation(saved, saved.projects);
    return (denyLocal && preferred?.resourceOwner.kind === 'local' ? null : preferred)
      ?? providerDefault ?? { resourceOwner: { kind: 'local' }, path: servicePath };
  }

  return async (identity: ThreadIdentity, thread: ThreadSummary, signal?: AbortSignal): Promise<DefaultWorkLocationSelection> => {
    const latest = thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run;
    const checkpoint = await agentRuntime.context(identity.branchId, signal);
    const prior = latest ? (await agentRuntime.launch(latest.id, signal))?.selection : undefined;
    const inherited = checkpoint?.resources ? checkpoint.resources.source : prior?.source;
    if (inherited) {
      const source = resourceThreadSource(inherited);
      if (!source) throw new Error('The inherited execution source is unavailable');
      if (source.resourceOwner.kind === 'local' && source.mode !== 'fixed_branch') denyLocal?.();
      return { ...source, tools: await agentRuntime.sourceTools(source.mode, signal) };
    }
    if (thread.parent_thread_id || !await agentRuntime.principalCanUseHostResources?.(thread.principal_id)) return null;
    if (prior?.lazy_work_location && !inherited) {
      const { resource_owner: resourceOwner, path, workspace_id: workspaceId } = prior.lazy_work_location;
      if (resourceOwner.kind === 'local') denyLocal?.();
      return { lazyWorkLocation: { resourceOwner, path, ...(workspaceId ? { workspaceId } : {}) } };
    }
    if (latest || checkpoint?.resources) return null;
    const saved = await creationLocation(thread, signal);
    if (saved.resourceOwner.kind === 'local') denyLocal?.();
    if (!saved.selection && !saved.requiresProjectContext) {
      return { lazyWorkLocation: { resourceOwner: saved.resourceOwner, path: saved.path, ...(saved.workspaceId ? { workspaceId: saved.workspaceId } : {}) } };
    }
    const location = await resolveWorkLocation(saved, sourceDirectory, signal);
    const key = `creation-location:${identity.threadId}:${identity.branchId}`;
    return (await prepare({ ...identity, key, ...location, content: { mode: 'saved-files' }, captureScopes: [] }, signal)).source;
  };
}
