# macOS npm onboarding decision

## Chosen direction: Quiet handoff

The macOS menu bar app will show a single, calm setup surface when it cannot find a local
installation receipt. The popover keeps the native 360-point container, system typography and
macOS material, then uses one strong action, one verification action and a compact command card.

The setup command is:

```sh
npm install --global pimpampum && pimpampum install --service-only
```

The primary action copies the command and opens Terminal. It never types or executes the command
for the user. Both setup actions also register the downloaded app with macOS Login Items; approval
or registration failures remain recoverable from a visible notice in the normal status view. The
secondary action refreshes the local overview immediately, while the existing five-second
open-popover poll moves the app into its normal status view as soon as setup succeeds.

The setup surface is reserved for a missing installation receipt. Temporary network or daemon
failures continue to use the existing offline presentation, so users are not sent through setup
again for a transient failure.

## Rejected directions

- **Three beats** made the relationship between app, service and agents explicit, but added
  vertical ceremony to a one-command task and weakened the primary action.
- **Assisted setup** exposed diagnostics and recovery paths earlier, but introduced more branching,
  copy and maintenance than a first-run surface needs. Its diagnostic ideas remain useful for a
  future repair flow.

The decision was made from the temporary prototype at
`.codex/prototypes/npm-onboarding/index.html`. That prototype is deleted after the production
implementation is verified.
