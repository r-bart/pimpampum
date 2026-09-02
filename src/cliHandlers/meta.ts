import { describeCommands } from '../cliCommands.js';
import { CLI_USAGE } from '../cliInput.js';
import { PIMPAMPUM_VERSION } from '../version.js';
import { print, type CliHandlerTable } from './support.js';

/**
 * The commands that describe the CLI itself. `help` is the one command that prints text rather
 * than an envelope, because it is the human affordance; `commands` returns the same catalog as
 * JSON for everything else.
 */
export const metaHandlers: CliHandlerTable = {
  help: async ({ runtime }) => {
    runtime.stdout(CLI_USAGE);
  },
  version: async ({ runtime }) => {
    print(runtime, { name: 'pimpampum', version: PIMPAMPUM_VERSION });
  },
  commands: async ({ runtime }) => {
    print(runtime, describeCommands(PIMPAMPUM_VERSION));
  },
  config: async ({ runtime }) => {
    print(runtime, runtime.describeConfig());
  },
};
