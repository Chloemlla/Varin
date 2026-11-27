import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { KernelClient } from '../kernel/kernel-client.js';
import { SourceAdmissionError } from '../kernel/source-admission-error.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';

const directoryName = 'external-workspaces';
const privateKey = (principalId: string, coordinatorHostId: string, conversationId: string) =>
  createHash('sha256').update(JSON.stringify([principalId, coordinatorHostId, conversationId])).digest('hex');

export async function preparePrivateExternalWorkspace(parent: string, principalId: string, coordinatorHostId: string, conversationId: string) {
  const target = path.join(parent, directoryName, privateKey(principalId, coordinatorHostId, conversationId));
  const check = async (allowMissing: boolean) => {
    if (normalizePathIdentity(await canonicalizePathIdentity(target, { allowMissing })) !== normalizePathIdentity(target))
      throw new SourceAdmissionError('source_changed');
  };
  await check(true);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await check(false);
  return target;
}

export function isPrivateExternalWorkspace(target: string, principalId: string, coordinatorHostId: string, conversationId: string) {
  const parent = path.dirname(path.dirname(target));
  const expected = path.join(parent, directoryName, privateKey(principalId, coordinatorHostId, conversationId));
  return normalizePathIdentity(expected) === normalizePathIdentity(target);
}

/** Deletion is idempotent and uses the same Storage owner as local private conversations. */
export async function removePrivateExternalWorkspace(kernel: KernelClient, workspaceId: string, directory: string, conversationId: string, signal?: AbortSignal) {
  const container = path.dirname(directory);
  const grant = await kernel.issueGrant({ grantId: `external-cleanup:${randomUUID()}`, owningWorkspace: workspaceId,
    executionWorkspace: workspaceId, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }, signal);
  try {
    const actor = kernel.scoped(grant);
    const root = await actor.fileRootRegister({ workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: container }, signal);
    await actor.fileRemove({ operationId: `external-directory-delete:${conversationId}`, workspaceId,
      rootId: String(root.rootId), path: path.basename(directory), recursive: true, force: true }, signal);
  } finally { await kernel.revokeGrant(grant.grantId); }
}
