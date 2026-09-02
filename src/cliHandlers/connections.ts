import {
  badArgument,
  callBoundary,
  connectionsRuntime,
  connectorId,
  printBoundary,
  replacementOf,
  requireConfirmation,
  type CliHandlerTable,
} from './support.js';

/** Agent host connections: the local boundary redacts every result before it is printed. */
export const connectionsHandlers: CliHandlerTable = {
  connections: async ({ runtime }) => {
    printBoundary(runtime, await callBoundary(() => connectionsRuntime(runtime).list()));
  },
  connect: async ({ command, input, runtime }) => {
    const connections = connectionsRuntime(runtime);
    if (input.boolean('--instructions')) {
      if (input.positional.length > 0 || input.boolean('--yes') || input.boolean('--replace')) {
        throw badArgument(
          command,
          '--instructions cannot be combined with a connector or mutation flags',
        );
      }
      printBoundary(runtime, await callBoundary(() => connections.instructions()));
      return;
    }
    requireConfirmation(command, input);
    const id = connectorId(input.positional[0]);
    printBoundary(runtime, await callBoundary(() => connections.connect(id, replacementOf(input))));
  },
  repair: async ({ command, input, runtime }) => {
    requireConfirmation(command, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() => connectionsRuntime(runtime).repair(id, replacementOf(input))),
    );
  },
  disconnect: async ({ command, input, runtime }) => {
    requireConfirmation(command, input);
    const id = connectorId(input.positional[0]);
    printBoundary(
      runtime,
      await callBoundary(() => connectionsRuntime(runtime).disconnect(id, { confirmed: true })),
    );
  },
};
