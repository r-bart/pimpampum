/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 *
 * These tests encode the spec's acceptance criteria as executable assertions. Each test names the
 * spec items it covers; a test changes only together with the spec item it names. The source-text
 * assertions this file carried were retired on 2026-09-02 (H-13): the negative security checks
 * live in test/source-contract.test.ts; the copy, layout and symbol checks were removed because
 * the Swift suites, scripts/validate-omarchy-plugin.mjs, test/omarchy-bootstrap.test.ts and
 * test/omarchy-connections.test.ts observe that behaviour.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pluginSource = join(process.cwd(), 'integrations/omarchy/pimpampum-status');

describe('Native zero-friction distribution surfaces', () => {
  it('SEC-7: Omarchy pins an exact target asset and checksum instead of latest', () => {
    // Spec: FR-1.1, FR-1.4, SEC-6, SEC-7
    const manifest = JSON.parse(
      readFileSync(join(pluginSource, 'runtime-manifest.json'), 'utf8'),
    ) as {
      version: string;
      targets: Record<string, { url: string; sha256: string; maximumBytes: number }>;
    };

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u);
    expect(Object.keys(manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
    for (const target of Object.values(manifest.targets)) {
      expect(target.url).not.toMatch(/\/latest\/|latest\.tar/iu);
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(target.maximumBytes).toBeGreaterThan(0);
    }
  });

  it('SEC-8: the plugin bootstrap ships as an executable helper', () => {
    // Spec: FR-1.2, SEC-8 (its bounded download and archive checks: test/omarchy-bootstrap.test.ts)
    expect(statSync(join(pluginSource, 'pimpampum-bootstrap')).mode & 0o111).not.toBe(0);
  });

  it.todo('SEC-7: proves a no-Node Omarchy bootstrap on every supported target architecture');
  // Spec: SEC-7, FR-1.2, Success metric: external Node/npm requirement

  it.todo('EC-14: proves completed connections survive a live Quickshell restart');
  // Spec: EC-14, PERF-6
});
