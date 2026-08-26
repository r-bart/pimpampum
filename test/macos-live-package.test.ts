import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = join(process.cwd(), 'scripts/macos-live-package.mjs');
const roots: string[] = [];

type Dependencies = {
  prepare(): void;
  pack(): { filename: string };
  install(pack: { filename: string }): string;
  restore(): void;
};

async function helper(): Promise<{
  prepareMacosRuntimePackage(dependencies: Dependencies): string;
}> {
  return (await import(pathToFileURL(helperPath).href)) as {
    prepareMacosRuntimePackage(dependencies: Dependencies): string;
  };
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-macos-live-package-${label}-`));
  roots.push(root);
  const manifest = join(root, 'package.json');
  const backup = join(root, '.pimpampum-package.repository.json');
  const original = '{\n  "name": "pimpampum",\n  "scripts": { "test": "vitest" }\n}\n';
  writeFileSync(manifest, original);
  const dependencies: Dependencies = {
    prepare() {
      writeFileSync(backup, readFileSync(manifest), { flag: 'wx' });
      writeFileSync(manifest, '{"name":"pimpampum","scripts":{"start":"node dist/daemon.js"}}\n');
    },
    pack() {
      return { filename: 'pimpampum.tgz' };
    },
    install(pack) {
      return pack.filename;
    },
    restore() {
      if (existsSync(backup)) renameSync(backup, manifest);
    },
  };
  return { manifest, backup, original, dependencies };
}

function expectRestored(state: ReturnType<typeof fixture>): void {
  expect(readFileSync(state.manifest, 'utf8')).toBe(state.original);
  expect(existsSync(state.backup)).toBe(false);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('macOS live runtime package transaction', () => {
  it('restores the byte-identical repository manifest after success', async () => {
    const state = fixture('success');
    const { prepareMacosRuntimePackage } = await helper();
    expect(prepareMacosRuntimePackage(state.dependencies)).toBe('pimpampum.tgz');
    expectRestored(state);
  });

  for (const phase of ['prepare', 'pack', 'install'] as const) {
    it(`restores the byte-identical repository manifest after ${phase} failure`, async () => {
      const state = fixture(phase);
      const { prepareMacosRuntimePackage } = await helper();
      const primary = new Error(`${phase} failed`);
      state.dependencies[phase] = () => {
        throw primary;
      };
      let caught: unknown;
      try {
        prepareMacosRuntimePackage(state.dependencies);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(primary);
      expectRestored(state);
    });
  }

  it('reports restoration failure without masking the primary failure', async () => {
    const state = fixture('dual-failure');
    const { prepareMacosRuntimePackage } = await helper();
    const primary = new Error('pack failed');
    const restoration = new Error('restore failed');
    state.dependencies.pack = () => {
      throw primary;
    };
    state.dependencies.restore = () => {
      throw restoration;
    };
    let caught: unknown;
    try {
      prepareMacosRuntimePackage(state.dependencies);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBe(primary);
    expect((caught as AggregateError).errors).toEqual([primary, restoration]);
  });

  it('surfaces a restoration-only failure', async () => {
    const state = fixture('restore-failure');
    const { prepareMacosRuntimePackage } = await helper();
    const restoration = new Error('restore failed');
    state.dependencies.restore = () => {
      throw restoration;
    };
    expect(() => prepareMacosRuntimePackage(state.dependencies)).toThrow(restoration);
  });
});
