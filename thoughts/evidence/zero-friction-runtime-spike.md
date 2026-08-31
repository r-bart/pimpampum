# Zero-friction private runtime spike

**Date**: 2026-08-31  
**Plan task**: 0.2 — Prove the private runtime payload  
**Host**: macOS Darwin 25.6.0, arm64  
**Pinned runtime**: Node.js 24.19.0  
**Pimpampum**: 1.1.3, `better-sqlite3` 13.0.3

## Verdict

The private runtime-directory approach is feasible on the available `darwin-arm64` host. A
payload containing an absolute private Node binary, compiled `dist`, production-only dependencies,
and one matching `better-sqlite3` prebuild passed version, SQLite, daemon, HTTP health, MCP
initialization, and MCP tool-listing smokes with an empty external `PATH`.

Candidate `linux-x64` and `linux-arm64` payloads were built from checksum-verified official Node
archives and contain matching ELF Node/addon pairs. They could not be executed on this host:
Docker is installed but its daemon is not running, and no QEMU user-mode executable is available.
Consequently, Task 0.2 is **proved for `darwin-arm64` and structurally evidenced, but not runtime
proved, for the two Linux targets**. Gate 0's requirement that every target open SQLite and
initialize MCP remains open until target-native CI or machines run the same smokes.

The bounded SEA attempt confirms that SEA should not replace the runtime directory for V1. The
current ESM entrypoint does not run directly as an injected SEA main script, the dependency graph
would first need bundling/loader work, and `better-sqlite3` would require asset extraction plus an
explicit `process.dlopen()` path. This is materially more complex than the successful directory
payload.

## Candidate construction

All artifacts were built under `tmp/runtime-spike/`; production source and frozen tests were not
modified. The spike:

1. Compiled with `tsc -p tsconfig.build.json --outDir tmp/runtime-spike/app/dist`.
2. Installed the lockfile's production graph with
   `npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix tmp/runtime-spike/app`.
3. Downloaded official Node 24.19.0 `.tar.xz` archives and verified the selected lines from
   `SHASUMS256.txt` with `shasum -a 256 -c`.
4. Copied only `bin/node`, the Node license, compiled application, package manifest, and pruned
   production dependencies into each candidate.
5. Removed `better-sqlite3` sources/build inputs and every nonmatching prebuild. The final
   candidate trees contain no symlinks and exactly one `.node` prebuild each.
6. Created gzip tar archives for measurement. These are throwaway spike archives, not deterministic
   or release-ready artifacts/manifests.

Official Node archive verification:

| Target         | Official archive SHA-256                                           | Result |
| -------------- | ------------------------------------------------------------------ | ------ |
| `darwin-arm64` | `3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94` | PASS   |
| `linux-x64`    | `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647` | PASS   |
| `linux-arm64`  | `01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc` | PASS   |

The production dependency roots resolved to the four MCP packages at 2.0.0,
`better-sqlite3@13.0.3`, `express@5.2.1`, and `zod@4.4.3` (89 installed packages in total).

## Size

Sizes include the private Node binary, Node license, application, and pruned production
dependencies. macOS `du -sk` supplies allocated unpacked size; compressed size is exact archive
bytes.

| Target         |               Compressed |                 Unpacked | Files | Symlinks | Matching addon |
| -------------- | -----------------------: | -----------------------: | ----: | -------: | -------------- |
| `darwin-arm64` | 43.31 MiB (45,418,253 B) | 147.88 MiB (151,424 KiB) | 2,497 |        0 | Mach-O arm64   |
| `linux-x64`    | 48.46 MiB (50,812,422 B) | 152.58 MiB (156,240 KiB) | 2,497 |        0 | ELF x86-64     |
| `linux-arm64`  | 48.12 MiB (50,460,842 B) | 148.70 MiB (152,264 KiB) | 2,497 |        0 | ELF aarch64    |

These measurements support a conservative V1 manifest cap of **175 MiB unpacked per target**,
leaving roughly 15% headroom over the largest observed candidate. The eventual release build
should fail rather than silently raise that cap.

## Native `darwin-arm64` smokes

Runtime commands used the payload's absolute `bin/node` with `env -i`, `PATH=''`, a synthetic
`HOME`, and a data directory under the spike. No external Node or npm participated at runtime.

| Smoke                   | Result | Evidence                                                                                          |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| Version                 | PASS   | One JSON envelope reported `pimpampum` 1.1.3.                                                     |
| Direct native addon     | PASS   | `better-sqlite3` opened `:memory:`, created/inserted/selected a row (`{"nativeAddon":"ok"}`).     |
| Database open/migration | PASS   | The daemon created `pimpampum.sqlite`; a read-only reopen reported `user_version=2` and 8 tables. |
| Serve                   | PASS   | The private CLI started on loopback and remained alive until `SIGTERM`.                           |
| HTTP health             | PASS   | `GET /health` returned `{"status":"ok","version":"1.1.3"}`.                                       |
| MCP initialize          | PASS   | stdio client negotiated server `{name: "pimpampum", version: "1.1.3"}`.                           |
| MCP tool listing        | PASS   | 32 tools returned, including `project_list` and `work_start`.                                     |

The MCP smoke launched the stdio bridge using the same private Node executable while the daemon
was running and closed the client/bridge normally afterward.

## Startup measurements

`/usr/bin/time -p` measured eleven separate `pimpampum version` processes. The first execution of
the newly downloaded/extracted Node binary took **1.67 s**. Ten subsequent processes were
`0.18, 0.18, 0.18, 0.21, 0.20, 0.20, 0.17, 0.18, 0.18, 0.18 s`, with a **0.18 s median**. A daemon
process reached successful loopback `/health` in **429 ms**.

The 1.67 s figure is the first observed execution after payload construction, not a controlled
disk-cache purge, so it is directional cold-start evidence. The health polling interval was 10 ms;
the serve measurement includes process launch, module loading, token/database creation or reopen,
migrations, and HTTP readiness.

## Signing observation

`codesign --verify --strict` accepted both native binaries in the throwaway tree. Detailed identity
inspection showed:

- Official Node: Developer ID Application, Node.js Foundation (`HX7739G8FX`), hardened-runtime
  flag present.
- `better-sqlite3` prebuild: ad hoc/linker-signed only, with no team identifier.

The release pipeline must therefore sign the target `.node` addon (and any other nested native
code) with the product identity before signing/notarizing the outer macOS app. Copying the official
Node signature alone is insufficient as release-signing evidence.

## Cross-target limitation and required closure

`file` identified the Linux candidates as:

- `linux-x64`: Node ELF x86-64 with `/lib64/ld-linux-x86-64.so.2`; addon ELF x86-64.
- `linux-arm64`: Node ELF aarch64 with `/lib/ld-linux-aarch64.so.1`; addon ELF aarch64.

This proves target matching, not runtime compatibility. Before Gate 0 closes, native or CI runners
for both Linux architectures must, from the extracted candidate with no system Node/npm in `PATH`,
repeat version, direct addon, daemon/database migration, HTTP health, stdio initialize, and tool
listing. They must also capture distro/glibc compatibility on the supported Omarchy baseline.

## Bounded SEA attempt

The spike used Node 24.19.0's `--experimental-sea-config`, `postject@1.0.0-alpha.6`, a copy of the
official Node binary, and the current compiled `dist/cli.js` as the injected main script. Injection
succeeded after removing the copied binary's original signature; the experiment then applied an ad
hoc signature. Running `pimpampum-sea version` exited 1 at `import.meta.url` with
`SyntaxError: Cannot use 'import.meta' outside a module`, because the injected main was treated as
CommonJS.

That is the intended stopping point. Supporting the current app would require a bundling/entrypoint
rewrite before reaching its dependency graph. Node's current
[SEA documentation](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)
labels the feature Stability 1.1 (active development) and requires a bundled native addon to be
written to a temporary file and loaded with `process.dlopen()`. It also documents a Linux arm64
container injection caveat that can crash during addon loading. The SEA copy lost the official Node
signature during injection and had only an ad hoc signature afterward, demonstrating an additional
target-specific release-signing step.

**SEA conclusion**: technically investigable, but not a V1 distribution candidate without a
separate approved plan for bundling, secure native-addon extraction/lifecycle, per-target creation,
and signing/notarization. Continue with the private versioned runtime directory.

## Gate status

- `darwin-arm64` private runtime payload: **PASS**.
- Runtime size and startup measurements: **RECORDED**.
- SEA feasibility decision: **STOP / retain Option A**.
- `linux-x64` SQLite/HTTP/MCP runtime smoke: **PENDING target-native runner**.
- `linux-arm64` SQLite/HTTP/MCP runtime smoke: **PENDING target-native runner**.

Task 0.2 provides positive implementation evidence but does not by itself satisfy the plan's
all-target Gate 0 line.
