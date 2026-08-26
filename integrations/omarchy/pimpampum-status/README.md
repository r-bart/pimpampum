# Pimpampum Status for Omarchy Quattro

This native `bar-widget` gives Omarchy Quattro a compact, read-only view of the
single Pimpampum instance running for the current user. It shows semantic
project health, active-claim count, active work, available work, and a collapsed
completed-project group. Selecting a project opens its registered workspace
root with `xdg-open`.

The integration targets the Quattro plugin contract pinned at Omarchy commit
`0ae1694830b6bd9511042fe1b89a0062d8c083cb`. Waybar is not supported.

## Security boundary

- The widget launches the installed `pimpampum-overview` helper by absolute
  path. During installation Pimpampum binds that receipt-owned helper to the
  canonical Node, CLI, data-directory, host, and port configuration.
  Authentication remains inside the CLI and no bearer token enters QML,
  settings, or process arguments.
- Workspace paths are accepted only when absolute and are passed to `xdg-open`
  as one argument. They are never evaluated as shell source.
- The UI can refresh, expand sections, and reveal directories. It exposes no
  project, task, claim, or service mutation.
- Plugin installation, ownership checks, lifecycle locking, rollback, status,
  and removal are owned by the same `pimpampum` CLI lifecycle.

## Install

Run the single automatic lifecycle command on the Quattro machine:

```bash
pimpampum install
```

`pimpampum install` detects Quattro, installs the user service and plugin under
one lifecycle lock, validates the staged candidate with `omarchy plugin
validate`, asks `omarchy-shell` to rescan, and enables it with the official
plugin command. It never reads or edits `shell.json` directly. A failed
installation restores the previous owned state and leaves unrelated plugins
alone.

The repository-local `install.sh` remains only as a convenience wrapper. It
executes `pimpampum install`; it does not own a second installation path. The
installed overview helper does not depend on the graphical session's `PATH`.

## Remove

```bash
pimpampum uninstall
```

Removal uses the same receipt and lifecycle lock, delegates plugin removal to
the official Omarchy command, and then removes only the exact backup path that
command created for the receipt-owned plugin. Existing backups, unrelated
plugins, and Pimpampum data are preserved. The pinned Quattro contract's
`listShellConfig` IPC method captures only this widget's section, index, and
inline settings before removal. If a later step fails, `enablePlugin` and
`setBarWidget` restore that exact entry without direct `shell.json` access or
changes to unrelated layout entries. The repository-local `uninstall.sh` is an
equivalent thin wrapper around `pimpampum uninstall`.

## Validation

The packaged cross-platform validator can run on macOS or Linux:

```bash
npm run validate:omarchy
```

The following release workflow requires a full source checkout and is intentionally not included
in the published runtime tarball. On the target machine, run:

```bash
omarchy --version
omarchy plugin validate ./integrations/omarchy/pimpampum-status
npm run build
PIMPAMPUM_QUATTRO_LIVE=1 npm run test:e2e:omarchy:live
npm run test:e2e:omarchy
```

Static validation does not prove live Quattro behavior. Release evidence must
come from the real machine and cover hot reload, theme inheritance, horizontal
and vertical layouts, popout coordination, offline recovery, completed-project
collapse, active counts, and directory reveal. The live runner is deliberately
destructive only to the temporary Pimpampum installation it creates: it refuses
to run over an existing installation, records exact argument-array transcripts,
and emits no passing evidence unless uninstall restores the captured baseline.
The visual phase remains human-owned; the reviewer must inspect and approve the
captured screenshots rather than replacing visual judgment with authored flags.
