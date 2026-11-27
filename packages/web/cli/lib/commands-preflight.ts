import { runUpgradePreflight } from '#application-host/lib/deployment/upgrade-preflight.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getDataDir } from './cli-paths.js';

const usage = 'Usage: varin preflight --writers-stopped (uses VARIN_DATA_DIR)';

export async function preflightCommand(args: readonly string[], version: string) {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  if (args.length !== 1 || args[0] !== '--writers-stopped') throw new TunnelCliError(usage, EXIT_CODE.USAGE_ERROR);
  const report = await runUpgradePreflight(getDataDir(), version);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'blocked') process.exitCode = EXIT_CODE.GENERAL_ERROR;
}
