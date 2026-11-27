import type { KernelClient } from './kernel-client.js';
import { createKernelProcessService } from './process-service.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

/** Program probes and conversions use their owner's private data roots. */
export function createPrivateProcessService(kernel: KernelClient, workspaceId: string, directory: string) {
  return createKernelProcessService({
    client: kernel,
    async resolveIdentity(cwd) {
      const canonicalRoot = await canonicalizePathIdentity(directory);
      const canonicalCwd = await canonicalizePathIdentity(cwd);
      if (!isPathWithinRoot(canonicalCwd, canonicalRoot)) throw new Error('Process directory is outside its private resource root');
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
    },
  });
}
