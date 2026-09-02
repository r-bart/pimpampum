/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 *
 * These tests encode the spec's acceptance criteria as executable assertions. Each test names the
 * spec items it covers; a test changes only together with the spec item it names. Source-text
 * assertions over Swift, QML and the README were retired on 2026-09-02 (H-13): the negative
 * security checks live in test/source-contract.test.ts, the Swift suites and
 * scripts/validate-omarchy-plugin.mjs observe the rest.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createHttpApp } from '../src/http.js';
import { runCli, type CliRuntime } from '../src/cliProgram.js';
import { renderLaunchAgent } from '../src/service/launchd.js';
import { renderSystemdUnit } from '../src/service/systemd.js';
import { PimpampumStore } from '../src/store.js';
import { parsePlist, parseSystemdUnit, type PlistDictionary } from './helpers/serviceArtifacts.js';

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
    it('FR-2/macOS: renders a LaunchAgent that restarts on failure without the bearer token', () => {
      // Spec: US-1/AC-2, US-1/AC-3, FR-2, Security
      const plist = parsePlist(
        renderLaunchAgent({
          nodePath: '/opt/pimpampum runtime/bin/node',
          cliPath: '/opt/pimpampum/dist/cli.js',
          dataDirectory: '/Users/roberto/Pimpampum Data',
          host: '127.0.0.1',
          port: 7337,
          logDirectory: '/Users/roberto/Pimpampum Data/logs',
        }),
      );

      expect(plist.Label).toBe('dev.pimpampum.daemon');
      expect(plist.ProgramArguments).toEqual([
        '/opt/pimpampum runtime/bin/node',
        '/opt/pimpampum/dist/cli.js',
        'serve',
      ]);
      expect(plist.RunAtLoad).toBe(true);
      // Restart after an abnormal exit only; a stop requested by the lifecycle must stay stopped.
      expect(plist.KeepAlive).toEqual({ SuccessfulExit: false });
      expect(plist.ThrottleInterval).toBe(5);
      const environment = plist.EnvironmentVariables as PlistDictionary;
      expect(Object.keys(environment).sort()).toEqual([
        'PIMPAMPUM_DATA_DIR',
        'PIMPAMPUM_HOST',
        'PIMPAMPUM_PORT',
      ]);
      expect(environment.PIMPAMPUM_HOST).toBe('127.0.0.1');
      expect(JSON.stringify(plist)).not.toMatch(/PIMPAMPUM_TOKEN|Bearer/u);
    });

    it('FR-2/Linux: renders a non-root systemd user service with failure backoff', () => {
      // Spec: US-1/AC-2, US-1/AC-3, FR-2, Security
      const unit = parseSystemdUnit(
        renderSystemdUnit({
          nodePath: '/home/dev/Pimpampum Runtime/bin/node',
          cliPath: '/home/dev/pimpampum/dist/cli.js',
          dataDirectory: '/home/dev/Pimpampum Data',
          host: '127.0.0.1',
          port: 7337,
        }),
      );

      expect(unit.Service?.Restart).toEqual(['on-failure']);
      expect(unit.Service?.RestartSec).toEqual(['5s']);
      expect(unit.Service?.ExecStart).toEqual([
        '"/home/dev/Pimpampum Runtime/bin/node" "/home/dev/pimpampum/dist/cli.js" serve',
      ]);
      // A user unit: no `User=` setting, installed into the user's default target.
      expect(unit.Service?.User).toBeUndefined();
      expect(unit.Install?.WantedBy).toEqual(['default.target']);
      expect(unit.Service?.Environment).toEqual([
        '"PIMPAMPUM_DATA_DIR=/home/dev/Pimpampum Data"',
        '"PIMPAMPUM_HOST=127.0.0.1"',
        '"PIMPAMPUM_PORT=7337"',
      ]);
    });
  });

  describe('FR-3 and FR-4: native status surfaces', () => {
    it('FR-3: declares a menu-bar-only application in its bundle manifest', () => {
      // Spec: FR-3. MenuBarExtra, SMAppService and the read-only popover are covered by the Swift
      // suites (LoginItemManagerTests, StatusPopoverTests) and the live smoke's noDockIcon check.
      const info = parsePlist(
        readFileSync(join(process.cwd(), 'platforms/macos/Resources/Info.plist'), 'utf8'),
      );
      expect(info.CFBundleIdentifier).toBe('dev.pimpampum.menubar');
      expect(info.LSUIElement).toBe(true);
    });

    it('FR-4: ships a valid dedicated Omarchy Quattro bar-widget manifest', () => {
      // Spec: FR-4. scripts/validate-omarchy-plugin.mjs, run by test/omarchy-plugin.test.ts,
      // checks the QML entry point, popout coordination and terminal disclosures.
      const manifest = JSON.parse(
        readFileSync(
          join(process.cwd(), 'integrations/omarchy/pimpampum-status/manifest.json'),
          'utf8',
        ),
      ) as {
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
  });

  describe('Packaging', () => {
    it('FR-3/FR-4: defines native build and validation commands and keeps the app out of npm', () => {
      // Spec: FR-3, FR-4, Testing and Definition of Done
      const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
        files: string[];
      };

      expect(packageJson.scripts['build:macos']).toBeTruthy();
      expect(packageJson.scripts['test:macos']).toBeTruthy();
      expect(packageJson.scripts['validate:omarchy']).toBeTruthy();
      // Amendment 2026-09-01 (review H-12): the macOS app ships only as a GitHub Release asset,
      // never inside the npm package; the Omarchy plugin still does.
      expect(packageJson.files).toEqual(expect.arrayContaining(['integrations/omarchy']));
      expect(packageJson.files).not.toContain('platforms/macos/dist');
    });
  });
});
