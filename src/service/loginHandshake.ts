export type LoginAcknowledgementStatus = 'enabled' | 'requiresApproval' | 'error';

export interface LoginRequest {
  requestId: string;
  requestedAt: string;
  expiresAt: string;
}

export interface LoginAcknowledgement {
  requestId: string;
  createdAt: string;
  status: string;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} time`);
  return parsed;
}

function acknowledgementStatus(value: string): LoginAcknowledgementStatus {
  if (value === 'enabled' || value === 'requiresApproval' || value === 'error') return value;
  throw new Error('Invalid login acknowledgement status');
}

export function acceptLoginAcknowledgement(
  request: LoginRequest,
  acknowledgement: LoginAcknowledgement,
  now: string,
): { requestId: string; status: LoginAcknowledgementStatus } {
  if (acknowledgement.requestId !== request.requestId) {
    throw new Error('Login acknowledgement request does not match');
  }
  const requestedAt = timestamp(request.requestedAt, 'request');
  const expiresAt = timestamp(request.expiresAt, 'expiry');
  const createdAt = timestamp(acknowledgement.createdAt, 'acknowledgement');
  const currentTime = timestamp(now, 'current');
  if (expiresAt < requestedAt) throw new Error('Invalid login request time window');
  if (createdAt < requestedAt) throw new Error('Stale login acknowledgement time');
  if (createdAt > expiresAt || currentTime > expiresAt) {
    throw new Error('Login acknowledgement expired');
  }
  if (currentTime < createdAt) throw new Error('Invalid acknowledgement time in the future');
  return {
    requestId: request.requestId,
    status: acknowledgementStatus(acknowledgement.status),
  };
}
