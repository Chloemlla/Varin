import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ExternalAgentError, type ExternalAgentConfiguration, type ExternalAgentProfile, type ExternalAgentSettings } from '@varin/application-client';
import type { createPlatformEnvironmentRuntime } from '../platform/environment-runtime.js';
import type { createKernelProcessService } from '../kernel/process-service.js';
import { connectHermesGateway } from './hermes-gateway.js';
import { findInstalledExternalExecutable } from './installed-executable.js';
import { assertProfilePlatform, profileVersionArguments } from './profile-launch.js';
import { ACP_DEFAULTS, getExternalAgentProfile } from './profiles.js';
import { text } from './transport.js';

const defaults: ExternalAgentConfiguration[] = [
  { id: 'codex', name: 'Codex', harness: 'codex', command: 'codex', args: [], enabled: false },
  { id: 'claude', name: 'Claude Code', harness: 'claude', command: 'claude', args: [], enabled: false },
  { id: 'pi', name: 'Pi', harness: 'pi', command: 'pi', args: [], enabled: false },
  ...ACP_DEFAULTS,
];

export function externalProgramConfigurations(agents: ExternalAgentConfiguration[]) {
  return [...agents, ...defaults.filter(profile => !agents.some(agent => agent.id === profile.id))
    .map(profile => ({ ...profile, availability: 'auto' as const, enabled: true }))];
}

export function validateExternalProgramSettings(value: Pick<ExternalAgentSettings, 'agents' | 'defaultAgent'>) {
  if (!value || !Array.isArray(value.agents))
    throw new ExternalAgentError('invalid_settings', 'External Agent settings must include a list of agents');
  for (const a of value.agents) {
    if (
      !a ||
      Object.keys(a).some(
        (key) => !['id', 'profileId', 'name', 'harness', 'enabled', 'availability', 'command', 'args', 'defaults'].includes(key),
      ) ||
      !text(a.id).trim() ||
      !text(a.name).trim() ||
      !text(a.command).trim() ||
      !['codex', 'claude', 'pi', 'acp'].includes(a.harness) ||
      (a.profileId !== undefined && (!getExternalAgentProfile(a.profileId) || getExternalAgentProfile(a.profileId)!.harness !== a.harness)) ||
      typeof a.enabled !== 'boolean' ||
      (a.availability !== undefined && !['auto', 'enabled', 'disabled'].includes(a.availability)) ||
      !Array.isArray(a.args) ||
      !a.args.every((v) => typeof v === 'string') ||
      (a.defaults !== undefined && (!a.defaults || typeof a.defaults !== 'object' || Array.isArray(a.defaults) ||
        Object.entries(a.defaults).some(([key, value]) => !['model', 'thinking', 'mode'].includes(key) || typeof value !== 'string' || !value.trim())))
    )
      throw new ExternalAgentError('invalid_settings', 'Invalid external Agent configuration');
  }
  if (new Set(value.agents.map(agent => agent.id)).size !== value.agents.length)
    throw new ExternalAgentError('invalid_settings', 'External Agent identities must be unique');
  if (value.defaultAgent !== null && !value.agents.some((v) => v.id === value.defaultAgent))
    throw new ExternalAgentError('invalid_default', 'The default Agent configuration is unavailable');
}

/** One program owner shared by the coordinator and a resource-only node. Session
 * history and capability caches belong to the coordinator's Catalog. */
export function createExternalPrograms(options: {
  directory: string;
  environment: ReturnType<typeof createPlatformEnvironmentRuntime>;
  spawn: ReturnType<typeof createKernelProcessService>['spawn'];
}) {
  const gateways = new Set<() => Promise<void>>();
  const probeDirectory = path.join(options.directory, 'probe');
  async function connectProgramGateway(configuration: ExternalAgentConfiguration, launch: { command: string; args: string[]; env: NodeJS.ProcessEnv }, signal?: AbortSignal) {
    if ((configuration.profileId ?? configuration.id) !== 'hermes' || launch.env.HERMES_TUI_GATEWAY_URL)
      return { env: launch.env, release: async () => {} };
    await mkdir(probeDirectory, { recursive: true });
    const bridge = await connectHermesGateway({ ...launch, spawn: options.spawn, cwd: probeDirectory, ...(signal ? { signal } : {}) });
    let closing: Promise<void> | undefined;
    const release = () => closing ??= bridge.close().finally(() => gateways.delete(release));
    gateways.add(release);
    return { env: bridge.env, release };
  }
  async function resolveExecutable(config: ExternalAgentConfiguration, env: NodeJS.ProcessEnv) {
    const profile = getExternalAgentProfile(config.profileId ?? config.id);
    assertProfilePlatform(profile, process.platform, process.arch);
    const executable = path.isAbsolute(config.command)
      ? config.command
      : options.environment.searchPathFor(config.command, env.PATH ?? env.Path) ?? await findInstalledExternalExecutable(config);
    if (!executable || !(await stat(executable).catch(() => null))?.isFile())
      throw new ExternalAgentError('program_missing', `Cannot find ${config.command} on this Host`);
    return executable;
  }
  async function discoverPrograms(agents: ExternalAgentConfiguration[], signal?: AbortSignal) {
    const candidates = agents.filter(agent => agent.enabled && agent.availability === 'auto');
    if (candidates.length === 0) return [];
    signal?.throwIfAborted();
    const env = options.environment.getLaunchEnvironment();
    const found = await Promise.all(candidates.map(async agent => {
      try {
        await resolveExecutable(agent, env);
        return agent.id;
      } catch (error) {
        if (error instanceof ExternalAgentError && ['program_missing', 'platform_unsupported'].includes(error.code)) return null;
        throw error;
      }
    }));
    signal?.throwIfAborted();
    return found.filter(id => id !== null);
  }
  async function executable(
    config: ExternalAgentConfiguration,
  ): Promise<{ executable: string; command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const env = options.environment.getLaunchEnvironment();
    const executable = await resolveExecutable(config, env);
    if (process.platform === 'win32' && /\.cmd$/i.test(executable)) {
      // npm shims invoke a JS entry point; run that entry directly without a shell quoting layer.
      const shim = await readFile(executable, 'utf8');
      const entry = /"(?:%dp0%[\\/]|%~dp0)([^"\r\n]+\.(?:c?js|mjs))"/i.exec(shim)?.[1];
      if (!entry) return { executable, command: executable, args: config.args, env };
      const bundledNode = path.join(path.dirname(executable), 'node.exe');
      const node = (await stat(bundledNode).catch(() => null))?.isFile() ? bundledNode
        : options.environment.searchPathFor('node', env.PATH ?? env.Path) ?? process.execPath;
      return {
        executable,
        command: node,
        args: [path.resolve(path.dirname(executable), entry), ...config.args],
        env: { ...env, ...(node === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      };
    }
    return { executable, command: executable, args: config.args, env };
  }
  async function probeVersion(launch: Awaited<ReturnType<typeof executable>>, signal?: AbortSignal, profile?: ExternalAgentProfile) {
    if (profile?.versionProbe === 'handshake') return undefined;
    const cwd = probeDirectory;
    await mkdir(cwd, { recursive: true });
    // This deadline bounds only a version query, never a model turn or native effect.
    const timeout = AbortSignal.timeout(15_000);
    const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const args = profileVersionArguments(launch.args, profile);
    const child = await options.spawn(launch.command, args, {
      cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'],
      signal: probeSignal, windowsHide: true,
    });
    const stdout: Buffer[] = [];
    // Native completion confirms capture and exit, not delivery of already
    // buffered Readable bytes to this consumer. Observe errors immediately, but
    // keep native completion first so output cannot mask unconfirmed ownership.
    const stdoutDrained = finished(child.stdout, { cleanup: true, writable: false, signal: probeSignal });
    void stdoutDrained.catch(() => {});
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    try {
      await child.completion;
      if (!child.exitConfirmed) throw new Error('Program version query exit is unconfirmed');
      await stdoutDrained;
      signal?.throwIfAborted();
      if (timeout.aborted) throw new ExternalAgentError('probe_timeout', 'Program version query did not finish');
      if (child.exitCode !== 0) throw new Error(`Program version check exited with ${child.exitCode}`);
      const version = Buffer.concat(stdout).toString('utf8').trim();
      if (!version) throw new Error('Program version query returned no version');
      return version;
    } catch (error) {
      if (!child.exitConfirmed) throw new AggregateError([error], 'Program version query failed and process exit is unconfirmed');
      signal?.throwIfAborted();
      if (timeout.aborted) throw new ExternalAgentError('probe_timeout', 'Program version query did not finish');
      throw error;
    } finally {
      if (child.exitConfirmed) await child.release();
    }
  }
  async function managedLaunch(config: ExternalAgentConfiguration, harness: ExternalAgentConfiguration['harness'], sessionId?: string, signal?: AbortSignal) {
    if (!config.enabled || config.harness !== harness) throw new ExternalAgentError('agent_disabled', 'The target Host configuration is disabled or changed');
    const launch = await executable(config);
    const version = await probeVersion(launch, signal, getExternalAgentProfile(config.profileId ?? config.id)).catch(error => {
      if (signal?.aborted || config.harness === 'pi' || error instanceof AggregateError) throw error;
      return undefined;
    });
    const command = harness === 'claude' ? process.execPath : launch.command;
    const args = harness === 'claude' ? [fileURLToPath(new URL('./claude-worker.js', import.meta.url))]
      : [...launch.args, ...(harness === 'codex' ? ['app-server'] : harness === 'pi' ? ['--mode','rpc',...(sessionId ? ['--session',sessionId] : [])] : [])];
    const env = {...launch.env,...(harness === 'claude' ? {ELECTRON_RUN_AS_NODE:'1'} : {})};
    const configurationIdentity = createHash('sha256').update(JSON.stringify([config,command,args,env,version])).digest('hex');
    const binding = {configurationIdentity,configuration:config,command:launch.command,args:launch.args,...(version ? {version} : {})};
    return { binding, command, args, env };
  }
  return { executable, discoverPrograms, probeVersion, managedLaunch, connectProgramGateway,
    close: async () => { await Promise.all([...gateways].map(close => close())); } };
}
