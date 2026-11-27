import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('publishes the listening port before attaching process handlers', async () => {
    const order: string[] = [];
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: () => ({
        attachTerminalSession: () => null,
        createTerminalSession: async () => { throw new Error('not used'); },
        inspectSession: () => null,
        subscribeCommands: () => ({ dispose: () => undefined }),
        activity: () => ({ sessions: 0, preparing: 0, stopping: 0 }),
        beginDraining: () => {},
        shutdown: async () => {},
      }),
      createDictationRuntime: () => ({ stop: async () => {}, activity: () => ({ state: 'cold', pendingRequests: 0, sessions: 0, warm: false }) }),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: () => { order.push('handlers'); },
      }),
    });

    const options = {
      app: {},
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port: number) => order.push(`port:${port}`),
      },
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    } as unknown as Parameters<typeof runtime.run>[0];
    await runtime.run(options);

    expect(order).toEqual(['listen', 'port:3901', 'handlers']);
  });
});
