# First-run decoder, onboarding step machine, and installed launcher

**Date**: 2026-09-01
**Type**: Bug fix + UX change
**Branch**: `develop`

## What happened

A clean install of the published `v1.2.10` showed "Setup required" with the guided panel stuck on
`3 OF 3` and the message "Pimpampum returned an invalid setup response". Three independent defects
were stacked on top of each other. All six CI checks and the live macOS smoke had passed.

## The three defects

### A. The decoder assumed one event per line

`SetupNDJSONDecoder` split stdout on `\n` and required valid JSON on every line. `setup plan` and
`setup status` have no `--events` mode, so they always leave the CLI through `printEnvelope`, which
writes `JSON.stringify(value, null, 2)` — an indented object spanning many lines. The first line is
`{`, which is not valid JSON, so every call threw `.invalidResponse`.

The decoder already had heuristics for the `{data: …}` envelope (`requiresConfirmation` means plan,
`data: null` means an empty journal). It was designed to accept that shape and only ever tested with
it compacted onto one line, which the CLI never produces.

### B. `resume()` announced a mutation before reading the journal

`SetupStore.start()` always calls `resume()`. That method set `activity = .resuming` on its first
line, before `runner.status()` told it whether anything was running. `.resuming` is
`hasBegunMutation`, and `SetupOnboardingView.showDurableProgressIfNeeded()` moves to the final step
on that flag and never moves back. On a clean machine the onboarding jumped straight to the install
screen over a service nothing had begun to install.

A hid B: while the decoder threw, the error banner covered a panel that was already on the wrong
step.

### C. The installed launcher could not run status or uninstall

`manager.status()` and `manager.uninstall()` called `adapter.artifacts(context)`, and the macOS
adapter planned by reading the app bundle out of the build tree. An installed CLI runs from the
packaged runtime, where that path does not exist, so both commands failed with
`internal_error: Build the macOS app before installing Pimpampum`. Uninstalling through the
documented launcher was impossible.

Status also read all 2490 bundle files (149 MB) and discarded every byte, because
`artifactSetIsCurrent` hashes the _installed_ file and compares it to the receipt.

## Why the gates missed all three

- Swift tests fed the decoder hand-compacted envelopes (`{"data":{…}}` on one line) that the CLI
  never emits. No test crossed real CLI output with the real decoder.
- `DesktopSmokeLogic` covers presentation and rendering only. The live macOS smoke never executes
  `setup plan` or `setup status` against the packaged CLI.
- `check-swift-coverage.sh` reports 100%, but its manifest excludes `SetupStore.swift`,
  `SetupCommandRunner.swift`, and `SetupOnboardingView.swift`. The number said nothing about any of
  the code that broke.
- Every live verification ran from the build tree, where the bundle exists, so C could not appear.

## Patterns worth keeping

- **A gate's number only covers what its manifest lists.** Read the manifest before trusting 100%.
- **When a fix removes an error message, look at what the message was covering.** Defect B was
  visible in the very first screenshot and was read as part of A.
- **Verify from the installed artifact, not the build tree.** C only exists outside the checkout.
- **A test that constructs its own input in a shape the producer never emits is not an integration
  test.** It pins the decoder against itself.

## Still open

- No test crosses real CLI output with the real Swift decoder. The new tests use fixtures copied
  from real output, so a future CLI format change would pass them again.
- With `canPlanArtifacts` false, status no longer detects that the planned artifact set drifted from
  the installed one. It verifies the receipt against disk instead. On an installed macOS CLI there
  is no source to compare against, so nothing was lost there, but the guarantee is weaker than on
  Linux.

## Second review pass, same day

Three further defects surfaced once the first three were fixed and the flow could actually be
walked end to end.

### D. The confirmation screen showed prose, not the plan

`SetupChange.path` existed in both the TypeScript and Swift models and was **always null**, and the
macOS screen rendered a hand-written constant. The spec already required the opposite under
Functional Requirements: "Advanced users can inspect the planned paths and operations before
confirmation." The coordinator now fills `path` from the resolved layout, a `data` change discloses
the local database, and the view renders `store.plan.changes`.

### E. The plan was computed after the user confirmed

`reviewAndSetUp()` called `store.review()` inside the button handler, so the operation id and
revision the user authorized did not exist when they pressed it. The plan is now requested with
`.task(id: store.selectedAgents)` when the step appears and whenever the selection changes, so the
applied operation is the one on screen.

### F. A Mac with no detected agent could not install anything

`canReview` required a non-empty selection. With nothing detected the confirmation button stayed
disabled forever, which contradicts the success metric "successful setup with no supported agents:
100%" and the EC-1 acceptance test the coordinator already passes. A Swift test asserted the broken
behaviour, so it was encoding the bug.

Detection made this worse: `containsRegularItem` rejected symlinks, and both agent CLIs install as
links into `~/.local/bin`. Codex could never be detected on a standard machine.

## Pattern

Four of these six defects were **specified correctly and implemented differently**, and every gate
stayed green because the tests asserted the implementation rather than the spec. A test that
freezes current behaviour cannot detect that the behaviour is wrong.

## Third pass: the gate itself

Nine defects in one session, every one of them in a file `check-swift-coverage.sh` does not
measure, while the gate reported 100%. Measured coverage of the excluded logic files:

| File                           | Regions                                   |
| ------------------------------ | ----------------------------------------- |
| `SetupModels.swift`            | 13.5% → **100%**, now inside the manifest |
| `SetupCommandRunner.swift`     | 64%                                       |
| `SetupStore.swift`             | 56%                                       |
| `EmbeddedSetupBootstrap.swift` | 62%                                       |
| `EmbeddedRuntimeLocator.swift` | 80%                                       |

`SetupModels.swift` was covered and added to the manifest because both `hasBegunMutation` and
`needsAttention` live there, and both caused a defect this session. The remaining four are the next
candidates; they are larger and covering them honestly is its own piece of work, not something to
bolt on at the end of a session.

### Two more defects, found by review rather than by tests

- **The relauncher duplicated the app.** `createsNewApplicationInstance = true` was unconditional,
  and login-item registration completes four phases earlier, so macOS may already have started the
  installed copy. Two menu-bar apps then share one popover and one shows stale state.
- **`.sheet` closes a menu-bar popover.** Both help dialogs used one. A sheet is a real window and
  the popover closes on losing key focus. The fix is to render help inside the popover; there is now
  no `.sheet` left in the app.

### The honest summary of the session

Six of the nine defects were specified correctly and implemented differently. Two were introduced
while fixing the others. Every gate stayed green throughout, because the tests asserted the
implementation and the coverage gate measured the wrong files.

## Fourth pass: the install location itself

Walking the flow end to end surfaced a last group of defects, all of them consequences of the app
existing in two places at once.

- **Two menu-bar icons.** Installation copied the app to `~/Applications` even when the user had
  already put it in an Applications folder, and registering the login item made macOS start that
  second copy. Setup now adopts a bundle already sitting in `/Applications` or `~/Applications`: it
  copies nothing, owns no file inside it, and registers the copy that is there. Uninstalling
  therefore leaves the app for the user to drag to the Trash, like any other macOS app. A bundle
  running from Downloads or a mounted image is still copied, because that one can vanish.
- **`open -W` waited on the wrong process.** Once the adopted app and the unregistration helper are
  the same bundle, `-W` blocked on the running menu-bar app and reported failure for work that had
  succeeded. Unregistration now polls for its acknowledgement file, exactly as registration does.
- **The installed CLI did not know where the app was.** It runs from the packaged runtime with no
  bundle to inspect, so it assumed the managed path and launched a helper that no longer existed:
  `pimpampum-control uninstall` failed while the same command from the bundle worked. Installation
  records the path in `~/.pimpampum/application-path.json` and uninstall removes it.
- **A second instance still started.** macOS starts the app when the login item is registered, and
  with adoption that is the same bundle already running. The app now stands down at launch when an
  older copy of itself is running. Unknown or tied launch dates keep the newcomer alive, because the
  opposite error leaves the menu bar with no app at all.
- **The final step went by unread.** `reviewAndSetUp` called `onFinished` as soon as apply
  succeeded, so the outcome flashed past and the popover jumped to its normal state. The step keeps
  its own Done button; closing is the user's call.

### Layout

Every step sized itself to its own content, so the popover resized between steps and the primary
button slid out from under the pointer. All steps now share a 320pt floor, and the welcome step
distributes the spare height instead of piling it under the button.

The confirmation list became one line: the spec still requires the planned changes and their paths
to be inspectable before confirming, so the full list moved behind the help sheet rather than
disappearing.
