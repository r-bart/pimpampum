/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * Supplemental safety contract generated before implementation after the strict Phase 0 review.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { PimpampumStore } from '../src/store.js';

type DomainOverview = {
  status: string;
  counts: { activeClaims: number; availableWork: number; projects: number };
  projects: unknown[];
  projectsTruncated: boolean;
  activeWork: unknown[];
  activeWorkTruncated: boolean;
};

function overview(store: PimpampumStore): DomainOverview {
  return (store as unknown as { getOverview(): DomainOverview }).getOverview();
}

describe('Frozen desktop-status safety contract', () => {
  it('freezes every project and global status precedence branch', async () => {
    const semantics = (await import(new URL('../src/overview.ts', import.meta.url).href)) as {
      statusForProject(input: {
        lifecycleState: 'draft' | 'ready' | 'done';
        activeClaimCount: number;
        availableWorkCount: number;
      }): string;
      statusForOverview(input: {
        projects: number;
        draftProjects: number;
        completedProjects: number;
        activeClaims: number;
        availableWork: number;
      }): string;
    };

    expect(
      semantics.statusForProject({
        lifecycleState: 'ready',
        activeClaimCount: 1,
        availableWorkCount: 3,
      }),
    ).toBe('active');
    expect(
      semantics.statusForProject({
        lifecycleState: 'ready',
        activeClaimCount: 0,
        availableWorkCount: 1,
      }),
    ).toBe('available');
    expect(
      semantics.statusForProject({
        lifecycleState: 'draft',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('draft');
    expect(
      semantics.statusForProject({
        lifecycleState: 'done',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('complete');

    expect(
      semantics.statusForOverview({
        projects: 0,
        draftProjects: 0,
        completedProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('empty');
    expect(
      semantics.statusForOverview({
        projects: 4,
        draftProjects: 1,
        completedProjects: 1,
        activeClaims: 1,
        availableWork: 2,
      }),
    ).toBe('active');
    expect(
      semantics.statusForOverview({
        projects: 4,
        draftProjects: 1,
        completedProjects: 1,
        activeClaims: 0,
        availableWork: 2,
      }),
    ).toBe('available');
    expect(
      semantics.statusForOverview({
        projects: 2,
        draftProjects: 1,
        completedProjects: 1,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('draft');
    expect(
      semantics.statusForOverview({
        projects: 2,
        draftProjects: 0,
        completedProjects: 2,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('complete');
  });

  it('bounds a non-empty collection at 500 and reports truncation', async () => {
    const { boundOverview } = (await import(
      new URL('../src/overview.ts', import.meta.url).href
    )) as {
      boundOverview<T>(items: T[], limit: number): { items: T[]; truncated: boolean };
    };
    const result = boundOverview(
      Array.from({ length: 501 }, (_, index) => index),
      500,
    );
    expect(result.items).toHaveLength(500);
    expect(result.items[0]).toBe(0);
    expect(result.items[499]).toBe(499);
    expect(result.truncated).toBe(true);
  });

  it('sorts by semantic precedence, recency, and stable id rather than title', async () => {
    const { sortOverviewProjects } = (await import(
      new URL('../src/overview.ts', import.meta.url).href
    )) as {
      sortOverviewProjects(
        left: { id: string; title: string; status: string; updatedAt: string },
        right: { id: string; title: string; status: string; updatedAt: string },
      ): number;
    };
    const projects = [
      {
        id: 'complete',
        title: 'Duplicate',
        status: 'complete',
        updatedAt: '2026-08-26T20:04:00.000Z',
      },
      {
        id: 'available-older',
        title: 'Duplicate',
        status: 'available',
        updatedAt: '2026-08-26T20:01:00.000Z',
      },
      {
        id: 'active',
        title: 'Duplicate',
        status: 'active',
        updatedAt: '2026-08-26T20:00:00.000Z',
      },
      {
        id: 'draft',
        title: 'Duplicate',
        status: 'draft',
        updatedAt: '2026-08-26T20:03:00.000Z',
      },
      {
        id: 'available-newer-b',
        title: 'Duplicate',
        status: 'available',
        updatedAt: '2026-08-26T20:02:00.000Z',
      },
      {
        id: 'available-newer-a',
        title: 'Duplicate',
        status: 'available',
        updatedAt: '2026-08-26T20:02:00.000Z',
      },
    ];

    expect([...projects].sort(sortOverviewProjects).map(({ id }) => id)).toEqual([
      'active',
      'available-newer-a',
      'available-newer-b',
      'available-older',
      'draft',
      'complete',
    ]);
  });

  it('caps the real store response while retaining total project counts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-bound-'));
    const store = new PimpampumStore(openDatabase(':memory:'));
    try {
      store.registerWorkspace({
        id: 'bounded',
        name: 'Bounded',
        rootPath: directory,
        actor: 'acceptance',
      });
      for (let index = 0; index < 501; index += 1) {
        store.createProject({
          workspaceId: 'bounded',
          slug: `project-${String(index).padStart(3, '0')}`,
          title: `Project ${index}`,
          prd: '# Must never be selected by overview',
          state: 'draft',
          actor: 'acceptance',
        });
      }
      const result = overview(store);
      expect(result.counts.projects).toBe(501);
      expect(result.projects).toHaveLength(500);
      expect(result.projectsTruncated).toBe(true);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('applies status precedence and deterministic duplicate-title ordering in the real store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-mixed-'));
    const database = openDatabase(':memory:');
    const store = new PimpampumStore(database);
    try {
      store.registerWorkspace({
        id: 'mixed',
        name: 'Mixed',
        rootPath: directory,
        actor: 'acceptance',
      });
      const active = store.createProject({
        workspaceId: 'mixed',
        slug: 'active',
        title: 'Duplicate',
        prd: '',
        state: 'ready',
        actor: 'acceptance',
      });
      const activeTask = store.createTask({
        projectId: active.id,
        parentId: null,
        title: 'Active task',
        body: null,
        actor: 'acceptance',
      });
      store.startWork({
        targetType: 'task',
        targetId: activeTask.id,
        agentId: 'active-agent',
        leaseSeconds: 1_800,
      });
      const availableA = store.createProject({
        workspaceId: 'mixed',
        slug: 'available-a',
        title: 'Duplicate',
        prd: '',
        state: 'ready',
        actor: 'acceptance',
      });
      const availableB = store.createProject({
        workspaceId: 'mixed',
        slug: 'available-b',
        title: 'Duplicate',
        prd: '',
        state: 'ready',
        actor: 'acceptance',
      });
      const draft = store.createProject({
        workspaceId: 'mixed',
        slug: 'draft',
        title: 'Duplicate',
        prd: '',
        state: 'draft',
        actor: 'acceptance',
      });
      const complete = store.createProject({
        workspaceId: 'mixed',
        slug: 'complete',
        title: 'Duplicate',
        prd: '',
        state: 'ready',
        actor: 'acceptance',
      });
      store.startWork({
        targetType: 'project',
        targetId: complete.id,
        agentId: 'completion-agent',
        leaseSeconds: 1_800,
      });
      store.completeWork({
        targetType: 'project',
        targetId: complete.id,
        agentId: 'completion-agent',
        expectedRevision: complete.revision,
        summary: 'Done',
        artifacts: [],
      });
      database
        .prepare("UPDATE projects SET updated_at = '2026-08-26T20:00:00.000Z' WHERE id IN (?, ?)")
        .run(availableA.id, availableB.id);

      const result = overview(store) as unknown as {
        status: string;
        projects: Array<{ id: string; status: string }>;
      };
      const stableAvailable = [availableA.id, availableB.id].sort();
      expect(result.status).toBe('active');
      expect(result.projects.map(({ id }) => id)).toEqual([
        active.id,
        ...stableAvailable,
        draft.id,
        complete.id,
      ]);
      expect(result.projects.map(({ status }) => status)).toEqual([
        'active',
        'available',
        'available',
        'draft',
        'complete',
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('caps 501 real active claims and retains the global count', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-active-work-bound-'));
    const store = new PimpampumStore(openDatabase(':memory:'));
    try {
      store.registerWorkspace({
        id: 'active-bound',
        name: 'Active bound',
        rootPath: directory,
        actor: 'acceptance',
      });
      const project = store.createProject({
        workspaceId: 'active-bound',
        slug: 'claimed',
        title: 'Claimed',
        prd: '',
        state: 'ready',
        actor: 'acceptance',
      });
      for (let index = 0; index < 501; index += 1) {
        const task = store.createTask({
          projectId: project.id,
          parentId: null,
          title: `Claimed task ${index}`,
          body: null,
          actor: 'acceptance',
        });
        store.startWork({
          targetType: 'task',
          targetId: task.id,
          agentId: `agent-${index}`,
          leaseSeconds: 1_800,
        });
      }
      const result = overview(store);
      expect(result.counts.activeClaims).toBe(501);
      expect(result.activeWork).toHaveLength(500);
      expect(result.activeWorkTruncated).toBe(true);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps availableWork aligned with listWork and excludes expired claims', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-agreement-'));
    const database = openDatabase(':memory:');
    const store = new PimpampumStore(database);
    try {
      store.registerWorkspace({
        id: 'agreement',
        name: 'Agreement',
        rootPath: directory,
        actor: 'acceptance',
      });
      const project = store.createProject({
        workspaceId: 'agreement',
        slug: 'claimable',
        title: 'Claimable',
        prd: '# Hidden body',
        state: 'ready',
        actor: 'acceptance',
      });
      const task = store.createTask({
        projectId: project.id,
        parentId: null,
        title: 'Leaf task',
        body: 'Hidden task body',
        actor: 'acceptance',
      });

      expect(overview(store).counts.availableWork).toBe(
        store.listWork({ workspaceId: null, limit: 500 }).length,
      );
      store.startWork({
        targetType: 'task',
        targetId: task.id,
        agentId: 'expiring-agent',
        leaseSeconds: 1_800,
      });
      database.prepare("UPDATE claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();

      const afterExpiry = overview(store);
      expect(afterExpiry.counts.activeClaims).toBe(0);
      expect(afterExpiry.activeWork).toEqual([]);
      expect(afterExpiry.counts.availableWork).toBe(
        store.listWork({ workspaceId: null, limit: 500 }).length,
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never selects Markdown, completion, context, or artifact payload columns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-query-'));
    const database = openDatabase(':memory:');
    const queries: string[] = [];
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation(((sql: string) => {
      queries.push(sql);
      return prepare(sql);
    }) as typeof database.prepare);
    const store = new PimpampumStore(database);
    try {
      store.registerWorkspace({
        id: 'query-boundary',
        name: 'Query boundary',
        rootPath: directory,
        actor: 'acceptance',
      });
      store.createProject({
        workspaceId: 'query-boundary',
        slug: 'secret',
        title: 'Visible title',
        prd: 'query-boundary-secret',
        state: 'draft',
        actor: 'acceptance',
      });
      queries.length = 0;
      const result = overview(store);
      const overviewSql = queries.join('\n').toLowerCase();
      expect(queries.length).toBeGreaterThan(0);
      expect(overviewSql).not.toMatch(/select\s+(?:\w+\.)?\*/);
      expect(overviewSql).not.toMatch(/\bprd\b|\bbody\b|completion_summary|artifacts_json/);
      expect(JSON.stringify(result)).not.toMatch(/query-boundary-secret/);
    } finally {
      vi.restoreAllMocks();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders a parseable LaunchAgent with argument arrays and abnormal-exit keepalive', async () => {
    const { renderLaunchAgent } = (await import(
      new URL('../src/service/launchd.ts', import.meta.url).href
    )) as {
      renderLaunchAgent(input: {
        nodePath: string;
        cliPath: string;
        dataDirectory: string;
        host: string;
        port: number;
        logDirectory: string;
      }): string;
    };
    const plist = renderLaunchAgent({
      nodePath: '/opt/Pimpampum Runtime/bin/node',
      cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
      dataDirectory: '/Users/example/Pimpampum Data',
      host: '127.0.0.1',
      port: 7337,
      logDirectory: '/Users/example/Pimpampum Data/logs',
    });
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>/);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
    expect(plist).not.toMatch(/\/bin\/(?:ba)?sh|sh -c|PIMPAMPUM_TOKEN|Bearer/);
    if (process.platform === 'darwin') {
      expect(() =>
        execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: plist, stdio: 'pipe' }),
      ).not.toThrow();
    }
  });

  it('renders systemd ExecStart without a command shell or embedded token', async () => {
    const { renderSystemdUnit } = (await import(
      new URL('../src/service/systemd.ts', import.meta.url).href
    )) as {
      renderSystemdUnit(input: {
        nodePath: string;
        cliPath: string;
        dataDirectory: string;
        host: string;
        port: number;
      }): string;
    };
    const unit = renderSystemdUnit({
      nodePath: '/home/dev/Pimpampum Runtime/bin/node',
      cliPath: '/home/dev/Pimpampum Runtime/dist/cli.js',
      dataDirectory: '/home/dev/Pimpampum Data',
      host: '127.0.0.1',
      port: 7337,
    });
    expect(unit).toMatch(
      /^ExecStart="\/home\/dev\/Pimpampum Runtime\/bin\/node" "\/home\/dev\/Pimpampum Runtime\/dist\/cli\.js" serve$/m,
    );
    expect(unit).not.toMatch(/\/bin\/(?:ba)?sh|sh -c|PIMPAMPUM_TOKEN|Bearer|User=root/);
  });

  it('passes Linux workspace paths as a separate xdg-open argument', () => {
    const qml = readFileSync(
      join(process.cwd(), 'integrations/omarchy/pimpampum-status/StatusPopout.qml'),
      'utf8',
    );
    expect(qml).toMatch(/(?:command|arguments)\s*:\s*\[\s*["']xdg-open["']\s*,/);
    expect(qml).not.toMatch(/shellQuote|sh\s+-c|bash\s+-c|xdg-open\s+\$\{|xdg-open.*\+/);
    expect(qml).toMatch(/onClicked\s*:\s*openWorkspace\([^)]*rootPath[^)]*\)/);
    expect(qml).toMatch(
      /function\s+openWorkspace\([^)]*\)\s*\{[^}]*arguments\s*=\s*\[\s*["']xdg-open["']\s*,/s,
    );
  });

  it('exposes only overview reads and validated reveal actions to native status views', () => {
    const swiftClient = readFileSync(
      join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/OverviewClient.swift'),
      'utf8',
    );
    const swiftView = readFileSync(
      join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift'),
      'utf8',
    );
    const qmlService = readFileSync(
      join(process.cwd(), 'integrations/omarchy/pimpampum-status/OverviewService.qml'),
      'utf8',
    );
    const nativeSurface = `${swiftClient}\n${swiftView}\n${qmlService}`;

    expect(swiftClient).toContain('protocol OverviewReading');
    expect(swiftClient).toContain('fetchOverview');
    expect(swiftView).toContain('WorkspaceOpening');
    expect(qmlService).toMatch(/pimpampum["']?\s*,\s*["']overview/);
    expect(nativeSurface).not.toMatch(
      /work[:_](?:start|renew|release|complete)|project[:_](?:create|update)|task[:_](?:create|update)|context[:_](?:put|update)|pimpampum["']?\s*,\s*["'](?:install|uninstall|serve)|launchctl|systemctl|\b(?:POST|PUT|PATCH|DELETE)\b/,
    );
  });
});
