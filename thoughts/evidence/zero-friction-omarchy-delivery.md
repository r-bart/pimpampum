# Zero-friction Omarchy delivery evidence

**Plan task**: 0.4 — Prove the Omarchy delivery channel  
**Captured**: 2026-08-31  
**Decision**: **GO** for the plugin-pinned release-asset design. Keep the documented
`pimpampum-bin` package as a fallback only if the live Omarchy target matrix later proves that
GitHub release assets are unreachable.

## Official lifecycle contract

The contract was inspected from the official `basecamp/omarchy` repository at exact `quattro`
commit [`b686ed892d9c3020c3336203f6d34cc75b544e2b`](https://github.com/basecamp/omarchy/tree/b686ed892d9c3020c3336203f6d34cc75b544e2b)
(2026-08-30). The current stable tag `v4.0.2` resolves to
`346e69e1cec6c4e8924531874af6ba010a1bc99e` and contains byte-identical blobs for the five lifecycle
commands and the plugin manual used here.

The official manual specifies the following lifecycle:

1. `omarchy plugin add <git-url> [--enable]`: clone into a hidden user-owned staging directory,
   validate, reject an existing ID, then move to `~/.config/omarchy/plugins/<id>`.
2. `omarchy plugin validate <folder>`: require schema version 1, safe relative entry points, the
   declared entry point for every kind, and no symlinks outside `.git`.
3. `omarchy plugin enable <id>`: persist enabled state through the shell IPC and optionally place a
   bar widget.
4. `omarchy plugin update <id>`: fetch and fast-forward only; validate the updated checkout and
   hard-roll back if validation fails.
5. `omarchy plugin remove <id>`: disable first, delete a Git-managed checkout, unlink a symlink, or
   preserve a handmade directory as a timestamped backup.

Primary sources:

- [Official Shell Plugins manual, pinned](https://github.com/basecamp/omarchy/blob/b686ed892d9c3020c3336203f6d34cc75b544e2b/manual/32-shell-plugins.md#adding-a-plugin-from-git)
- [`omarchy-plugin-add`, pinned](https://github.com/basecamp/omarchy/blob/b686ed892d9c3020c3336203f6d34cc75b544e2b/bin/omarchy-plugin-add)
- [`omarchy-plugin-validate`, pinned](https://github.com/basecamp/omarchy/blob/b686ed892d9c3020c3336203f6d34cc75b544e2b/bin/omarchy-plugin-validate)
- [`omarchy-plugin-update`, pinned](https://github.com/basecamp/omarchy/blob/b686ed892d9c3020c3336203f6d34cc75b544e2b/bin/omarchy-plugin-update)
- [`omarchy-plugin-remove`, pinned](https://github.com/basecamp/omarchy/blob/b686ed892d9c3020c3336203f6d34cc75b544e2b/bin/omarchy-plugin-remove)

The official installer explicitly does **not** run plugin code, install hooks, or `sudo`. This is a
useful security boundary, but it also means the plugin install itself cannot install the private
runtime. The enabled widget must explicitly invoke a reviewed plugin-local bootstrap helper. After
setup commits, QML should use only receipt-owned helpers by absolute path.

SHA-256 of the exact official command copies used by the proof:

| Command                   | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `omarchy-plugin-add`      | `fc8eb1486275e308037ca8f284fbb0eb4e010dec593260519695c79414a4b9fb` |
| `omarchy-plugin-enable`   | `750c18dd96dd75e4811215e3fd13f71f5a11aff8e588b4e21688cdc5dd7c62b5` |
| `omarchy-plugin-update`   | `9509f925d230863ffd5246965cbaab87818c53c718bcc5deea68bea3a38a17c4` |
| `omarchy-plugin-remove`   | `ea4e4462ab75b28f249d5e03c03890a1821fd9f095346df34bcb431b2c1e3cc2` |
| `omarchy-plugin-validate` | `f7507e5042eb970e3dc918bdf6bf251c7557443892a77e71a17d7019ddde72c8` |

## Local lifecycle proof

The throwaway harness staged at `tmp/zero-friction-omarchy/run-lifecycle-proof.sh` executed the
exact official scripts above against a local bare Git remote, with bounded stubs only for Omarchy
shell IPC/catalog discovery. The fixture included an `install.sh` that would leave a marker if
executed. Throwaway files were removed after capture so repository-wide format checks do not scan
the cloned upstream repository.

Observed result:

```text
add+validate+enable PASS
fast-forward update+validate PASS
disable+remove PASS
```

The install-hook marker remained absent after add, enable, update, and remove. The checked-in
Pimpampum plugin also passes both the exact official validator and the repository validator:

```text
omarchy-plugin-validate integrations/omarchy/pimpampum-status  # PASS
npm run validate:omarchy                                      # PASS
```

On this macOS proof host, `add --enable` as a single invocation hits an empty-array behavior in the
host's legacy Bash 3.2. The harness therefore runs the same official add and enable commands
separately. Omarchy/Arch supplies modern Bash; the native-target command remains part of the live
matrix below.

## Bounded bootstrap proof

The candidate helper was isolated at `tmp/zero-friction-omarchy/pimpampum-bootstrap-spike`; it was
not production code and was removed after capture. Its SHA-256 was
`ed4fdf0088d1e4407dd7e25c32e81c52caf3dab7a03fa9a7178cbba552ff1619`. Its local HTTP fixture used
the exact release path:

```text
/releases/download/v1.1.3/pimpampum-runtime-1.1.3-linux-arm64.tar.gz
```

The helper:

- maps only `x86_64` to `linux-x64` and `aarch64`/`arm64` to `linux-arm64`;
- accepts only the exact `v<manifest.version>` asset filename for the selected target, never
  `latest`;
- requires a lowercase 64-character SHA-256 and verifies downloaded bytes before listing or
  extracting;
- applies curl connection, total-time, and maximum-download-size bounds, then checks actual bytes;
- caps archive entry count and unpacked size;
- rejects absolute paths, `..` traversal, symlinks, devices, and unsupported archive entry types;
- extracts with no same-owner/permission restoration into a private same-filesystem `mktemp`
  staging directory;
- checks embedded version and target markers, smokes the staged control entry point, and only then
  atomically renames it into the per-user XDG data root;
- refuses UID 0 and contains no `sudo`, `eval`, npm, Node, or shell-string execution dependency.

The throwaway bootstrap harness produced:

```text
exact-tag+SHA+rootless install PASS
wrong hash rejection PASS
oversize rejection PASS
path traversal rejection PASS
wrong architecture rejection PASS
no sudo/eval/npm dependency PASS
```

Every negative case left the final runtime directory absent. The traversal fixture contains a
literal `../escape` archive member, and no escape file was created. The successful rootless case
wrote only under its synthetic `$XDG_DATA_HOME/pimpampum/runtime`.

The current network could fetch pinned official source and follow an existing Pimpampum GitHub
release-asset redirect successfully (`HTTP 200`). This proves the chosen hosting route exists, not
that every Omarchy network can reach it.

## Threat boundary carried into Task 4.1

The production bootstrap should retain all spike properties and additionally use the strict
TypeScript runtime manifest/archive verifier from Phase 1 rather than depending solely on shell
listing semantics. The plugin repository revision authenticates the checked-in manifest; that
manifest pins the exact release tag, target-specific URL, archive SHA-256, and byte ceilings. A
mutable branch or the release server alone must never choose a version.

Do not add an install hook: Omarchy intentionally will not run it. The Guided widget should invoke
the plugin-local bootstrap, and the bootstrap should transition to a receipt-owned absolute helper
after the coordinator commits.

## Native-target limitations and remaining live gate

This host is Darwin arm64, not Omarchy/Arch Linux. Docker is installed but no Linux daemon was
available. Therefore this spike does **not** claim:

- a native `linux-x64` or `linux-arm64` runtime/addon smoke;
- a real `omarchy plugin add ... --enable` against a running `omarchy-shell`/Quickshell session;
- target-network reachability to GitHub release assets;
- behavior under a native read-only XDG target, interrupted network, or Quickshell restart.

Those belong to Tasks 0.2, 4.1, and the Omarchy live test. Run on both supported architectures:

```bash
omarchy plugin add <pinned Pimpampum plugin repository> --enable --yes
scripts/test-omarchy-live.mjs
```

The live test must use the final signed/hashed target asset with external Node/npm absent, test
offline/interrupted/read-only failures, and verify that the daemon survives Quickshell restart. If
both representative Omarchy targets cannot reach the release asset origin under normal network
policy, stop Phase 4 and switch to one documented `pimpampum-bin` dependency instead of adding an
unbounded mirror or `latest` fallback.
