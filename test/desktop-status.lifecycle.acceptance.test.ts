/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 *
 * Supplemental lifecycle contract generated before implementation after strict Phase 0 review.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type RunCommand = (executable: string, arguments_: string[]) => Promise<CommandResult>;

type ManagerInput = {
  platform: NodeJS.Platform;
  homeDirectory: string;
  dataDirectory: string;
  nodePath: string;
  cliPath: string;
  version: string;
  runCommand: RunCommand;
};

async function managerFactory() {
  return (await import(new URL('../src/service/manager.ts', import.meta.url).href)) as {
    createPlatformServiceManager(input: ManagerInput): {
      install(): Promise<unknown>;
      status(): Promise<unknown>;
      uninstall(): Promise<unknown>;
    };
  };
}

function fixtureRoot(label: string): {
  root: string;
  homeDirectory: string;
  dataDirectory: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-${label}-`));
  const homeDirectory = join(root, 'Home With Spaces ü');
  const dataDirectory = join(root, 'Pimpampum Data ñ');
  mkdirSync(homeDirectory, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, 'token'), 'private-token-value');
  writeFileSync(join(dataDirectory, 'pimpampum.sqlite'), 'database-bytes');
  return {
    root,
    homeDirectory,
    dataDirectory,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function managerInput(
  fixture: ReturnType<typeof fixtureRoot>,
  runCommand: RunCommand,
  platform: NodeJS.Platform = 'darwin',
): ManagerInput {
  return {
    platform,
    homeDirectory: fixture.homeDirectory,
    dataDirectory: fixture.dataDirectory,
    nodePath: '/opt/Pimpampum Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
    version: '1.0.0',
    runCommand,
  };
}

describe('Frozen service lifecycle safety contract', () => {
  it('rejects an unsupported platform before any filesystem or runner mutation', async () => {
    const { createPlatformServiceManager } = await managerFactory();
    const fixture = fixtureRoot('unsupported');
    const runCommand = vi.fn<RunCommand>();
    try {
      const beforeHome = readdirSync(fixture.homeDirectory);
      const beforeData = readdirSync(fixture.dataDirectory);
      const manager = createPlatformServiceManager(managerInput(fixture, runCommand, 'win32'));

      await expect(manager.install()).rejects.toThrow(/unsupported/i);
      expect(readdirSync(fixture.homeDirectory)).toEqual(beforeHome);
      expect(readdirSync(fixture.dataDirectory)).toEqual(beforeData);
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it('reconciles repeat installation without duplicate artifacts or secret receipts', async () => {
    const { createPlatformServiceManager } = await managerFactory();
    const fixture = fixtureRoot('repeat');
    const runCommand = vi.fn<RunCommand>(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    try {
      const manager = createPlatformServiceManager(managerInput(fixture, runCommand));
      await manager.install();
      const plistPath = join(
        fixture.homeDirectory,
        'Library/LaunchAgents/dev.pimpampum.daemon.plist',
      );
      const receiptPath = join(fixture.dataDirectory, 'install-receipt.json');
      const firstPlist = readFileSync(plistPath);
      const firstReceipt = readFileSync(receiptPath);

      await manager.install();
      expect(readFileSync(plistPath)).toEqual(firstPlist);
      expect(readFileSync(receiptPath)).toEqual(firstReceipt);
      expect(readdirSync(join(fixture.homeDirectory, 'Library/LaunchAgents'))).toEqual([
        'dev.pimpampum.daemon.plist',
      ]);
      expect(readFileSync(receiptPath, 'utf8')).not.toMatch(/token|bearer/i);
      expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    } finally {
      fixture.cleanup();
    }
  });

  it('restores pre-existing bytes when activation fails after staging a write', async () => {
    const { createPlatformServiceManager } = await managerFactory();
    const fixture = fixtureRoot('rollback');
    const plistPath = join(
      fixture.homeDirectory,
      'Library/LaunchAgents/dev.pimpampum.daemon.plist',
    );
    mkdirSync(join(fixture.homeDirectory, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, 'original-plist-bytes');
    const runCommand = vi.fn<RunCommand>(async () => {
      throw new Error('launchctl activation failed');
    });
    try {
      const manager = createPlatformServiceManager(managerInput(fixture, runCommand));
      await expect(manager.install()).rejects.toThrow('launchctl activation failed');
      expect(readFileSync(plistPath, 'utf8')).toBe('original-plist-bytes');
      expect(existsSync(join(fixture.dataDirectory, 'install-receipt.json'))).toBe(false);
      expect(readFileSync(join(fixture.dataDirectory, 'token'), 'utf8')).toBe(
        'private-token-value',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('uninstalls only receipt-owned artifacts and preserves data and token byte-for-byte', async () => {
    const { createPlatformServiceManager } = await managerFactory();
    const fixture = fixtureRoot('uninstall');
    const runCommand = vi.fn<RunCommand>(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    try {
      const manager = createPlatformServiceManager(managerInput(fixture, runCommand));
      await manager.install();
      await expect(manager.uninstall()).resolves.toMatchObject({
        uninstalled: true,
        dataPreserved: true,
      });

      expect(readFileSync(join(fixture.dataDirectory, 'token'), 'utf8')).toBe(
        'private-token-value',
      );
      expect(readFileSync(join(fixture.dataDirectory, 'pimpampum.sqlite'), 'utf8')).toBe(
        'database-bytes',
      );
      expect(existsSync(join(fixture.dataDirectory, 'install-receipt.json'))).toBe(false);
      expect(
        existsSync(join(fixture.homeDirectory, 'Library/LaunchAgents/dev.pimpampum.daemon.plist')),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects stale, mismatched, and expired macOS login acknowledgements', async () => {
    const { acceptLoginAcknowledgement } = (await import(
      new URL('../src/service/loginHandshake.ts', import.meta.url).href
    )) as {
      acceptLoginAcknowledgement(
        request: { requestId: string; requestedAt: string; expiresAt: string },
        acknowledgement: { requestId: string; createdAt: string; status: string },
        now: string,
      ): { requestId: string; status: string };
    };
    const request = {
      requestId: 'request-current',
      requestedAt: '2026-08-26T20:00:00.000Z',
      expiresAt: '2026-08-26T20:00:30.000Z',
    };

    expect(() =>
      acceptLoginAcknowledgement(
        request,
        {
          requestId: 'request-stale',
          createdAt: '2026-08-26T20:00:05.000Z',
          status: 'enabled',
        },
        '2026-08-26T20:00:06.000Z',
      ),
    ).toThrow(/request/i);
    expect(() =>
      acceptLoginAcknowledgement(
        request,
        {
          requestId: 'request-current',
          createdAt: '2026-08-26T19:59:59.000Z',
          status: 'enabled',
        },
        '2026-08-26T20:00:06.000Z',
      ),
    ).toThrow(/stale|time/i);
    expect(() =>
      acceptLoginAcknowledgement(
        request,
        {
          requestId: 'request-current',
          createdAt: '2026-08-26T20:00:05.000Z',
          status: 'enabled',
        },
        '2026-08-26T20:00:31.000Z',
      ),
    ).toThrow(/expired|time/i);
    expect(
      acceptLoginAcknowledgement(
        request,
        {
          requestId: 'request-current',
          createdAt: '2026-08-26T20:00:05.000Z',
          status: 'requiresApproval',
        },
        '2026-08-26T20:00:06.000Z',
      ),
    ).toEqual({ requestId: 'request-current', status: 'requiresApproval' });
  });
});
