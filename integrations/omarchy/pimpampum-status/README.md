# Pimpampum Status for Omarchy Quattro

This native `bar-widget` gives Omarchy Quattro a compact view of the single
Pimpampum instance running for the current user. It shows semantic
project health, active-claim count, active work, available work, and a collapsed
completed-project group. Selecting a project opens its registered workspace
root with `xdg-open`. Its Backup disclosure configures the daemon's one
automatic backup destination, so macOS, Quattro, the CLI, and the API all see
the same setting.

The integration targets the Quattro plugin contract pinned at Omarchy commit
`0ae1694830b6bd9511042fe1b89a0062d8c083cb`. Waybar is not supported.

## Status UX

The compact identity is always the same theme-tinted circle containing a lowercase `p`. State stays
external through badge shape/accent, tooltip, popout copy, and an optional active-claim count. Zero
is hidden and values above 99 display as `99+`; offline and error states never replace the mark.

Clicking opens one bounded 380-unit native `PopupCard`, ordered as connection state, Active work,
Projects, Completed, then the collapsed Backup disclosure. Horizontal bars place mark and count
side by side; vertical bars stack them. Project rows open the exact registered workspace root.

## Security boundary

- The widget launches the installed `pimpampum-overview` helper by absolute
  path. During installation Pimpampum binds that receipt-owned helper to the
  canonical Node, CLI, data-directory, host, and port configuration.
  Authentication remains inside the CLI and no bearer token enters QML,
  settings, or process arguments.
- Backup actions launch the separate receipt-owned `pimpampum-backup` helper.
  It accepts only `status`, `configure <absolute-directory>`, `retry`, and
  `disable`, delegates to the canonical JSON CLI contract, and passes the
  selected directory as one process argument. No token enters QML.
- Workspace paths are accepted only when absolute and are passed to `xdg-open`
  as one argument. They are never evaluated as shell source.
- The UI exposes no project, task, claim, or service mutation. Its only write is
  the daemon-owned automatic backup preference.
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
installed overview and backup helpers do not depend on the graphical session's
`PATH`.

## Backup settings

Open the Pimpampum popout and expand **Backup**. When the Qt folder dialog is
available, **Choose…** opens it. The absolute-path field and **Save** remain as
a portable fallback. **Open** launches the configured directory through
`xdg-open`, **Back Up Now** retries immediately, and **Disable** stops future
automatic refreshes without deleting the existing snapshot.

The live SQLite database remains local. Only `pimpampum-latest.sqlite` is
written to the selected directory, which may be inside Dropbox, Google Drive,
or another synchronized folder. Configuration errors and backup health are
reported inline; a failed backup never invalidates the project mutation that
triggered it.

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
come from the real machine. The reviewer must directly observe this matrix:

- The same `assets/pimpampum-compact.svg` fixed circle-p identity, tinted with
  the inherited foreground, in every state. Only the external accent and shape
  communicate state; offline, credentials, and incompatible states never
  replace the mark with an x, exclamation mark, or network glyph.
- Horizontal side-by-side and vertical stacked bar layouts, with counts `7`,
  `42`, and `99+`; zero is hidden and negative input is clamped to zero.
- Light and dark themes; complete, available, active/draft, empty, offline,
  stale, credentials, and incompatible states.
- Hover, visible keyboard focus, and activation where Quickshell supports them;
  bounded scrolling, long-name disambiguation, completed expansion/collapse,
  and safe workspace opening.
- Backup collapsed, unconfigured, healthy, backing-up, and failed presentations;
  folder-dialog and manual absolute-path selection; and serialized configure,
  retry, and disable actions.

Use only supported Omarchy controls to change bar position or theme, and restore
the original selection before the runner continues. Do not edit `shell.json` or
QML to manufacture a state. Exercise data-backed states through Pimpampum's
public CLI/API only. If any matrix item was not actually observed, the reviewer
must decline approval rather than infer it from static validation.

The schema-v2 artifact remains deliberately stable: five canonical screenshots
bind the active popout, completed collapse, stale/offline state, recovery, and
workspace opening to their command transcript and hashes. The broader matrix is
included in the approval binding and interactive review prompt without adding
unverifiable authored flags or breaking existing evidence consumers.

The live runner is destructive only to the temporary Pimpampum installation it
creates. It refuses to run over an existing installation, records exact
argument-array transcripts, and emits no passing evidence unless uninstall
restores the captured baseline. The visual phase remains human-owned; the named
reviewer inspects the staged captures and directly exercises the matrix above.

No real `quattro-live.json` currently exists. The only external-host clue is an SSH alias named
`factory`, and it is ambiguous whether that alias is the intended Quattro machine. Confirm the
target, then run the exact opt-in workflow above from a full checkout. Fixtures, static validation,
and `quattro-live.example.json` are not live evidence.
