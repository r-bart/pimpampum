import {
  actorOf,
  exclusive,
  print,
  readBodyFile,
  required,
  revision,
  type CliHandler,
  type CliHandlerTable,
} from './support.js';

/** `spec:draft` and `spec:ready` are one state change with two names. */
function specState(state: 'draft' | 'ready'): CliHandler {
  return async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().updateSpec({
        specId: required(input.positional[0], 'spec id'),
        title: null,
        body: null,
        state,
        expectedRevision: revision(input.positional[1]),
        actor: actorOf(input),
      }),
    );
  };
}

export const specsHandlers: CliHandlerTable = {
  'spec:create': async ({ command, input, runtime }) => {
    const bodyFile = exclusive(command, input, '--body-file', 3, 'body-file');
    print(
      runtime,
      await runtime.createClient().createSpec({
        projectId: required(input.positional[0], 'project id'),
        slug: required(input.positional[1], 'spec slug'),
        title: required(input.positional[2], 'spec title'),
        body: bodyFile ? readBodyFile(runtime, bodyFile) : '',
        actor: actorOf(input),
      }),
    );
  },
  'spec:get': async ({ input, runtime }) => {
    print(runtime, await runtime.createClient().getSpec(required(input.positional[0], 'spec id')));
  },
  'spec:draft': specState('draft'),
  'spec:ready': specState('ready'),
  'spec:cancel': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().cancelSpec({
        specId: required(input.positional[0], 'spec id'),
        expectedRevision: revision(input.positional[1]),
        reason: required(input.positional[2], 'reason'),
        actor: actorOf(input),
      }),
    );
  },
};
