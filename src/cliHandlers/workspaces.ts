import { print, required, type CliHandlerTable } from './support.js';

export const workspacesHandlers: CliHandlerTable = {
  'workspace:list': async ({ runtime }) => {
    print(runtime, await runtime.createClient().listWorkspaces());
  },
  'workspace:add': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().registerWorkspace({
        id: required(input.positional[0], 'workspace id'),
        name: required(input.positional[1], 'workspace name'),
        rootPath: runtime.resolvePath(required(input.positional[2], 'workspace root path')),
      }),
    );
  },
};
