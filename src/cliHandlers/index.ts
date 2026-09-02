/**
 * The dispatch table. Every entry of `CLI_COMMANDS` has exactly one handler here, grouped by the
 * resource it acts on; `test/cli-handlers.test.ts` holds the two tables to each other.
 */
import type { CliCommand } from '../cliCommands.js';
import { AppError } from '../errors.js';
import { backupHandlers } from './backup.js';
import { connectionsHandlers } from './connections.js';
import { metaHandlers } from './meta.js';
import { overviewHandlers } from './overview.js';
import { projectsHandlers } from './projects.js';
import { serviceHandlers } from './service.js';
import { setupHandlers } from './setup.js';
import { specsHandlers } from './specs.js';
import type { CliHandler } from './support.js';
import { syncHandlers } from './sync.js';
import { tasksHandlers } from './tasks.js';
import { toolsHandlers } from './tools.js';
import { workHandlers } from './work.js';
import { workspacesHandlers } from './workspaces.js';

export type { CliHandler, CliHandlerContext, CliHandlerTable } from './support.js';

export const CLI_HANDLERS: ReadonlyMap<string, CliHandler> = new Map(
  Object.entries({
    ...metaHandlers,
    ...serviceHandlers,
    ...setupHandlers,
    ...connectionsHandlers,
    ...toolsHandlers,
    ...overviewHandlers,
    ...workspacesHandlers,
    ...workHandlers,
    ...projectsHandlers,
    ...specsHandlers,
    ...tasksHandlers,
    ...backupHandlers,
    ...syncHandlers,
  }),
);

/** A catalog entry without a handler is the program's mistake, never the caller's. */
export function handlerFor(command: CliCommand): CliHandler {
  const handler = CLI_HANDLERS.get(command.name);
  if (handler === undefined) {
    throw new AppError('internal_error', `Unhandled CLI command: ${command.name}`, 500);
  }
  return handler;
}
