import { startContainerResourceProvider } from '#application-host/lib/deployment/container-provider.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';

export async function providerCommand(args: readonly string[]) {
  const usage = 'Usage: varin resource-provider --config <absolute-path>';
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new TunnelCliError(usage, EXIT_CODE.USAGE_ERROR);
  const provider = await startContainerResourceProvider(args[1]);
  console.log('Varin resource provider ready');
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void provider.close().then(resolve, reject);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
