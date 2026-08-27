# Desktop design decisions

## Omarchy service controls

**Date**: 2026-08-27  
**Prototype**: `prototypes/stop-service` (removed after promotion)

- Chosen direction: **Service card** at the end of Settings.
- The card shows Running/Stopped, explains the background impact, and exposes Restart plus a
  confirmed Stop action.
- When stopped, the same card promotes a full-width Start Pimpampum action so recovery never
  requires a launcher entry or terminal.
- Rejected Quiet footer: visually restrained, but hid Restart and made lifecycle status easier to
  overlook.
- Rejected Action menu: compact, but buried the recovery model behind an overflow control.
