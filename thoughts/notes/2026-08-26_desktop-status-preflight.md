# Desktop Status Integration Preflight

**Date**: 2026-08-26

## macOS build host

- macOS 26.5.2, build 25F84, arm64.
- Swift 6.3.3.
- Xcode 26.6, build 17F113.
- `swiftc` available at `/usr/bin/swiftc`.

## Omarchy Quattro contract

The Quattro contract is pinned to upstream commit `0ae1694830b6bd9511042fe1b89a0062d8c083cb` (the `quattro` branch head observed on 2026-08-26). Its documentation defines:

- A single long-running `omarchy-shell` Quickshell process.
- Third-party plugin roots under `~/.config/omarchy/plugins/<plugin-id>/`.
- Manifest schema version 1.
- `bar-widget` entry points declared through `entryPoints.barWidget`.
- Official validation through `omarchy plugin validate <path>`.
- Enablement through `omarchy plugin enable <id>`.
- Native bar properties for foreground, background, urgent color, font, position, orientation, size, tooltip coordination, and popout coordination.
- User `shell.json` is canonical after customization and must not be edited by the Pimpampum installer.

Pinned primary references and SHA-256 snapshots:

- [`shell/README.md`](https://github.com/basecamp/omarchy/blob/0ae1694830b6bd9511042fe1b89a0062d8c083cb/shell/README.md): `e946c56db6ee1c6f31deb6429e777c9854da8d42ab8e72a1687d3c5f85cfc654`
- [`docs/omarchy-shell.md`](https://github.com/basecamp/omarchy/blob/0ae1694830b6bd9511042fe1b89a0062d8c083cb/docs/omarchy-shell.md): `7868ad487f349d773e0ff8eb41191e0fa28669ef1d3a0349e2dbfe12e6dc0d08`
- [`shell/plugins/bar/README.md`](https://github.com/basecamp/omarchy/blob/0ae1694830b6bd9511042fe1b89a0062d8c083cb/shell/plugins/bar/README.md): `3eca71f2301478f269f88108b51f48640b048d28716d8e8a3926415ea22cc632`

## Live validation boundary

The current build host does not provide `omarchy` or `systemctl`. Static contract validation can run here. The exact installed Quattro version and live UI smoke must be captured on the target Linux machine before Task 4.4 is complete.

This is an explicit environment gate, not missing local preflight work:

- Phase 0 freezes the current official schema/command contract and representative shared fixtures.
- Task 4.4 records `omarchy --version`, verifies `omarchy plugin validate --help`, validates the staged candidate, and performs the live UI smoke on Quattro.
- Phase 5 cannot pass without that Task 4.4 evidence. `npm run check:quattro-evidence` validates the machine-readable evidence and `loop.manifest.yaml` stops at the human-owned `live-quattro` phase until it passes. No version or live result may be inferred from documentation.

## Frozen shared fixtures

The language-neutral contract fixtures are:

- `test/fixtures/overview/empty.json`
- `test/fixtures/overview/mixed.json`
- `test/fixtures/overview/complete.json`
- `test/fixtures/overview/invalid.json`

Their SHA-256 values are recorded in `thoughts/tests/2026-08-26_desktop-status-integrations.md`. TypeScript, Swift, and QML validation must consume copies of these exact payloads or verify copied fixture hashes.
