# Lessons: Zero-Friction Local Agent Setup

**Date**: 2026-08-31
**Outcome**: Approved by post-review and released as `v1.2.9`

## What Worked

- Freezing the Tests-as-DoD suite before implementation kept the product contract stable while the
  runtime, connectors, coordinator, native surfaces, and release pipeline changed underneath it.
- Keeping invariants behind transaction boundaries made service promotion, setup compensation,
  connector ownership, and removal testable under hostile filesystem and process failures.
- Comparing reviewed Omarchy pins with the exact Linux archives produced by native runners before
  tagging eliminated the gap between locally reviewed bytes and publicly downloadable bytes.
- Exercising the exact signed and notarized macOS artifact proved the real app-owned runtime,
  daemon, MCP launcher, host connections, and cleanup path rather than a source-tree approximation.

## Difficult Parts

- A signed app-owned runtime needs a private writable home under `launchd`; inheriting the app or
  runner environment is not sufficient for native modules and service startup.
- Setup and service lifecycle locks can self-deadlock when nested operations reacquire the same
  ownership boundary. The coordinator must own one lock and call lock-free internal operations.
- The under-two-minute promise belongs to the first verified agent. The exhaustive lifecycle smoke
  is intentionally broader and therefore runs outside that user-facing timing measurement.
- Cross-target archives built on macOS are useful development evidence, but their hashes cannot pin
  Linux release artifacts. Native runner output is authoritative.
- Post-review found three gaps after the first publication: an exit-zero Omarchy disconnect without
  a verified postcondition, a Codex disconnect without verification/rollback, and base setup
  compensation that swallowed rollback failures. Regression tests now cover all three.

## Reusable Rules

- A command exiting successfully is not a domain postcondition. Re-read observable state and verify
  that the requested mutation actually happened.
- A failed rollback is durable state, not a warning to discard. Aggregate compensation failures and
  keep the journal incomplete until repair succeeds.
- Release consumers must pin the exact bytes they download. Generate, compare, and approve those
  bytes before creating a public tag.
- Connector mutations must remain ownership-aware and reversible; unknown entries are conflicts,
  never implicit permission to replace user configuration.

## Review Result

Architecture post-review passed after the three rollback/disconnect fixes. The Swift filesystem
detector remains a read-only, protocol-isolated discovery implementation and is not a mutation
boundary violation. No agent-instruction update is required: the prevention is encoded in tests and
CI, while `AGENTS.md` already requires domain invariants to remain in `PimpampumStore`.
