# The Quattro live matrix is no longer a release gate

Decision taken 2026-08-28 by the project owner, after the first real attempt at the session.

## What the gate was

`release.yml` ran `npm run check:quattro-evidence` before signing or publishing anything. That
checker requires `thoughts/evidence/quattro-live.json`, which only the interactive runner
(`PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live`) can produce: it installs the plugin on
a real Omarchy Quattro machine, has a named person build ten matrix states and five canonical
captures by hand, and writes the evidence only after cleanup restores the exact baseline.

The file had never existed. Every V1 plan since 2026-08-25 listed it as the open item.

## Why it was removed

- The session costs 30-45 attended minutes per release candidate, and any product change after
  it invalidates it. The first real attempt produced five captures of a terminal window and a
  declined review; the runner defects it exposed are fixed (#4, #5), but the cost is intrinsic.
- The widget's actual user is the project owner, on the target machine, daily. For a personal
  project that is stronger ongoing evidence than one attested snapshot per tag.
- The GitHub Actions budget is finite and each evidence commit costs a validation run.

## What stays

- The runner, the checker, the matrix, and the runbook remain in the repository unchanged. Anyone
  can still record an attested session, and `npm run check:quattro-evidence` still verifies one.
- Static validation of the plugin (`validate:omarchy`), the 33 Omarchy tests, and the frozen
  desktop contract remain in `quality.yml` and in the release `validate` job.
- The macOS live smoke remains a release step, because `release.yml` runs it unattended on its
  own macOS runner and regenerates the artifact approval there.

## What this does not mean

It does not mean fixtures count as live evidence. When `quattro-live.json` exists it must still
come from the real workflow; the checker's rules are untouched. The gate is gone; the standard
for what counts as evidence is not.
