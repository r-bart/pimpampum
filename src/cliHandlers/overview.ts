import { print, type CliHandlerTable } from './support.js';

/** The daemon's own health and the portfolio overview. */
export const overviewHandlers: CliHandlerTable = {
  health: async ({ runtime }) => {
    print(runtime, await runtime.createClient().health());
  },
  overview: async ({ runtime }) => {
    print(runtime, await runtime.createClient().getOverview());
  },
};
