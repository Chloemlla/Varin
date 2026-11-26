import { createProcessRestart } from './process-restart.js';
import { SUPERVISOR_LAUNCH, validSupervisorLaunch } from '../lifecycle/supervisor-runner.js';
import type {
  ParsedServeCliArgs,
  ParseServeCliOptionsInput,
  StartWebUiServerOptions,
  WebUiServerController,
} from '../../public-contract.js';

export interface CliEntryDependencies {
  cloudflareProvider: string;
  currentFilename: string;
  defaultPort: number;
  managedLocalMode: string;
  parseServeCliOptions(input: ParseServeCliOptionsInput): ParsedServeCliArgs;
  process: Pick<NodeJS.Process, 'argv' | 'env' | 'exit'> & {
    connected?: boolean;
    send?: NodeJS.Process['send'];
    once?(event: 'disconnect', listener: () => void): unknown;
  };
  setExitOnShutdown(value: boolean): void;
  startServer(options: StartWebUiServerOptions): Promise<unknown>;
}

export const runCliEntryIfMain = (dependencies: CliEntryDependencies): void => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  let controller: WebUiServerController | undefined;
  // Only the inherited Node IPC channel is supervisor authority. Ordinary
  // foreground and daemon starts retain their existing restart behavior.
  const supervised = process.env.VARIN_LOCAL_SUPERVISOR === '1' &&
    validSupervisorLaunch(process.env[SUPERVISOR_LAUNCH]) && typeof process.send === 'function';
  let supervisorLost = false;
  const stopIfOrphaned = () => {
    supervisorLost = true;
    void controller?.stop({ exitProcess: true }).catch(() => process.exit(1));
  };
  if (supervised) {
    process.once?.('disconnect', stopIfOrphaned);
    if (!process.connected) stopIfOrphaned();
  }
  const stopForRestart = async () => {
    if (!controller) throw new Error('Application Host is still starting');
    await controller.stop({ exitProcess: false });
  };
  const restartApplicationHost = supervised
    ? async () => { await stopForRestart(); process.exit(0); }
    : createProcessRestart({ stop: stopForRestart, exit: code => process.exit(code) });
  startServer({
    restartApplicationHost,
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).then(value => { controller = value as WebUiServerController; if (supervisorLost) stopIfOrphaned(); }).catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
