import path from 'node:path';
import { pairNodeRoleClient, revokeNodeRoleClient } from '#application-host/lib/node-role-auth.js';
import { getDataDir } from './cli-paths.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';

const usage = 'Usage: varin clients issue --profile full-control --output <file> | varin clients revoke <client-id>';

export async function clientsCommand(args: readonly string[]) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  const [action, ...options] = args;
  const dataDir = getDataDir();
  const kernelPath = process.env.VARIN_KERNEL_PATH?.trim() || undefined;
  if (action === 'revoke' && options.length === 1 && options[0] && !options[0].startsWith('-')) {
    await revokeNodeRoleClient(dataDir, kernelPath, options[0]);
    console.log('Client revoked.');
    return;
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index]!;
    const value = options[index + 1];
    if (!value || value.startsWith('--') || flags.has(name)) throw new TunnelCliError(usage, EXIT_CODE.USAGE_ERROR);
    flags.set(name, value);
  }
  const output = flags.get('--output');
  if (action !== 'issue' || flags.size !== 2 || flags.get('--profile') !== 'full-control' || !output) {
    throw new TunnelCliError(usage, EXIT_CODE.USAGE_ERROR);
  }
  const clientId = await pairNodeRoleClient(dataDir, kernelPath, path.resolve(output), { label: 'Deployment gateway', profile: 'full-control' });
  console.log('Issued client ' + clientId);
}
