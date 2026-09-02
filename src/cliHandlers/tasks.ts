import {
  actorOf,
  exclusive,
  print,
  readBodyFile,
  required,
  revision,
  type CliHandlerTable,
} from './support.js';

export const tasksHandlers: CliHandlerTable = {
  'task:create': async ({ command, input, runtime }) => {
    const bodyFile = input.option('--body-file');
    print(
      runtime,
      await runtime.createClient().createTask({
        specId: required(input.positional[0], 'spec id'),
        title: required(input.positional[1], 'task title'),
        parentId: exclusive(command, input, '--parent', 2, 'parent-id') ?? null,
        body: bodyFile ? readBodyFile(runtime, bodyFile) : null,
        actor: actorOf(input),
      }),
    );
  },
  'task:get': async ({ input, runtime }) => {
    print(runtime, await runtime.createClient().getTask(required(input.positional[0], 'task id')));
  },
  'task:cancel': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().cancelTask({
        taskId: required(input.positional[0], 'task id'),
        expectedRevision: revision(input.positional[1]),
        reason: required(input.positional[2], 'reason'),
        actor: actorOf(input),
      }),
    );
  },
};
