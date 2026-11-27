import path from 'node:path';
import type { DocumentAuthority } from '../documents/authority.js';
import type { DocumentRootGuard } from '../documents/allowed-roots.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { createPrivateProcessService } from '../kernel/private-process-service.js';
import type { createKernelProcessService } from '../kernel/process-service.js';
import { createManagedLanguageServers, type ManagedLanguageServersOptions } from './managed-servers.js';
import { createLanguageSupervisor } from './supervisor.js';

export function createHostLanguage(options: {
  kernel: KernelClient;
  dataDir: string;
  hostId: string;
  documents: DocumentAuthority;
  isTrusted: DocumentRootGuard;
  processes: ReturnType<typeof createKernelProcessService>;
  activateProviders?: NonNullable<Parameters<typeof createLanguageSupervisor>[0]['activateProviders']>;
  fetch?: NonNullable<ManagedLanguageServersOptions['fetch']>;
}): {
  tools: ReturnType<typeof createPrivateProcessService>;
  servers: ReturnType<typeof createManagedLanguageServers>;
  supervisor: ReturnType<typeof createLanguageSupervisor>;
} {
  const { kernel, dataDir, hostId, processes, documents, isTrusted, activateProviders, fetch } = options;
  // Install tools under a private resource root; execute them under the
  // original source grant. Neither setup nor registration starts a program.
  const tools = createPrivateProcessService(kernel, `language-tools:${hostId}`, path.join(dataDir, 'language-servers'));
  const servers = createManagedLanguageServers({ directory: dataDir, spawn: tools.spawn, ...(fetch && { fetch }) });
  const providers = new Map(servers.languageIds.map(languageId => [`varin.managed.${languageId}`, languageId]));
  const supervisor = createLanguageSupervisor({
    documents, isTrusted, ...(activateProviders && { activateProviders }),
    spawn: processes.spawn, spawnAdmitted: processes.spawnAdmitted,
    releaseAdmittedContext: processes.releaseContext,
    prepareProvider(providerId, root, signal) {
      const languageId = providers.get(providerId);
      return languageId ? servers.ensure(languageId, root, signal) : Promise.resolve(null);
    },
  });
  for (const [providerId, languageId] of providers) {
    supervisor.registerProvider({ providerId, command: providerId, languageIds: [languageId], source: 'builtin' });
  }
  return { tools, servers, supervisor };
}
