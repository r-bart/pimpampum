import { badArgument, print, required, type CliHandlerTable } from './support.js';

export const syncHandlers: CliHandlerTable = {
  'sync status': async ({ runtime }) => {
    print(runtime, await runtime.createClient().getSyncStatus());
  },
  'sync configure': async ({ command, input, runtime }) => {
    const directory = runtime.resolvePath(required(input.positional[0], 'shared folder'));
    const deviceId = input.option('--device');
    if (deviceId === undefined) {
      throw badArgument(command, 'sync configure requires --device <id>');
    }
    print(runtime, await runtime.createClient().configureSync(directory, deviceId));
  },
  'sync resolve': async ({ command, input, runtime }) => {
    const conflictId = required(input.positional[0], 'conflict id');
    const choice = required(input.positional[1], 'conflict choice');
    if (choice !== 'local' && choice !== 'remote') {
      throw badArgument(command, 'Conflict choice must be local or remote');
    }
    print(runtime, await runtime.createClient().resolveSyncConflict(conflictId, choice));
  },
  'sync now': async ({ runtime }) => {
    print(runtime, await runtime.createClient().reconcileSync());
  },
  'sync pause': async ({ runtime }) => {
    print(runtime, await runtime.createClient().pauseSync());
  },
  'sync resume': async ({ runtime }) => {
    print(runtime, await runtime.createClient().resumeSync());
  },
  'sync conflicts': async ({ runtime }) => {
    print(runtime, await runtime.createClient().listSyncConflicts());
  },
  'sync forget': async ({ runtime }) => {
    print(runtime, await runtime.createClient().forgetSync());
  },
};
