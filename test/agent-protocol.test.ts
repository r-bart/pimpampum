import { describe, expect, it } from 'vitest';
import {
  createAgentErrorEnvelope,
  createAgentSuccessEnvelope,
  createLocalErrorEnvelope,
  extractAgentEnvelope,
} from '../src/agentProtocol.js';
import { AppError, type ErrorCode } from '../src/errors.js';

describe('agent protocol', () => {
  it('builds success envelopes without changing their data', () => {
    const data = { nested: ['value'] };
    expect(createAgentSuccessEnvelope(data)).toEqual({ data });
  });

  it.each<[ErrorCode, string]>([
    ['bad_request', 'Correct the arguments using this tool input schema, then retry.'],
    ['conflict', 'Inspect the current Claim and resource manifest before retrying.'],
    [
      'invalid_state',
      'Inspect the Project, Spec, Task hierarchy and ancestor lifecycle states before retrying.',
    ],
    ['not_found', 'Verify the resource ID or resolve the current workspace again.'],
    ['revision_conflict', 'Read the latest manifest, then retry with its current revision.'],
    ['unauthorized', 'Verify the daemon bearer token used by the MCP transport or stdio bridge.'],
    [
      'payload_too_large',
      'Inspect the daemon logs and retry only if the underlying failure is transient.',
    ],
    [
      'internal_error',
      'Inspect the daemon logs and retry only if the underlying failure is transient.',
    ],
  ])('builds an actionable %s error envelope', (code, suggestion) => {
    expect(
      createAgentErrorEnvelope(
        new AppError(code, 'Operation failed', 400, true, { resourceId: 'resource-id' }),
      ),
    ).toEqual({
      error: {
        code,
        message: 'Operation failed',
        retryable: true,
        details: { resourceId: 'resource-id' },
        suggestion,
      },
    });
  });

  // The guidance for a code is written for its usual cause. When a specific failure has a different
  // remedy, saying the usual one out loud sends the reader somewhere useless.
  it('prefers a failure’s own suggestion over the guidance for its code', () => {
    expect(
      createAgentErrorEnvelope(
        new AppError('unavailable', 'Dependency missing', 503, false, {}, 'Install it first.'),
      ).error.suggestion,
    ).toBe('Install it first.');
    expect(
      createAgentErrorEnvelope(new AppError('unavailable', 'Daemon down', 503, false, {})).error
        .suggestion,
    ).toBe(
      'The local daemon did not answer. Run `pimpampum status`; if it is not installed or not running, run `pimpampum install`, then retry.',
    );
  });

  it('normalizes unknown failures before building their envelope', () => {
    expect(createAgentErrorEnvelope('failure')).toEqual({
      error: {
        code: 'internal_error',
        message: 'An internal error occurred',
        retryable: false,
        details: {},
        suggestion:
          'Inspect the daemon logs and retry only if the underlying failure is transient.',
      },
    });
  });

  it('keeps the real message and cause chain in the local CLI envelope', () => {
    const root = new Error('launchctl bootstrap failed with exit code 5: Input/output error');
    const error = new Error('Unable to activate the LaunchAgent', { cause: root });
    expect(createLocalErrorEnvelope(error)).toEqual({
      error: {
        code: 'internal_error',
        message: 'Unable to activate the LaunchAgent',
        retryable: false,
        details: {
          name: 'Error',
          causes: ['launchctl bootstrap failed with exit code 5: Input/output error'],
        },
        suggestion:
          'Inspect the daemon logs and retry only if the underlying failure is transient.',
      },
    });
    expect(createLocalErrorEnvelope(new Error('plain'))).toMatchObject({
      error: { message: 'plain', details: { name: 'Error' } },
    });
  });

  it('keeps bounded aggregate members and their causes in the local CLI envelope', () => {
    const error = new AggregateError(
      [
        new Error('daemon did not become healthy', { cause: new Error('connection refused') }),
        new Error('launchctl rollback bootout failed'),
        new AggregateError([new Error('nested cleanup failure')], 'nested rollback failed'),
      ],
      'Service installation and rollback failed',
    );

    expect(createLocalErrorEnvelope(error).error.details).toEqual({
      name: 'AggregateError',
      causes: [
        'daemon did not become healthy',
        'launchctl rollback bootout failed',
        'nested rollback failed',
        'nested cleanup failure',
        'connection refused',
      ],
    });
  });

  it('routes typed and non-Error failures through the shared envelope locally', () => {
    const typed = new AppError('not_found', 'Missing', 404, false, { id: 'x' });
    expect(createLocalErrorEnvelope(typed)).toEqual(createAgentErrorEnvelope(typed));
    expect(createLocalErrorEnvelope('failure')).toEqual(createAgentErrorEnvelope('failure'));
  });

  it('bounds a pathological cause chain in the local envelope', () => {
    let error = new Error('depth 0');
    for (let depth = 1; depth <= 12; depth += 1)
      error = new Error(`depth ${depth}`, { cause: error });
    const envelope = createLocalErrorEnvelope(error);
    expect((envelope.error.details as { causes: string[] }).causes).toHaveLength(8);
  });

  it('extracts one successful MCP text envelope unchanged', () => {
    const envelope = { data: { id: 'workspace-id' } };
    expect(
      extractAgentEnvelope({
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
      }),
    ).toEqual(envelope);
  });

  it('extracts one failed MCP text envelope unchanged', () => {
    const envelope = createAgentErrorEnvelope(
      new AppError('revision_conflict', 'Revision changed', 409, true, { currentRevision: 2 }),
    );
    expect(
      extractAgentEnvelope({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
      }),
    ).toEqual(envelope);
  });

  it.each([
    { name: 'no content', result: { content: [] } },
    {
      name: 'multiple blocks',
      result: {
        content: [
          { type: 'text' as const, text: '{"data":1}' },
          { type: 'text' as const, text: '{"data":2}' },
        ],
      },
    },
    {
      name: 'non-text content',
      result: { content: [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }] },
    },
    { name: 'invalid JSON', result: { content: [{ type: 'text' as const, text: 'not-json' }] } },
    {
      name: 'a primitive envelope',
      result: { content: [{ type: 'text' as const, text: 'null' }] },
    },
    { name: 'an array envelope', result: { content: [{ type: 'text' as const, text: '[]' }] } },
    { name: 'a missing data key', result: { content: [{ type: 'text' as const, text: '{}' }] } },
    {
      name: 'extra success keys',
      result: { content: [{ type: 'text' as const, text: '{"data":{},"extra":true}' }] },
    },
    {
      name: 'an error without isError',
      result: {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(createAgentErrorEnvelope(new AppError('conflict', 'Busy', 409))),
          },
        ],
      },
    },
    {
      name: 'success with isError',
      result: { isError: true, content: [{ type: 'text' as const, text: '{"data":{}}' }] },
    },
    {
      name: 'extra error envelope keys',
      result: {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...createAgentErrorEnvelope(new AppError('conflict', 'Busy', 409)),
              extra: true,
            }),
          },
        ],
      },
    },
  ])('rejects $name', ({ result }) => {
    expect(() => extractAgentEnvelope(result)).toThrowError(
      expect.objectContaining({
        code: 'internal_error',
        message: 'MCP tool returned an invalid Pimpampum envelope',
      }),
    );
  });

  it.each([
    null,
    {},
    { code: 'unknown', message: 'Failure', retryable: false, details: {}, suggestion: 'Retry' },
    { code: 'conflict', message: 1, retryable: false, details: {}, suggestion: 'Retry' },
    { code: 'conflict', message: 'Failure', retryable: 'no', details: {}, suggestion: 'Retry' },
    { code: 'conflict', message: 'Failure', retryable: false, details: [], suggestion: 'Retry' },
    { code: 'conflict', message: 'Failure', retryable: false, details: {}, suggestion: 1 },
    {
      code: 'conflict',
      message: 'Failure',
      retryable: false,
      details: {},
      suggestion: 'Retry',
      extra: true,
    },
  ])('rejects malformed error payload %#', (error) => {
    expect(() =>
      extractAgentEnvelope({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error }) }],
      }),
    ).toThrowError('MCP tool returned an invalid Pimpampum envelope');
  });
});
