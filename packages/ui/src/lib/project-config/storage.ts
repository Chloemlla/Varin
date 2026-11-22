import { runtimeFetch, getRuntimeEndpointGeneration } from '@varin/application-client';
import type {
  DocumentsAPI,
  FilesAPI,
  VarinDocumentReadResult,
  VarinResourceReference,
} from '@varin/application-client';
import { requireWorkspaceEpoch } from '@/lib/documents/mutation-token';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { documentIdentityForPath, pickWorkspaceRoot } from '@/lib/documents/path';
import type { VarinProjectConfig, VarinProjectRef } from './types';

type ProjectConfigFailureReason = 'conflict' | 'malformed' | 'unavailable' | 'unsupported' | 'write-failed';

export class VarinProjectConfigError extends Error {
  readonly reason: ProjectConfigFailureReason;
  readonly path?: string;

  constructor(message: string, options: { path?: string; reason: ProjectConfigFailureReason }) {
    super(message);
    this.name = 'VarinProjectConfigError';
    this.reason = options.reason;
    this.path = options.path;
  }
}

export interface VarinProjectConfigRuntime {
  documents: DocumentsAPI;
  files: FilesAPI;
  currentDirectory: string;
}

interface TextSnapshot {
  path: string;
  resource: VarinResourceReference;
  result: VarinDocumentReadResult;
  documents: DocumentsAPI;
}

const mutationToken = (snapshot: TextSnapshot, project: VarinProjectRef) => ({
  workspaceId: snapshot.resource.workspaceId,
  epoch: requireWorkspaceEpoch(snapshot.result.epoch),
  owner: { kind: 'project-config', id: project.id },
});

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return replaced || '/';
};

const joinPath = (base: string, ...segments: string[]): string => {
  const root = normalizePath(base);
  const tail = segments.map((segment) => segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return root === '/' ? `/${tail.join('/')}` : [root, ...tail].join('/');
};

const parentPath = (value: string): string => value.slice(0, value.lastIndexOf('/')) || '/';

const defaultRuntime = (): VarinProjectConfigRuntime | null => {
  const apis = getRegisteredRuntimeAPIs();
  if (!apis?.documents || !apis.files) return null;
  return {
    documents: apis.documents,
    files: apis.files,
    currentDirectory: useDirectoryStore.getState().currentDirectory,
  };
};

export const createVarinProjectConfigStore = (
  getRuntime: () => VarinProjectConfigRuntime | null = defaultRuntime,
) => {
  const mutationQueues = new Map<string, Promise<unknown>>();

  const runSerialized = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    mutationQueues.set(key, result);
    void result.finally(() => {
      if (mutationQueues.get(key) === result) mutationQueues.delete(key);
    }).catch(() => undefined);
    return result;
  };

  const requireRuntime = (): VarinProjectConfigRuntime => {
    const runtime = getRuntime();
    if (!runtime) {
      throw new VarinProjectConfigError('Project configuration runtime is unavailable', { reason: 'unavailable' });
    }
    return runtime;
  };

  const planDirectory = async (project: VarinProjectRef): Promise<string> => {
    const runtime = requireRuntime();
    const rawHome = (await runtime.files.getHomeDirectory()).trim();
    if (!rawHome) {
      throw new VarinProjectConfigError('Home directory is unavailable', { reason: 'unavailable' });
    }
    const home = normalizePath(rawHome);
    const pathId = project.id.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(pathId)) {
      throw new VarinProjectConfigError('Project identity is unavailable', { reason: 'unavailable' });
    }
    return joinPath(home, '.config', 'varin', 'projects', pathId, 'plans');
  };

  const resolveTextSnapshot = async (path: string, project?: VarinProjectRef): Promise<TextSnapshot> => {
    const runtime = requireRuntime();
    const home = await runtime.files.getHomeDirectory().catch(() => '');
    const root = pickWorkspaceRoot(path, [home, runtime.currentDirectory, project?.path ?? '']);
    if (!root) {
      throw new VarinProjectConfigError('Project configuration path is outside available roots', {
        path,
        reason: 'unavailable',
      });
    }
    const workspace = await runtime.documents.resolveWorkspace({ path: root });
    const resource = documentIdentityForPath(workspace.workspaceId, root, path);
    if (!resource) {
      throw new VarinProjectConfigError('Project configuration path is outside its workspace', {
        path,
        reason: 'unavailable',
      });
    }
    return {
      path,
      resource,
      result: await runtime.documents.read(resource),
      documents: runtime.documents,
    };
  };

  const endpoint = (project: VarinProjectRef) => '/api/projects/' + encodeURIComponent(project.id) + '/preferences';
  const fetchPreferences = async (project: VarinProjectRef): Promise<VarinProjectConfig> => {
    const response = await runtimeFetch(endpoint(project));
    if (!response.ok) throw new VarinProjectConfigError('Unable to read project preferences', { reason: 'unavailable' });
    return (await response.json()).preferences;
  };

  const write = async (project: VarinProjectRef, patch: Partial<VarinProjectConfig>, expected?: VarinProjectConfig) => {
    const response = await runtimeFetch(endpoint(project), { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      keepalive: typeof patch.projectNotes === 'string' && Object.keys(patch).length === 1 && !expected,
      body: JSON.stringify({ patch: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null])), expected }) });
    if (response.status === 409) return false;
    if (!response.ok) throw new VarinProjectConfigError('Unable to save project preferences', { reason: 'write-failed' });
    return true;
  };
  const inProject = <T>(project: VarinProjectRef, operation: (checkHost: () => void) => Promise<T>) => {
    const generation = getRuntimeEndpointGeneration();
    const checkHost = () => {
      if (generation !== getRuntimeEndpointGeneration()) throw new VarinProjectConfigError('Project Host changed', { reason: 'unavailable' });
    };
    return runSerialized(generation + ':' + project.id, async () => { checkHost(); const value = await operation(checkHost); checkHost(); return value; });
  };
  const read = (project: VarinProjectRef) => inProject(project, () => fetchPreferences(project));
  const mutate = (project: VarinProjectRef, createPatch: (current: Readonly<VarinProjectConfig>) => Partial<VarinProjectConfig> | null) => {
    return inProject(project, async checkHost => {
      const current = await fetchPreferences(project);
      checkHost();
      const patch = createPatch(current);
      return patch !== null && write(project, patch, current);
    });
  };
  const update = (project: VarinProjectRef, patch: Partial<VarinProjectConfig>) => inProject(project, () => write(project, patch));

  const readText = async (project: VarinProjectRef, path: string): Promise<string | null> => {
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status === 'missing') return null;
    if (snapshot.result.status !== 'ready') {
      throw new VarinProjectConfigError('Project text resource is not supported text', { path, reason: 'unsupported' });
    }
    return snapshot.result.content;
  };

  const writeText = async (project: VarinProjectRef, path: string, content: string): Promise<boolean> => {
    const runtime = requireRuntime();
    const created = await runtime.files.createDirectory(parentPath(path));
    if (created.success === false) return false;
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status !== 'missing' && snapshot.result.status !== 'ready') return false;
    const result = await snapshot.documents.write({
      token: mutationToken(snapshot, project),
      resource: snapshot.resource,
      content,
      encoding: snapshot.result.status === 'ready' ? snapshot.result.encoding : snapshot.result.status === 'missing' ? snapshot.result.format?.encoding ?? 'utf-8' : 'utf-8',
      bom: snapshot.result.status === 'ready' ? snapshot.result.bom : snapshot.result.status === 'missing' ? snapshot.result.format?.bom ?? false : false,
      ...(snapshot.result.status === 'ready' && snapshot.result.format ? { sourceFormat: snapshot.result.format } : {}),
      expectedRevision: snapshot.result.status === 'ready' ? snapshot.result.revision : null,
      operationId: crypto.randomUUID(),
    });
    return result.status === 'written';
  };

  const deleteText = async (project: VarinProjectRef, path: string): Promise<boolean> => {
    const snapshot = await resolveTextSnapshot(path, project);
    if (snapshot.result.status === 'missing') return true;
    const result = await snapshot.documents.delete({
      token: mutationToken(snapshot, project),
      resource: snapshot.resource,
      expectedRevision: snapshot.result.revision,
      operationId: crypto.randomUUID(),
    });
    return result.status === 'deleted';
  };

  return {
    deleteText,
    planDirectory,
    mutate,
    read,
    readText,
    update,
    writeText,
  };
};

export const varinProjectConfigStore = createVarinProjectConfigStore();
