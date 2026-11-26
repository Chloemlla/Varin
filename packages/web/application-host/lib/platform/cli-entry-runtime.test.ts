import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import type { StartWebUiServerOptions } from '../../public-contract.js';
import { runCliEntryIfMain } from './cli-entry-runtime.js';
import { parseServeCliOptions } from './cli-options.js';

function fixture(connected = true) {
  const events = new EventEmitter();
  const exit = vi.fn() as unknown as NodeJS.Process['exit'];
  const process = Object.assign(events, {
    argv: ['node', '/also/server/index.js'], connected, exit,
    env: { VARIN_LOCAL_SUPERVISOR: '1', VARIN_LOCAL_SUPERVISOR_LAUNCH_ID: 'abdc0000-0000-0001-0001-000000000001' },
    send: vi.fn(() => true) as NodeJS.Process['send'],
  });
  const stop = vi.fn(async (_options: { exitProcess: boolean }) => undefined);
  let didStart!: (value: unknown) => void;
  let scope!: StartWebUiServerOptions;
  const ready = new Promise(resolve => { didStart = resolve; });
  runCliEntryIfMain({
    startServer(options) { scope = options; return ready; }, process, setExitOnShutdown: vi.fn(),
    currentFilename: process.argv[1]!, defaultPort: 3000, cloudflareProvider: 'cloudflare',
    managedLocalMode: 'managed-local', parseServeCliOptions,
  });
  return { stop, exit, events, activate: async () => { didStart({ stop }); await ready; }, scope };
}

test('a supervised restart drains the original Host and relinquishes relaunch to the parent process', async () => {
  const f = fixture();
  await f.activate();
  await f.scope.restartApplicationHost?.();
  expect(f.stop).toHaveBeenCalledExactlyOnceWith({ exitProcess: false });
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
});

test('the original Host drains if private supervisor IPC closes before startup returns', async () => {
  const f = fixture();
  f.events.emit('disconnect');
  expect(f.stop).not.toHaveBeenCalled();
  await f.activate();
  expect(f.stop).toHaveBeenCalledExactlyOnceWith({ exitProcess: true });
  expect(f.exit).not.toHaveBeenCalled();
});

test('an IPC disconnect already observed at entry still drains when startup returns', async () => {
  const f = fixture(false);
  await f.activate();
  expect(f.stop).toHaveBeenCalledExactlyOnceWith({ exitProcess: true });
});
