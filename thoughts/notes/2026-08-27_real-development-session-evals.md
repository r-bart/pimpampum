# Notes: Real Development Session Evals

**Date**: 2026-08-27
**Feature**: Deterministic real development-session E2E

## What Worked Well

1. Defining “real” at deterministic system boundaries produced meaningful coverage without making
   CI depend on a model, network, or credentials: separate processes, compiled MCP HTTP, real files,
   a real test runner, and real Git commits.
2. Tests-as-Definition-of-Done made the process/session evidence explicit before the runner existed.
3. Keeping product state, repositories, Git identity, and artifacts under one temporary root made
   cleanup and evidence verification straightforward.
4. Checking artifact commits externally respected the domain decision that Markdown and artifact
   references remain opaque stored content.

## What Was Difficult

1. A temporary repository is not isolated merely because its files and `user.name`/`user.email` are
   local. Git can still inherit system/global hooks, templates, signing, filters, attributes, and
   environment overrides.
2. Documentation that says “exact source bytes” must be backed by full equality, not a substring
   assertion.
3. The original eval document mixed deterministic gate membership with complementary focused tests;
   command names and rubrics need literal one-to-one mapping.

## Patterns Discovered

### Pattern: Controlled Git Eval Environment

For every Git-driven test process:

- Remove inherited `GIT_*` variables.
- Set `GIT_CONFIG_NOSYSTEM=1` and `GIT_ATTR_NOSYSTEM=1`.
- Point `GIT_CONFIG_GLOBAL` at an empty file inside the temporary root.
- Point `GIT_TEMPLATE_DIR` at an empty directory inside the temporary root.
- Set `GIT_TERMINAL_PROMPT=0`.
- Initialize with the explicit empty template and configure identity repository-locally.
- Pass the same controlled environment to every child session and every verification command.
- Do not replace or repurpose the user's `HOME`.

Use this pattern whenever a test creates commits, checks artifacts, or claims filesystem isolation.

### Pattern: Literal Eval Contract

`npm run test:evals`, its README summary, and `docs/evals.md` should enumerate the same executable
scenarios. Broader unit/acceptance/integration coverage belongs in a clearly separate section.

## Post-Review Correction

The first review correctly rejected the feature because Git still inherited host configuration and
the final implementation check used substring matching. The PRD and generated test contract were
updated, Git isolation was implemented and validated against deliberately hostile inherited
variables, exact byte equality was added, and all quality gates were rerun.
