import { randomUUID } from 'node:crypto';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { createManagedMcpProcesses } from '../kernel/managed-mcp-processes.js';
import type { McpAuthority, McpCompositions } from '../mcp/authority.js';
import { createManagedMcpService } from './managed-mcp-service.js';

/** Both Host roles use the target kernel for admission, process I/O and retirement. */
export function createManagedMcpTarget(options: {
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'>;
  authority: McpAuthority;
  compositions: McpCompositions;
  agentDir: string;
  hostId: string;
  projectTrusted(cwd: string): boolean;
  onError(error: Error): void;
}) {
  const { kernel, documents, ...settings } = options;
  const service = createManagedMcpService({ ...settings, kernel,
    async admitSource(scope, signal) {
      await kernel.sourceRequest('source.service.call', { principalId: scope.principal.principalId,
        coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch,
        requestId: `mcp-validate:${randomUUID()}`, clientCapabilities: [...scope.principal.capabilities], operation: { kind: 'validate' } }, signal);
    },
    transportOwner: (scope, readmit) => createManagedMcpProcesses({ kernel, scope, readmit, onError: settings.onError }),
    admitWorkspaceRegistration: (id, signal) => documents.admitWorkspaceRegistration(id, signal),
  });
  return {
    ...service,
    continuations: {
      releaseMcpView: service.releaseView,
      mcpTaskContinuation: service.taskContinuation,
      mcpResourceContinuation: service.resourceContinuation,
      mcpInteractionContinuation: service.interactionContinuation,
      mcpDerivationContinuation: service.derivationContinuation,
      mcpChildContinuation: service.childContinuation,
    },
  };
}
