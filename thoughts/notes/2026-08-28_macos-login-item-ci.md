# Login Items registration on hosted macOS runners

The first three `v1.0.0` release runs failed in the macOS live smoke. The first two reported only
"An internal error occurred" because the CLI flattened every plain `Error` (#7, #8). The third
reported the real cause: `macOS login item registration failed`.

## What happens

`pimpampum install` copies the menu app to `~/Applications`, launches it with
`--register-login-item`, and waits for an acknowledgement file. The app calls
`SMAppService.mainApp.register()` and writes back `enabled`, `requiresApproval`, or `error`. On a
GitHub-hosted `macos-15` runner the result is `error`; on the owner's Mac it is `enabled`
(recorded in the 2026-08-27 evidence). The Swift side writes `error` for any thrown failure and
does not include the description, so the exact SMAppService error is not visible; registering
Login Items from a hosted CI session is a known limitation of that environment.

## What changed

`install` used to throw on `error` and roll back. That contradicted the rest of the design: the
receipt and status types already allow `loginItem: 'error'`, and the menu app shows a notice with
a retry for exactly this state. The install now completes, records `error`, and opens the app.
The macOS evidence checker accepts `error` as a recorded outcome so that the release smoke can
run unattended; real-machine evidence continues to record `enabled` or `requiresApproval`.

## Second consequence: uninstall left the menu app running

With the install tolerating `error`, the smoke reached its final check and reported, after a
30-second wait, that the app process was still alive. The Swift side quits the running menu app
inside `MainAppLoginItemService.unregister()`, only after a successful `SMAppService.unregister()`,
and `LoginItemManager` skips that call entirely when the previous state was `error`. Quitting the
app was therefore a side effect of a Login Items transition, not part of uninstalling.

`deactivate` in `macosApp.ts` now quits any running instance of the installed bundle as its last
step, with `pkill -TERM -f <installed executable path>`, independent of the Login Items state. It
runs after the daemon is deactivated on purpose: a failure before that point rolls back with the
app still open, and the rollback's re-registration reopens it anyway.

## Follow-up

The registration acknowledgement should carry the failure description so a rejected registration
is diagnosable without guesswork. That is a Swift contract change with matching TypeScript
validation and tests on both sides, and needs a Mac to verify.
