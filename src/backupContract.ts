import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';

export type AutomaticBackupState = 'disabled' | 'pending' | 'healthy' | 'error';

export interface AutomaticBackupStatus {
  enabled: boolean;
  directory: string | null;
  snapshotPath: string | null;
  state: AutomaticBackupState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
}

export interface AutomaticBackupGateway {
  getStatus(): AutomaticBackupStatus;
  configure(directory: string): Promise<AutomaticBackupStatus>;
  retry(): Promise<AutomaticBackupStatus>;
  disable(): Promise<AutomaticBackupStatus>;
}

const statusSchema = z
  .object({
    enabled: z.boolean(),
    directory: z.string().nullable(),
    snapshotPath: z.string().nullable(),
    state: z.enum(['disabled', 'pending', 'healthy', 'error']),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
  })
  .strict()
  .superRefine((status, context) => {
    const enabledShape =
      status.enabled &&
      status.state !== 'disabled' &&
      status.directory !== null &&
      isAbsolute(status.directory) &&
      status.snapshotPath !== null &&
      isAbsolute(status.snapshotPath);
    const disabledShape =
      !status.enabled &&
      status.state === 'disabled' &&
      status.directory === null &&
      status.snapshotPath === null &&
      status.error === null;
    if (!enabledShape && !disabledShape) {
      context.addIssue({ code: 'custom', message: 'inconsistent backup status' });
    }
    if (
      status.error !== null &&
      (status.error.length === 0 || status.error.length > 500 || /\p{Cc}/u.test(status.error))
    ) {
      context.addIssue({ code: 'custom', message: 'invalid backup error' });
    }
  });

export function parseAutomaticBackupStatus(value: unknown): AutomaticBackupStatus {
  const result = statusSchema.safeParse(value);
  if (!result.success) {
    throw new AppError('internal_error', 'Pimpampum returned invalid backup status', 502, true);
  }
  return result.data;
}
