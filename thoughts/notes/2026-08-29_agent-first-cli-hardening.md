# Agent-first CLI hardening

Date: 2026-08-29

Follow-up to the CLI audit. Seven of eight findings were implemented; two decisions were taken
deliberately and are recorded here so they are not re-opened without new information.

## Decision 1: the CLI entry point is a total bootstrap

`src/version.ts` reads `package.json` at module load. Because ES module imports are evaluated
before any application code runs, a failure there escaped the previous `main().catch(...)` and left
a raw Node stack trace on stderr. Measured, not assumed:

```
$ node dist/cli.js health          # with a manifest that declares no version
node:fs:484 ... Error: ENOENT ...  # unparseable
```

Rejected options:

- **Leave it.** The failure is unreachable in any installation npm can produce, but it is not the
  only import-time failure: a missing dependency or a broken native binding behaves the same way.
- **Hardcode the version and pin it with a test.** Removes the runtime read but adds release
  discipline. `.github/workflows/release.yml` already gates the tag against `package.json`, so the
  manifest is the authoritative source and a second copy would be a footgun.
- **Generate the version at build time.** Real codegen machinery for one constant.

Chosen: `src/cli.ts` is now a bootstrap that imports nothing from the application at module scope
and loads `src/cliMain.ts` dynamically. Every startup failure is now one `{"error": ...}` envelope
with `details.phase: "startup"` and a suggestion that names reinstalling, not reading daemon logs.
This fixes the version case and every other module-graph failure at once.

`runCliEntrypoint` takes the entry module URL as a parameter rather than using its own, so
`compiledCliPath` still resolves to `dist/cli.js` — the bin target and the file the generated
LaunchAgent and systemd unit invoke. Verified in both compiled and source mode.

`src/cliMain.ts` joins `src/cli.ts`, `src/daemon.ts` and `src/mcpStdio.ts` in the coverage
exclusions: it is entry-point composition, which is what those exclusions already cover.

## Decision 2: no exit-code taxonomy

Errors keep exiting 1. Every failure already carries a stable `code`, a `retryable` boolean and a
`suggestion` on stderr, which is strictly more information than an integer.

Two concrete reasons beyond that:

1. **Collision with the Omarchy helpers.** `pimpampum-backup`, `pimpampum-sync` and
   `pimpampum-service` reserve exit 64 for their own usage errors and 127 for "CLI not found", and
   they `exec` the CLI — so the CLI's exit code becomes the helper's exit code. A CLI exit of 64
   would be indistinguishable from the helper rejecting its own arguments.
2. **No consumer reads one.** Every QML service branches on `exitCode !== 0` and then parses the
   JSON envelope. The live runners require exit 0 exactly. Nothing would benefit.

Revisit only if a real caller needs to branch on a numeric code without parsing stderr. It would
also require amending `thoughts/specs/2026-08-26_agent-first-cli.md` and its frozen acceptance test.

## Decision 3: the MCP registry entry runs `pimpampum mcp`

`server.json` declared `identifier: pimpampum` with a stdio transport. A registry client resolves
that to `npx pimpampum`, which runs the bin matching the package name — the CLI, not the stdio
bridge. The agent would have got a process that does not speak MCP.

The registry schema has no field for selecting a bin. The reference documents this exact case under
"Embedded MCP inside a CLI tool": point at the host package and select the server with
`packageArguments`. So the CLI grew an `mcp` verb that runs the bridge in-process, and `server.json`
now carries `runtimeHint: "npx"` plus a positional `mcp`.

`pimpampum-mcp` stays as its own bin, because a hand-written host config is shorter that way. Both
routes were probed with a real `initialize` frame and both answered.

`mcp` is the second command that writes no `{"data": ...}` envelope, after `help`: its stdout is the
protocol channel, so anything else on it would corrupt the stream. The banner names both.

## What is still unverified

**The Omarchy live runner has never been run against real hardware for this change.** This is the
one real gap. `scripts/test-omarchy-live.mjs` had 15 CLI parse sites converted to `parseCliObject`,
and `scripts/check-quattro-evidence.mjs` — the plugin release gate — gained `cliOutputJson`. Their
unit tests pass, but the fixtures those tests use were updated in the same change, so the tests
confirm internal consistency rather than real behaviour. Run this on a Linux Wayland machine with
Omarchy before trusting the plugin gate:

```
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

The macOS live smoke **was** run, after re-approving the artifact: 27 of 27 behaviours passed on
arm64 macOS, recorded in `thoughts/evidence/macos-live.json`. It declares three manual boundaries it
cannot cover: native `NSOpenPanel` selection and cancellation, light/dark/increased-contrast/enlarged
-text visual review, and the transient pending-backup frame.
