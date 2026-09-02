import {
  actorOf,
  artifactsOf,
  print,
  required,
  revision,
  type CliHandler,
  type CliHandlerTable,
} from './support.js';

/** `project:draft`, `project:open` and `project:pause` are one state change with three names. */
function projectState(state: 'draft' | 'open' | 'paused'): CliHandler {
  return async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().updateProject({
        projectId: required(input.positional[0], 'project id'),
        title: null,
        state,
        expectedRevision: revision(input.positional[1]),
        actor: actorOf(input),
      }),
    );
  };
}

export const projectsHandlers: CliHandlerTable = {
  'project:create': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().createProject({
        workspaceId: required(input.positional[0], 'workspace id'),
        slug: required(input.positional[1], 'project slug'),
        title: required(input.positional[2], 'project title'),
        actor: actorOf(input),
      }),
    );
  },
  'project:get': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().getProject(required(input.positional[0], 'project id')),
    );
  },
  'project:draft': projectState('draft'),
  'project:open': projectState('open'),
  'project:pause': projectState('paused'),
  'project:complete': async ({ command, input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().completeProject({
        projectId: required(input.positional[0], 'project id'),
        expectedRevision: revision(input.positional[1]),
        summary: required(input.positional[2], 'summary'),
        artifacts: artifactsOf(command, input),
        actor: actorOf(input),
      }),
    );
  },
  'project:cancel': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().cancelProject({
        projectId: required(input.positional[0], 'project id'),
        expectedRevision: revision(input.positional[1]),
        reason: required(input.positional[2], 'reason'),
        actor: actorOf(input),
      }),
    );
  },
};
