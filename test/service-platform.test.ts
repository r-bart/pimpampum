import { describe, expect, it } from 'vitest';
import { runServiceCommand } from '../src/service/platform.js';

describe('service command runner', () => {
  it('executes argument arrays without a shell and captures success', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stdout.write(process.argv[1]); process.stderr.write('warning')",
        'value with spaces; $(not-a-shell)',
      ]),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'value with spaces; $(not-a-shell)',
      stderr: 'warning',
    });
  });

  it('returns nonzero process exits and rejects missing executables', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stderr.write('failed'); process.exit(7)",
      ]),
    ).resolves.toEqual({ exitCode: 7, stdout: '', stderr: 'failed' });
    await expect(runServiceCommand('/definitely/missing/pimpampum-command', [])).rejects.toThrow();
  });
});
