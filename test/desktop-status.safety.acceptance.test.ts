/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 *
 * Supplemental safety contract generated before implementation after the strict Phase 0 review.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

function createOpenProject(
  store: PimpampumStore,
  input: { workspaceId: string; slug: string; title: string; body?: string },
) {
  let project = store.createProject({
    workspaceId: input.workspaceId,
    slug: input.slug,
    title: input.title,
    actor: 'acceptance',
  });
  let spec = store.createSpec({
    projectId: project.id,
    slug: 'primary',
    title: `${input.title} Spec`,
    body: input.body ?? '# Executable Spec',
    actor: 'acceptance',
  });
  spec = store.updateSpec({
    specId: spec.id,
    title: null,
    body: null,
    state: 'ready',
    expectedRevision: spec.revision,
    actor: 'acceptance',
  });
  project = store.updateProject({
    projectId: project.id,
    title: null,
    state: 'open',
    expectedRevision: project.revision,
    actor: 'acceptance',
  });
  return { project, spec };
}

describe('Frozen desktop-status safety contract', () => {
  it('freezes every project and global status precedence branch', async () => {
    const semantics = (await import(new URL('../src/overview.ts', import.meta.url).href)) as {
      statusForProject(input: {
        lifecycleState: 'draft' | 'open' | 'paused' | 'done' | 'cancelled';
        activeClaimCount: number;
        availableWorkCount: number;
      }): string;
      statusForOverview(input: {
        projects: number;
        draftProjects: number;
        openProjects: number;
        pausedProjects: number;
        completedProjects: number;
        cancelledProjects: number;
        activeClaims: number;
        availableWork: number;
      }): string;
    };

    expect(
      semantics.statusForProject({
        lifecycleState: 'open',
        activeClaimCount: 1,
        availableWorkCount: 3,
      }),
    ).toBe('active');
    expect(
      semantics.statusForProject({
        lifecycleState: 'open',
        activeClaimCount: 0,
        availableWorkCount: 1,
      }),
    ).toBe('available');
    expect(
      semantics.statusForProject({
        lifecycleState: 'paused',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('paused');
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
      semantics.statusForProject({
        lifecycleState: 'cancelled',
        activeClaimCount: 0,
        availableWorkCount: 0,
      }),
    ).toBe('complete');

    expect(
      semantics.statusForOverview({
        projects: 1,
        draftProjects: 0,
        openProjects: 0,
        pausedProjects: 1,
        completedProjects: 0,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('paused');
    expect(
      semantics.statusForOverview({
        projects: 0,
        draftProjects: 0,
        openProjects: 0,
        pausedProjects: 0,
        completedProjects: 0,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('empty');
    expect(
      semantics.statusForOverview({
        projects: 4,
        draftProjects: 1,
        openProjects: 2,
        pausedProjects: 0,
        completedProjects: 1,
        cancelledProjects: 0,
        activeClaims: 1,
        availableWork: 2,
      }),
    ).toBe('active');
    expect(
      semantics.statusForOverview({
        projects: 4,
        draftProjects: 1,
        openProjects: 2,
        pausedProjects: 0,
        completedProjects: 1,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 2,
      }),
    ).toBe('available');
    expect(
      semantics.statusForOverview({
        projects: 2,
        draftProjects: 1,
        openProjects: 0,
        pausedProjects: 0,
        completedProjects: 1,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('draft');
    expect(
      semantics.statusForOverview({
        projects: 2,
        draftProjects: 0,
        openProjects: 0,
        pausedProjects: 0,
        completedProjects: 2,
        cancelledProjects: 0,
        activeClaims: 0,
        availableWork: 0,
      }),
    ).toBe('complete');
    expect(
      semantics.statusForOverview({
        projects: 2,
        draftProjects: 0,
        openProjects: 0,
        pausedProjects: 0,
        completedProjects: 1,
        cancelledProjects: 1,
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
    const { overviewProjectOrderSql, statusPrecedence } = (await import(
      new URL('../src/overview.ts', import.meta.url).href
    )) as {
      overviewProjectOrderSql(columns: {
        activeClaimCount: string;
        availableWorkCount: string;
        state: string;
        updatedAt: string;
        id: string;
      }): string;
      statusPrecedence: Record<string, number>;
    };
    expect(statusPrecedence).toEqual({ active: 0, available: 1, draft: 2, paused: 3, complete: 4 });
    const projects = [
      {
        id: 'complete',
        title: 'Duplicate',
        state: 'done',
        active: 0,
        available: 0,
        updatedAt: '2026-08-26T20:04:00.000Z',
      },
      {
        id: 'available-older',
        title: 'Duplicate',
        state: 'open',
        active: 0,
        available: 1,
        updatedAt: '2026-08-26T20:01:00.000Z',
      },
      {
        id: 'active',
        title: 'Duplicate',
        state: 'open',
        active: 1,
        available: 0,
        updatedAt: '2026-08-26T20:00:00.000Z',
      },
      {
        id: 'draft',
        title: 'Duplicate',
        state: 'draft',
        active: 0,
        available: 0,
        updatedAt: '2026-08-26T20:03:00.000Z',
      },
      {
        id: 'paused',
        title: 'Duplicate',
        state: 'paused',
        active: 0,
        available: 0,
        updatedAt: '2026-08-26T20:05:00.000Z',
      },
      {
        id: 'available-newer-b',
        title: 'Duplicate',
        state: 'open',
        active: 0,
        available: 1,
        updatedAt: '2026-08-26T20:02:00.000Z',
      },
      {
        id: 'available-newer-a',
        title: 'Duplicate',
        state: 'open',
        active: 0,
        available: 1,
        updatedAt: '2026-08-26T20:02:00.000Z',
      },
    ];
    // The same ORDER BY the store binds; run it against a scratch table so the SQL is the
    // artefact under test rather than a JavaScript twin of it.
    const database = new Database(':memory:');
    try {
      database.exec(
        'CREATE TABLE rows (id TEXT, title TEXT, state TEXT, active INTEGER, available INTEGER, updated_at TEXT)',
      );
      const insert = database.prepare('INSERT INTO rows VALUES (?,?,?,?,?,?)');
      for (const row of projects) {
        insert.run(row.id, row.title, row.state, row.active, row.available, row.updatedAt);
      }
      const ordered = database
        .prepare(
          `SELECT id FROM rows ORDER BY ${overviewProjectOrderSql({
            activeClaimCount: 'active',
            availableWorkCount: 'available',
            state: 'state',
            updatedAt: 'updated_at',
            id: 'id',
          })}`,
        )
        .all() as Array<{ id: string }>;
      expect(ordered.map(({ id }) => id)).toEqual([
        'active',
        'available-newer-a',
        'available-newer-b',
        'available-older',
        'draft',
        'paused',
        'complete',
      ]);
    } finally {
      database.close();
    }
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
      const activeResult = createOpenProject(store, {
        workspaceId: 'mixed',
        slug: 'active',
        title: 'Duplicate',
      });
      const active = activeResult.project;
      const activeTask = store.createTask({
        specId: activeResult.spec.id,
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
      const availableA = createOpenProject(store, {
        workspaceId: 'mixed',
        slug: 'available-a',
        title: 'Duplicate',
      }).project;
      const availableB = createOpenProject(store, {
        workspaceId: 'mixed',
        slug: 'available-b',
        title: 'Duplicate',
      }).project;
      const draft = store.createProject({
        workspaceId: 'mixed',
        slug: 'draft',
        title: 'Duplicate',
        actor: 'acceptance',
      });
      const completeResult = createOpenProject(store, {
        workspaceId: 'mixed',
        slug: 'complete',
        title: 'Duplicate',
      });
      let complete = completeResult.project;
      store.startWork({
        targetType: 'spec',
        targetId: completeResult.spec.id,
        agentId: 'completion-agent',
        leaseSeconds: 1_800,
      });
      store.completeWork({
        targetType: 'spec',
        targetId: completeResult.spec.id,
        agentId: 'completion-agent',
        expectedRevision: completeResult.spec.revision,
        summary: 'Done',
        artifacts: [],
      });
      complete = store.completeProject({
        projectId: complete.id,
        expectedRevision: complete.revision,
        summary: 'Done aggregate',
        artifacts: [],
        actor: 'acceptance',
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
      const projectResult = createOpenProject(store, {
        workspaceId: 'active-bound',
        slug: 'claimed',
        title: 'Claimed',
      });
      for (let index = 0; index < 501; index += 1) {
        const task = store.createTask({
          specId: projectResult.spec.id,
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
  }, 60_000);

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
      const projectResult = createOpenProject(store, {
        workspaceId: 'agreement',
        slug: 'claimable',
        title: 'Claimable',
        body: '# Hidden body',
      });
      const task = store.createTask({
        specId: projectResult.spec.id,
        parentId: null,
        title: 'Leaf task',
        body: 'Hidden task body',
        actor: 'acceptance',
      });

      expect(overview(store).counts.availableWork).toBe(
        store.listWork({ workspaceId: null, projectId: null, specId: null, limit: 500 }).length,
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
        store.listWork({ workspaceId: null, projectId: null, specId: null, limit: 500 }).length,
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
      const project = store.createProject({
        workspaceId: 'query-boundary',
        slug: 'secret',
        title: 'Visible title',
        actor: 'acceptance',
      });
      store.createSpec({
        projectId: project.id,
        slug: 'secret-spec',
        title: 'Visible Spec title',
        body: 'query-boundary-secret',
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
    // StatusPopout.qml was split in wave 4 (Task 9.6): PopoutController.qml owns the launcher call
    // and PortfolioPage.qml wires the row to it. The property is unchanged — a workspace path is
    // always a separate argument of the command list, never interpolated into a shell string.
    const pluginDirectory = join(process.cwd(), 'integrations/omarchy/pimpampum-status');
    const readQml = (name: string): string => readFileSync(join(pluginDirectory, name), 'utf8');
    // Two surfaces launch the opener: the popout opens a workspace, the folder services open a
    // managed folder. Both build the command as a list, so both are pinned.
    expect(readQml('PopoutController.qml')).toMatch(
      /function\s+openWorkspace\([^)]*\)\s*\{[^}]*arguments\s*=\s*\[\s*["']xdg-open["']\s*,/s,
    );
    expect(readQml('ManagedFolderService.qml')).toMatch(
      /arguments\s*=\s*\[\s*["']xdg-open["']\s*,/,
    );
    expect(readQml('PortfolioPage.qml')).toMatch(
      /onActivated\s*:\s*controller\.openWorkspace\([^)]*rootPath[^)]*\)/,
    );
    // The negative half holds for every QML file the plugin ships, not only the one that opens a
    // workspace: no surface may reach a shell or build the command by concatenation.
    for (const name of readdirSync(pluginDirectory).filter((entry) => entry.endsWith('.qml'))) {
      expect(readQml(name), name).not.toMatch(
        /shellQuote|sh\s+-c|bash\s+-c|xdg-open\s+\$\{|xdg-open.*\+/,
      );
    }
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
