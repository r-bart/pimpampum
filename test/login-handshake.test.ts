import { describe, expect, it } from 'vitest';
import { acceptLoginAcknowledgement } from '../src/service/loginHandshake.js';

describe('macOS login acknowledgement validation', () => {
  const request = {
    requestId: 'current-request',
    requestedAt: '2026-08-26T20:00:00.000Z',
    expiresAt: '2026-08-26T20:00:30.000Z',
  };

  it('accepts every supported acknowledgement status', () => {
    for (const status of ['enabled', 'requiresApproval', 'error'] as const) {
      expect(
        acceptLoginAcknowledgement(
          request,
          {
            requestId: request.requestId,
            createdAt: '2026-08-26T20:00:05.000Z',
            status,
          },
          '2026-08-26T20:00:06.000Z',
        ),
      ).toEqual({ requestId: request.requestId, status });
    }
  });

  it('rejects mismatches, malformed times, stale/future acknowledgements, and expiry', () => {
    expect(() =>
      acceptLoginAcknowledgement(
        request,
        { requestId: 'other', createdAt: request.requestedAt, status: 'enabled' },
        request.requestedAt,
      ),
    ).toThrow(/request does not match/);

    const invalidCases: Array<{
      request: typeof request;
      createdAt: string;
      now: string;
      status?: string;
      message: RegExp;
    }> = [
      {
        request: { ...request, requestedAt: 'invalid' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /request time/,
      },
      {
        request: { ...request, expiresAt: 'invalid' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /expiry time/,
      },
      { request, createdAt: 'invalid', now: request.requestedAt, message: /acknowledgement time/ },
      { request, createdAt: request.requestedAt, now: 'invalid', message: /current time/ },
      {
        request: { ...request, expiresAt: '2026-08-26T19:59:59.000Z' },
        createdAt: request.requestedAt,
        now: request.requestedAt,
        message: /time window/,
      },
      {
        request,
        createdAt: '2026-08-26T19:59:59.000Z',
        now: request.requestedAt,
        message: /stale/i,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:31.000Z',
        now: '2026-08-26T20:00:10.000Z',
        message: /expired/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:05.000Z',
        now: '2026-08-26T20:00:31.000Z',
        message: /expired/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:10.000Z',
        now: '2026-08-26T20:00:05.000Z',
        message: /future/,
      },
      {
        request,
        createdAt: '2026-08-26T20:00:05.000Z',
        now: '2026-08-26T20:00:06.000Z',
        status: 'unknown',
        message: /status/,
      },
    ];
    for (const testCase of invalidCases) {
      expect(() =>
        acceptLoginAcknowledgement(
          testCase.request,
          {
            requestId: request.requestId,
            createdAt: testCase.createdAt,
            status: testCase.status ?? 'enabled',
          },
          testCase.now,
        ),
      ).toThrow(testCase.message);
    }
  });
});
