# Summary: Omarchy Quattro live-test preflight

**Date**: 2026-08-27
**Type**: Bug Fix / Release Engineering
**Branch**: `develop`
**Scope**: 4 implementation/contract files changed, +16/-3 lines, plus this summary

---

## What Changed

### Remote release preparation

- Merged all completed V1 work into the default `master` branch through PRs `#1` and `#2`.
- Made `.github/workflows/release.yml` visible and active from the default branch.
- Preserved the release boundary: no `v1.0.0` tag was created and nothing was published to npm.

### Self-contained Quattro smoke

- Changed `test:e2e:omarchy:live` to run `npm run build` before the real native runner.
- Added clean-checkout instructions to the README.
- Updated the acceptance test and its frozen contract hash.

### Verification

- Passed 414 tests with 100% statement, branch, function, and line coverage.
- Passed 6 compiled E2E scenarios and 32 Omarchy-specific tests.
- Passed the desktop contract, npm audit with zero vulnerabilities, and npm package dry-run.
- Passed final Linux and macOS GitHub Actions on `master` commit `c898ffe1cf0b9963a888f82bb17acbb5b329fb21`.
- Re-cloned that commit from GitHub and verified `npm ci`, build, Omarchy plugin validation, desktop contract, and the exact live-script value.

## Why

The release gate must be executable on a clean target machine without relying on artifacts left by earlier development commands. Building inside the opt-in npm script makes the documented Quattro flow deterministic and reduces the user procedure to clone, install dependencies, and run the smoke.

## Decisions Made

| Decision                              | Rationale                                                                             | Alternative Considered                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Build inside the live npm script      | A clean checkout has no `dist/` and should require no hidden step                     | Tell the tester to remember a separate build command |
| Retain the real Quattro evidence gate | Omarchy support should be based on observed native behavior                           | Remove the gate and ship from fixtures alone         |
| Merge via reviewed CI-backed PRs      | Leaves an auditable remote history and validates both target build lanes              | Push directly to `master`                            |
| Keep the release tag absent           | Tag creation immediately starts signing, npm publication, and GitHub Release creation | Create the tag before native evidence exists         |

## What's Pending

- [ ] Run `PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live` on a clean Omarchy Quattro machine.
- [ ] Commit the generated live evidence and screenshots.
- [ ] Re-run the release gates and authorize creation of `v1.0.0`.

## Quality Status

| Check                     | Status                        |
| ------------------------- | ----------------------------- |
| typecheck, lint, format   | ✅                            |
| tests and coverage        | ✅ — 414 tests, 100% coverage |
| compiled E2E              | ✅ — 6 tests                  |
| Omarchy validation/tests  | ✅ — 32 tests                 |
| desktop contract          | ✅                            |
| npm audit                 | ✅ — 0 vulnerabilities        |
| npm package dry-run       | ✅                            |
| GitHub Linux CI           | ✅                            |
| GitHub macOS CI           | ✅                            |
| clean remote clone        | ✅                            |
| real Quattro native smoke | Pending target machine        |
