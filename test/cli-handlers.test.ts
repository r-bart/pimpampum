import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, type CliCommand } from '../src/cliCommands.js';
import { backupHandlers } from '../src/cliHandlers/backup.js';
import { connectionsHandlers } from '../src/cliHandlers/connections.js';
import { CLI_HANDLERS, handlerFor } from '../src/cliHandlers/index.js';
import { metaHandlers } from '../src/cliHandlers/meta.js';
import { overviewHandlers } from '../src/cliHandlers/overview.js';
import { projectsHandlers } from '../src/cliHandlers/projects.js';
import { serviceHandlers } from '../src/cliHandlers/service.js';
import { setupHandlers } from '../src/cliHandlers/setup.js';
import { specsHandlers } from '../src/cliHandlers/specs.js';
import { syncHandlers } from '../src/cliHandlers/sync.js';
import { tasksHandlers } from '../src/cliHandlers/tasks.js';
import { toolsHandlers } from '../src/cliHandlers/tools.js';
import { workHandlers } from '../src/cliHandlers/work.js';
import { workspacesHandlers } from '../src/cliHandlers/workspaces.js';

const HANDLER_MODULES = [
  metaHandlers,
  serviceHandlers,
  setupHandlers,
  connectionsHandlers,
  toolsHandlers,
  overviewHandlers,
  workspacesHandlers,
  workHandlers,
  projectsHandlers,
  specsHandlers,
  tasksHandlers,
  backupHandlers,
  syncHandlers,
];

describe('CLI handler table', () => {
  it('gives every catalog entry exactly one handler', () => {
    const declared = CLI_COMMANDS.map((command) => command.name);
    expect(new Set(declared).size).toBe(declared.length);
    const unhandled = declared.filter((name) => !CLI_HANDLERS.has(name));
    expect(unhandled).toEqual([]);
    // The table is a spread of the module tables: a verb declared twice would silently keep the
    // last handler, so the module sizes must add up to the merged size.
    const declaredByModules = HANDLER_MODULES.reduce(
      (total, table) => total + Object.keys(table).length,
      0,
    );
    expect(declaredByModules).toBe(CLI_HANDLERS.size);
  });

  it('names a catalog entry for every handler', () => {
    const declared = new Set(CLI_COMMANDS.map((command) => command.name));
    const orphans = [...CLI_HANDLERS.keys()].filter((name) => !declared.has(name));
    expect(orphans).toEqual([]);
  });

  it('resolves a declared command to its handler', () => {
    for (const command of CLI_COMMANDS) {
      expect(handlerFor(command)).toBe(CLI_HANDLERS.get(command.name));
    }
  });

  it('fails as internal_error for a command the table does not handle', () => {
    const fabricated: CliCommand = { ...CLI_COMMANDS[0]!, name: 'fabricated:verb' };
    expect(() => handlerFor(fabricated)).toThrowError(
      expect.objectContaining({
        code: 'internal_error',
        status: 500,
        message: 'Unhandled CLI command: fabricated:verb',
      }),
    );
  });
});
