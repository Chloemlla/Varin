import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExternalAgentError, type ExternalAgentSettings, type ExternalAgentDetection, type ExternalExecutorInspection } from '@varin/application-client';
import { createExternalPrograms, externalProgramConfigurations, validateExternalProgramSettings } from './programs.js';
import { EXTERNAL_AGENT_PROFILES, getExternalAgentProfile } from './profiles.js';

type Config = Pick<ExternalAgentSettings, 'agents' | 'defaultAgent'>;

/** The node owns programs and accounts. The coordinating Host owns conversations,
 * queued inputs and capability observations made through those conversations. */
export function createResourceExternalOwner(dataDir: string, programs: ReturnType<typeof createExternalPrograms>) {
  const detections = new Map<string, ExternalAgentDetection>();
  let configuration: Promise<Config> | undefined;
  const read = () => configuration ??= (async () => {
    const raw = await readFile(path.join(dataDir, 'external-agents.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const value = raw === undefined ? { agents: [], defaultAgent: null } : JSON.parse(raw) as Config;
    validateExternalProgramSettings(value);
    return { ...value, agents: externalProgramConfigurations(value.agents) };
  })();
  const configurationFor = async (id: string) => {
    const value = (await read()).agents.find(agent => agent.id === id);
    if (!value) throw new ExternalAgentError('agent_missing', 'External Agent configuration is unavailable on this Resource Node');
    return value;
  };
  const detect = async (id: string, signal?: AbortSignal): Promise<ExternalAgentDetection> => {
    const agent = await configurationFor(id);
    let result: ExternalAgentDetection;
    try {
      signal?.throwIfAborted();
      const launch = await programs.executable(agent);
      const version = await programs.probeVersion(launch, signal, getExternalAgentProfile(agent.profileId ?? agent.id));
      signal?.throwIfAborted();
      result = { id, status: 'available', executable: launch.executable, ...(version ? { version } : {}), checkedAt: Date.now() };
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof ExternalAgentError ? error.code : 'detection_failed';
      result = { id, status: code === 'program_missing' ? 'missing' : 'failed', code,
        message: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
    }
    detections.set(id, result);
    return result;
  };
  return {
    async externalSettings(signal?: AbortSignal, discover = false): Promise<ExternalAgentSettings> {
      const value = await read();
      signal?.throwIfAborted();
      return { ...value, revision: 0, profiles: [...EXTERNAL_AGENT_PROFILES], host: { platform: process.platform, architecture: process.arch },
        ...(detections.size ? { detections: [...detections.values()] } : {}),
        ...(discover ? { discoveredAgentIds: await programs.discoverPrograms(value.agents, signal) } : {}) };
    },
    externalDetect: detect,
    async externalInspect(id: string, refresh: boolean, signal?: AbortSignal): Promise<ExternalExecutorInspection> {
      const agent = await configurationFor(id);
      const fact = refresh || agent.enabled && !detections.has(id) ? await detect(id, signal) : detections.get(id);
      return { configurationId: id, name: agent.name, harness: agent.harness,
        availability: agent.availability ?? (agent.enabled ? 'enabled' : 'disabled'), defaults: agent.defaults ?? {},
        installation: fact ? { status: fact.status === 'available' ? 'installed' : fact.status,
          ...(fact.version !== undefined ? { version: fact.version } : {}), ...(fact.checkedAt !== undefined ? { checkedAt: fact.checkedAt } : {}),
          ...(fact.message !== undefined ? { message: fact.message } : {}) } : { status: 'unknown' },
        connection: 'not_connected', authentication: 'unknown', capabilitySource: 'unknown' };
    },
    async externalLaunch(id: string, harness: import('@varin/application-client').ExternalHarness, sessionId?: string, signal?: AbortSignal) {
      return programs.managedLaunch(await configurationFor(id), harness, sessionId, signal);
    },
    externalGateway: programs.connectProgramGateway,
  };
}
