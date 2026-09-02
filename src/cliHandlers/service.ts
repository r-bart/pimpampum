import { print, type CliHandlerTable } from './support.js';

/** The daemon process, the stdio bridge and the service lifecycle around them. */
export const serviceHandlers: CliHandlerTable = {
  // stdout carries the MCP protocol for this command, so it writes no envelope. The bridge owns
  // its own shutdown signals and keeps the process alive until the host closes the transport.
  mcp: async ({ runtime }) => {
    await runtime.startStdioBridge();
  },
  serve: async ({ runtime }) => {
    const running = await runtime.startServer();
    print(runtime, { listening: true, baseUrl: running.config.baseUrl });
    const shutdown = async () => {
      await running.close();
      runtime.exit(0);
    };
    runtime.onSignal('SIGINT', () => void shutdown());
    runtime.onSignal('SIGTERM', () => void shutdown());
  },
  install: async ({ input, runtime }) => {
    const manager = input.boolean('--service-only')
      ? (runtime.serviceOnlyManager ?? runtime.serviceManager)
      : runtime.serviceManager;
    print(runtime, await manager.install());
  },
  status: async ({ runtime }) => {
    print(runtime, await runtime.serviceManager.status());
  },
  'update:check': async ({ runtime }) => {
    print(runtime, await runtime.updateManager.check());
  },
  update: async ({ runtime }) => {
    print(runtime, await runtime.updateManager.update());
  },
  uninstall: async ({ runtime }) => {
    print(runtime, await runtime.serviceManager.uninstall());
  },
};
