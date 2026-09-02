import { print, required, type CliHandlerTable } from './support.js';

/** One-shot backups, the automatic backup the daemon schedules, and the portable export. */
export const backupHandlers: CliHandlerTable = {
  backup: async ({ input, runtime }) => {
    print(
      runtime,
      await runtime
        .createClient()
        .backup(runtime.resolvePath(required(input.positional[0], 'backup directory'))),
    );
  },
  'backup status': async ({ runtime }) => {
    print(runtime, await runtime.createClient().getAutomaticBackupStatus());
  },
  'backup configure': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime
        .createClient()
        .configureAutomaticBackup(
          runtime.resolvePath(required(input.positional[0], 'backup directory')),
        ),
    );
  },
  // A retry that ends in `state: 'error'` is a successful report of a failed backup: the data
  // carries `error`, and the caller decides. Exit 1 would hide that data.
  'backup retry': async ({ runtime }) => {
    print(runtime, await runtime.createClient().retryAutomaticBackup());
  },
  'backup disable': async ({ runtime }) => {
    print(runtime, await runtime.createClient().disableAutomaticBackup());
  },
  export: async ({ input, runtime }) => {
    print(
      runtime,
      await runtime
        .createClient()
        .exportPortable(runtime.resolvePath(required(input.positional[0], 'export directory'))),
    );
  },
};
