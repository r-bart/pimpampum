import type { TargetType } from '../types.js';
import {
  artifactsOf,
  exclusive,
  optionalCount,
  print,
  required,
  revision,
  targetType,
  type CliHandlerContext,
  type CliHandlerTable,
} from './support.js';

function claimOf({ input }: CliHandlerContext): {
  targetType: TargetType;
  targetId: string;
  agentId: string;
  leaseSeconds: number;
} {
  return {
    targetType: targetType(input.positional[0]),
    targetId: required(input.positional[1], 'target id'),
    agentId: required(input.positional[2], 'agent id'),
    leaseSeconds: optionalCount(input, '--lease-seconds', 'Lease seconds') ?? 1_800,
  };
}

/** Claims: the lease an agent holds on a spec or a task, and the completion that ends it. */
export const workHandlers: CliHandlerTable = {
  'work:list': async ({ input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().listWork({
        workspaceId: input.positional[0] ?? null,
        projectId: input.positional[1] ?? null,
        specId: input.positional[2] ?? null,
        limit: optionalCount(input, '--limit', 'Limit') ?? 50,
      }),
    );
  },
  'work:start': async (context) => {
    print(context.runtime, await context.runtime.createClient().startWork(claimOf(context)));
  },
  'work:renew': async (context) => {
    print(context.runtime, await context.runtime.createClient().renewWork(claimOf(context)));
  },
  'work:release': async ({ command, input, runtime }) => {
    await runtime.createClient().releaseWork({
      targetType: targetType(input.positional[0]),
      targetId: required(input.positional[1], 'target id'),
      agentId: required(input.positional[2], 'agent id'),
      note: exclusive(command, input, '--note', 3, 'note') ?? null,
    });
    print(runtime, { released: true });
  },
  'work:complete': async ({ command, input, runtime }) => {
    print(
      runtime,
      await runtime.createClient().completeWork({
        targetType: targetType(input.positional[0]),
        targetId: required(input.positional[1], 'target id'),
        agentId: required(input.positional[2], 'agent id'),
        expectedRevision: revision(input.positional[3]),
        summary: required(input.positional[4], 'summary'),
        artifacts: artifactsOf(command, input),
      }),
    );
  },
};
