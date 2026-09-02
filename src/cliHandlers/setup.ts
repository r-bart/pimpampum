import type { CliConnectorId } from '../cliProgram.js';
import {
  badArgument,
  callBoundary,
  connectorId,
  printBoundary,
  printSetupResult,
  required,
  requireConfirmation,
  setupProgressReporter,
  setupRuntime,
  type CliHandlerTable,
} from './support.js';

/** The guided setup the desktop app drives; every result crosses the redacting local boundary. */
export const setupHandlers: CliHandlerTable = {
  'setup plan': async ({ input, runtime }) => {
    const setup = setupRuntime(runtime);
    const selectedConnectors = input.optionAll('--connector').map(connectorId);
    printBoundary(runtime, await callBoundary(() => setup.plan({ selectedConnectors })));
  },
  'setup apply': async ({ command, input, runtime }) => {
    const setup = setupRuntime(runtime);
    const events = input.boolean('--events');
    requireConfirmation(command, input);
    const replacements = input.optionAll('--replace').map(connectorId);
    const keeps = input.optionAll('--keep').map(connectorId);
    if (keeps.length > 0 && !events) {
      throw badArgument(command, 'Keep decisions are reserved for native setup event mode');
    }
    if (keeps.some((id) => replacements.includes(id))) {
      throw badArgument(
        command,
        'A connector cannot be both kept and replaced in one setup decision',
      );
    }
    const conflictDecisions = Object.fromEntries([
      ...replacements.map((id) => [id, 'replace' as const] as const),
      ...keeps.map((id) => [id, 'keep' as const] as const),
    ]) as Partial<Record<CliConnectorId, 'replace' | 'keep'>>;
    const onProgress = setupProgressReporter(runtime, events);
    const result = await callBoundary(() =>
      setup.apply({
        operationId: required(input.positional[0], 'operation id'),
        expectedRevision: required(input.positional[1], 'expected revision'),
        confirmed: true,
        ...(replacements.length === 0 && keeps.length === 0 ? {} : { conflictDecisions }),
        ...(onProgress === undefined ? {} : { onProgress }),
      }),
    );
    printSetupResult(runtime, events, result);
  },
  'setup retry': async ({ command, input, runtime }) => {
    const setup = setupRuntime(runtime);
    if (!input.boolean('--events')) throw badArgument(command, 'setup retry requires --events');
    const id = connectorId(input.positional[0]);
    const result = await callBoundary(() =>
      setup.retryConnector(id, setupProgressReporter(runtime, true)),
    );
    printSetupResult(runtime, true, result);
  },
  'setup status': async ({ runtime }) => {
    const setup = setupRuntime(runtime);
    printBoundary(runtime, await callBoundary(() => setup.status()));
  },
  'setup resume': async ({ input, runtime }) => {
    const setup = setupRuntime(runtime);
    const events = input.boolean('--events');
    const onProgress = setupProgressReporter(runtime, events);
    const result = await callBoundary(() =>
      setup.resume(onProgress === undefined ? undefined : { onProgress }),
    );
    printSetupResult(runtime, events, result);
  },
};
