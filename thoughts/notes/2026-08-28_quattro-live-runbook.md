# Runbook: Quattro live smoke

> Opt-in since 2026-08-28: this session is no longer required for a release. Run it when you
> want a recorded, attested real-machine session; see `2026-08-28_quattro-gate-removed.md`.

The runner is interactive and human-owned. Read this before starting; an abort restores the
Omarchy baseline but discards the whole review session.

## Two terminals

**T1** runs the smoke. Touch it only to press Enter and answer the two final questions.

```bash
cd ~/Work/pimpampum
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
```

**T2** drives the CLI against the smoke's isolated daemon. As soon as T1 has started:

```bash
export PIMPAMPUM_DATA_DIR=$(ls -d /tmp/pimpampum-quattro-live-*/data)
cd ~/Work/pimpampum
alias pp="node dist/cli.js"
pp overview
```

If `pp overview` fails, stop: nothing below can be driven without that connection.

Never edit `shell.json` or the QML by hand. Theme and bar layout change through the Omarchy UI;
every data-backed state comes from the public CLI. The runner seeds the baseline data itself
(workspace, two projects, Specs, one task, claims).

## Phase 0: the matrix, before the first capture

The first prompt (`activePopout`) is the end of this phase, not the beginning. Exercise
everything here first, then press Enter.

Counters `7`, `42`, `99+`, with `SPEC` the active Spec id from `pp overview`:

```bash
SPEC=<id>
for i in $(seq 1 7); do
  T=$(pp task:create $SPEC "load $i" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  pp work:start task $T agent-$i
done
```

Check the bar reads 7; continue to 42, then past 100 for `99+`. Release every claim with
`pp work:release task <id> <agent>` and confirm zero is hidden.

Project states: `pp project:draft`, `project:open`, `project:pause`, `project:complete`.

`credentials`: overwrite `$PIMPAMPUM_DATA_DIR/token` with junk, watch the widget report rejected
credentials, then restore the original token.

Backup, four states:

```bash
pp backup status --json                     # unconfigured
pp backup configure ~/tmp-backup            # healthy (backing-up is the transient in between)
pp backup configure /proc/impossible        # failed
pp backup retry --json
pp backup disable --json
```

Sync:

```bash
pp sync configure ~/tmp-sync --device quattro
pp sync now --json ; pp sync pause --json ; pp sync resume --json
mv ~/tmp-sync ~/tmp-sync.gone               # unavailable; move it back afterwards
pp sync forget --json
```

`conflicted` needs two device identities against the same shared folder: configure with
`--device a`, make a change, `sync forget`, configure the same folder with `--device b`, make a
conflicting change, `sync now`, then `pp sync conflicts --json`.

Not required live: `incompatible`, `importing`, `exporting`. See
`2026-08-28_quattro-live-matrix.md`.

Themes and layouts through the Omarchy UI: light and dark, horizontal and vertical. In every
combination the circle-p mark keeps its shape; only the external accent carries state.

## The five captures

Build the state, look at it, then press Enter in T1.

| Capture           | What to show                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activePopout`    | Horizontal bar. Open the popout; hover a project, focus it with the keyboard, activate it.                                                                                                             |
| `completedPopout` | Switch to the vertical bar and the other theme. Completed project collapsed, expand it to see long content, collapse it again. Open the Backup disclosure. Restore layout and theme before continuing. |
| `offlineStale`    | The runner stops the service. Stale/offline state; the mark must not become an x, exclamation mark, or wifi glyph.                                                                                     |
| `recovered`       | The runner restarts the service. Live content, no stale message.                                                                                                                                       |
| `workspaceOpen`   | Mouse and keyboard activation, then open the workspace from the project row.                                                                                                                           |

Before the end, also navigate portfolio to Settings inside the same popout, return with the
keyboard, and confirm no competing Quattro popout opens.

## Closing

The runner shows the five captures with their hashes and asks for a reviewer name, then for
`yes`. An empty name is asked again; it is never accepted. Type `yes` only if every live item was
actually observed. Anything else is reported as a decline by name, exits 1 after restoring the
baseline, and writes no evidence, which is the correct outcome for a partial session.

Do not press Enter through the capture prompts. Each capture is taken the moment you press Enter,
of whatever is on screen at that moment; five captures ten seconds apart of the same terminal are
worthless, and approving them would bind false evidence to the release.

Ctrl+C at any point restores the baseline, writes `.quattro-live-failure-*.json` next to the
evidence, and exits 130.
