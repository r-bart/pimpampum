/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { runCli, type CliRuntime } from '../src/cliProgram.js';
import { PimpampumStore } from '../src/store.js';

const token = 'desktop-status-acceptance-token-000000000000';

function config(dataDirectory: string): RuntimeConfig {
  return {
    host: '127.0.0.1',
    port: 7337,
    dataDirectory,
    databasePath: ':memory:',
    token,
    baseUrl: 'http://127.0.0.1:7337',
  };
}

describe('Automatic service and desktop status integrations', () => {
  describe('US-2 and FR-1: aggregated ambient status', () => {
    it('AC-1/FR-1: requires authentication and exposes one bounded overview contract', async () => {
      // Spec: US-2/AC-1, FR-1
      const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-contract-'));
      const store = new PimpampumStore(openDatabase(':memory:'));
      const composition = createHttpApp(store, config(directory));
      try {
        await request(composition.app).get('/api/v1/overview').expect(401);
        const response = await request(composition.app)
          .get('/api/v1/overview')
          .set('authorization', `Bearer ${token}`)
          .expect(200);

        expect(response.body.meta.schemaVersion).toBe(2);
        expect(response.body.data).toMatchObject({
          status: 'empty',
          counts: {
            workspaces: 0,
            projects: 0,
            specs: 0,
            activeClaims: 0,
            availableWork: 0,
          },
          projects: [],
          projectsTruncated: false,
          specs: [],
          specsTruncated: false,
          activeWork: [],
          activeWorkTruncated: false,
        });
      } finally {
        await composition.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('AC-2/FR-1: derives active work from an unexpired claim and omits heavy bodies', async () => {
      // Spec: US-2/AC-2, FR-1, EC-7
      const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-active-'));
      const store = new PimpampumStore(openDatabase(':memory:'));
      store.registerWorkspace({
        id: 'vcomp',
        name: 'VCOMP',
        rootPath: directory,
        actor: 'acceptance',
      });
      let project = store.createProject({
        workspaceId: 'vcomp',
        slug: 'agent-runtime',
        title: 'Agent runtime',
        actor: 'acceptance',
      });
      let spec = store.createSpec({
        projectId: project.id,
        slug: 'runtime-status',
        title: 'Runtime status',
        body: '# Private Spec body',
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
      const task = store.createTask({
        specId: spec.id,
        parentId: null,
        title: 'Implement runtime status',
        body: 'Private task body',
        actor: 'acceptance',
      });
      store.startWork({
        targetType: 'task',
        targetId: task.id,
        agentId: 'codex-night-shift',
        leaseSeconds: 1_800,
      });
      const composition = createHttpApp(store, config(directory));
      try {
        const response = await request(composition.app)
          .get('/api/v1/overview')
          .set('authorization', `Bearer ${token}`)
          .expect(200);

        expect(response.body.data.status).toBe('active');
        expect(response.body.data.counts.activeClaims).toBe(1);
        expect(response.body.data.projects[0]).toMatchObject({
          id: project.id,
          status: 'active',
          activeClaimCount: 1,
          openTaskCount: 1,
        });
        expect(response.body.data.activeWork[0]).toMatchObject({
          projectId: project.id,
          specId: spec.id,
          specTitle: 'Runtime status',
          targetId: task.id,
          agentId: 'codex-night-shift',
          taskTitle: 'Implement runtime status',
        });
        expect(JSON.stringify(response.body.data)).not.toContain('Private Spec body');
        expect(JSON.stringify(response.body.data)).not.toContain('Private task body');
      } finally {
        await composition.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('AC-3/EC-5: reports green-compatible complete state when every project is done', async () => {
      // Spec: US-2/AC-3, EC-5
      const directory = mkdtempSync(join(tmpdir(), 'pimpampum-overview-complete-'));
      const store = new PimpampumStore(openDatabase(':memory:'));
      store.registerWorkspace({
        id: 'finished',
        name: 'Finished',
        rootPath: directory,
        actor: 'acceptance',
      });
      let project = store.createProject({
        workspaceId: 'finished',
        slug: 'shipped',
        title: 'Shipped project',
        actor: 'acceptance',
      });
      let spec = store.createSpec({
        projectId: project.id,
        slug: 'shipped-spec',
        title: 'Shipped Spec',
        body: '# Shipped',
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
      store.startWork({
        targetType: 'spec',
        targetId: spec.id,
        agentId: 'delivery-agent',
        leaseSeconds: 60,
      });
      store.completeWork({
        targetType: 'spec',
        targetId: spec.id,
        agentId: 'delivery-agent',
        expectedRevision: spec.revision,
        summary: 'Delivered',
        artifacts: [],
      });
      project = store.completeProject({
        projectId: project.id,
        expectedRevision: project.revision,
        summary: 'Delivered aggregate',
        artifacts: [],
        actor: 'acceptance',
      });
      const composition = createHttpApp(store, config(directory));
      try {
        const response = await request(composition.app)
          .get('/api/v1/overview')
          .set('authorization', `Bearer ${token}`)
          .expect(200);
        expect(response.body.data).toMatchObject({
          status: 'complete',
          counts: { projects: 1, completedProjects: 1, activeClaims: 0, availableWork: 0 },
          projects: [expect.objectContaining({ id: project.id, status: 'complete' })],
        });
      } finally {
        await composition.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe('US-1 and FR-2: CLI and service lifecycle', () => {
    it('AC-1/FR-1: exposes overview through the thin CLI client', async () => {
      // Spec: US-1/AC-1, FR-1
      const overview = {
        status: 'available',
        counts: { workspaces: 1, projects: 2, activeClaims: 0, availableWork: 2 },
      };
      const getOverview = vi.fn(async () => overview);
      const output: string[] = [];
      const runtime = {
        createClient: () => ({ getOverview }),
        serviceManager: {
          install: vi.fn(),
          status: vi.fn(),
          uninstall: vi.fn(),
        },
        stdout: (text: string) => output.push(text),
        stderr: vi.fn(),
        exit: vi.fn(() => undefined as never),
      } as unknown as CliRuntime;

      await runCli(['overview'], runtime);
      expect(getOverview).toHaveBeenCalledOnce();
      expect(JSON.parse(output[0] ?? '')).toEqual({ data: overview });
    });

    it('AC-2/FR-2: maps install, status and uninstall to an injected idempotent manager', async () => {
      // Spec: US-1/AC-2, US-1/AC-4, US-1/AC-5, FR-2
      const serviceManager = {
        install: vi.fn(async () => ({ installed: true, reconciled: false })),
        status: vi.fn(async () => ({ installed: true, running: true })),
        uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true })),
      };
      const output: string[] = [];
      const runtime = {
        createClient: vi.fn(),
        serviceManager,
        stdout: (text: string) => output.push(text),
        stderr: vi.fn(),
        exit: vi.fn(() => undefined as never),
      } as unknown as CliRuntime;

      await runCli(['install'], runtime);
      await runCli(['status'], runtime);
      await runCli(['uninstall'], runtime);

      expect(serviceManager.install).toHaveBeenCalledOnce();
      expect(serviceManager.status).toHaveBeenCalledOnce();
      expect(serviceManager.uninstall).toHaveBeenCalledOnce();
      expect(output.map((entry) => JSON.parse(entry))).toEqual([
        { data: { installed: true, reconciled: false } },
        { data: { installed: true, running: true } },
        { data: { uninstalled: true, dataPreserved: true } },
      ]);
    });
  });

  describe('FR-2: platform service definitions', () => {
    it('FR-2/macOS: renders a user LaunchAgent without embedding the bearer token', async () => {
      // Spec: FR-2, Security
      const moduleUrl = new URL('../src/service/launchd.ts', import.meta.url).href;
      const launchd = (await import(moduleUrl)) as {
        renderLaunchAgent(input: {
          nodePath: string;
          cliPath: string;
          dataDirectory: string;
          host: string;
          port: number;
          logDirectory: string;
        }): string;
      };
      const plist = launchd.renderLaunchAgent({
        nodePath: '/opt/pimpampum runtime/bin/node',
        cliPath: '/opt/pimpampum/dist/cli.js',
        dataDirectory: '/Users/roberto/Pimpampum Data',
        host: '127.0.0.1',
        port: 7337,
        logDirectory: '/Users/roberto/Pimpampum Data/logs',
      });

      expect(plist).toContain('dev.pimpampum.daemon');
      expect(plist).toContain('/opt/pimpampum runtime/bin/node');
      expect(plist).toContain('RunAtLoad');
      expect(plist).toContain('KeepAlive');
      expect(plist).not.toContain('PIMPAMPUM_TOKEN');
      expect(plist).not.toContain('Bearer');
    });

    it('FR-2/Linux: renders a non-root systemd user service with failure backoff', async () => {
      // Spec: FR-2, Security
      const moduleUrl = new URL('../src/service/systemd.ts', import.meta.url).href;
      const systemd = (await import(moduleUrl)) as {
        renderSystemdUnit(input: {
          nodePath: string;
          cliPath: string;
          dataDirectory: string;
          host: string;
          port: number;
        }): string;
      };
      const unit = systemd.renderSystemdUnit({
        nodePath: '/home/dev/Pimpampum Runtime/bin/node',
        cliPath: '/home/dev/pimpampum/dist/cli.js',
        dataDirectory: '/home/dev/Pimpampum Data',
        host: '127.0.0.1',
        port: 7337,
      });

      expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('RestartSec=');
      expect(unit).toContain('WantedBy=default.target');
      expect(unit).toContain('PIMPAMPUM_DATA_DIR=');
      expect(unit).not.toContain('PIMPAMPUM_TOKEN');
      expect(unit).not.toContain('User=root');
    });
  });

  describe('US-2 through US-4: native read-only status artifacts', () => {
    it('FR-3: ships a menu-bar-only SwiftUI application with login registration', () => {
      // Spec: FR-3
      const app = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/App.swift'),
        'utf8',
      );
      const login = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/LoginItemManager.swift'),
        'utf8',
      );
      const plist = readFileSync(
        join(process.cwd(), 'platforms/macos/Resources/Info.plist'),
        'utf8',
      );

      expect(app).toContain('MenuBarExtra');
      expect(login).toContain('SMAppService');
      expect(plist).toContain('LSUIElement');
      expect(plist).toContain('<true/>');
    });

    it('US-3/AC-4: separates completed and cancelled projects and keeps the macOS UI read-only', () => {
      // Spec: US-3/AC-4, FR-5
      const popover = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift'),
        'utf8',
      );
      const presentation = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/StatusPresentation.swift'),
        'utf8',
      );
      const overviewStore = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/OverviewStore.swift'),
        'utf8',
      );

      expect(popover).toContain('Completed');
      expect(popover).toContain('Cancelled');
      expect(popover).toContain('work.specTitle');
      expect(popover).not.toMatch(/uptimeSeconds|\bsecs?\b/);
      expect(popover).toContain('isCompletedExpanded');
      expect(popover).toContain('isCancelledExpanded');
      expect(overviewStore).toContain('$0.lifecycleState == .done');
      expect(overviewStore).toContain('$0.lifecycleState == .cancelled');
      expect(presentation).toContain('case .cancellationX: "xmark.circle.fill"');
      expect(presentation).toContain('case .cancelled: .cancellationX');
      expect(presentation).toContain(
        'case .loading, .draft, .paused, .cancelled, .empty: .secondary',
      );
      expect(popover).not.toMatch(/work_complete|project_update|task_update|DELETE|PATCH|POST/);
    });

    it('FR-4: ships a valid dedicated Omarchy Quattro bar-widget manifest', () => {
      // Spec: FR-4
      const manifestPath = join(
        process.cwd(),
        'integrations/omarchy/pimpampum-status/manifest.json',
      );
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        schemaVersion: number;
        id: string;
        kinds: string[];
        entryPoints: { barWidget: string };
        barWidget: { allowMultiple: boolean; defaultSection: string };
      };

      expect(manifest).toMatchObject({
        schemaVersion: 1,
        id: 'dev.pimpampum.status',
        kinds: ['bar-widget'],
        entryPoints: { barWidget: 'BarWidget.qml' },
        barWidget: { allowMultiple: false, defaultSection: 'right' },
      });
    });

    it('US-3/FR-4: uses native popout coordination, active count, and terminal disclosures', () => {
      // Spec: US-2/AC-2, US-3/AC-4, FR-4
      const widget = readFileSync(
        join(process.cwd(), 'integrations/omarchy/pimpampum-status/BarWidget.qml'),
        'utf8',
      );
      const popout = readFileSync(
        join(process.cwd(), 'integrations/omarchy/pimpampum-status/StatusPopout.qml'),
        'utf8',
      );

      expect(widget).toContain('requestPopout');
      expect(widget).toMatch(/activeClaims|activeClaim/);
      expect(popout).toContain('Completed');
      expect(popout).toContain('Cancelled');
      expect(popout).toContain('root.cancelledProjects');
      expect(popout).not.toMatch(/work_complete|project_update|task_update/);
    });

    it('US-4/AC-1: uses native file-opening APIs without shell interpolation', () => {
      // Spec: US-4/AC-1, US-4/AC-2, US-4/AC-4
      const macOpener = readFileSync(
        join(process.cwd(), 'platforms/macos/Sources/PimpampumMenuBar/WorkspaceOpener.swift'),
        'utf8',
      );
      const omarchyPopout = readFileSync(
        join(process.cwd(), 'integrations/omarchy/pimpampum-status/StatusPopout.qml'),
        'utf8',
      );

      expect(macOpener).toContain('NSWorkspace');
      expect(macOpener).not.toContain('/bin/sh');
      expect(omarchyPopout).toContain('xdg-open');
      expect(omarchyPopout).toMatch(/shellQuote|arguments/);
    });
  });

  describe('Packaging and documentation', () => {
    it('FR-3/FR-4: defines native build and validation commands', () => {
      // Spec: FR-3, FR-4, Testing and Definition of Done
      const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
        files: string[];
      };

      expect(packageJson.scripts['build:macos']).toBeTruthy();
      expect(packageJson.scripts['test:macos']).toBeTruthy();
      expect(packageJson.scripts['validate:omarchy']).toBeTruthy();
      expect(packageJson.files).toEqual(
        expect.arrayContaining(['platforms/macos/dist', 'integrations/omarchy']),
      );
    });

    it('FR-2: documents automatic install, status, uninstall and data preservation', () => {
      // Spec: FR-2, US-1/AC-5
      const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
      expect(readme).toContain('pimpampum install');
      expect(readme).toContain('pimpampum status');
      expect(readme).toContain('pimpampum uninstall');
      expect(readme).toContain('preserve');
      expect(readme).toContain('Omarchy Quattro');
      expect(readme).toContain('unsigned');
    });
  });
});
