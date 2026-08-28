# Pimpampum Status for Omarchy Quattro

This native `bar-widget` gives Omarchy Quattro a compact view of the single
Pimpampum instance running for the current user. It shows semantic
project health, active-claim count, active work, specs in progress, available work, and a collapsed
completed-spec group. Selecting a project or spec opens its registered workspace root with
`xdg-open`. Settings contains separate Synchronization and Backup cards. Help is a dedicated page
opened from the persistent footer.

The integration targets the Quattro plugin contract pinned at Omarchy commit
`0ae1694830b6bd9511042fe1b89a0062d8c083cb`. Waybar is not supported.

## Status UX

The compact identity is always the same theme-tinted circle containing a lowercase `p`. State stays
external through badge shape/accent, tooltip, popout copy, and an optional active-claim count. Zero
is hidden and values above 99 display as `99+`; offline and error states never replace the mark.

Clicking opens one bounded 380-unit native `PopupCard`. Its Portfolio view is ordered as connection
state, Active work, Specs in progress, Projects, and collapsed Completed specs. Active work names
the claimed task plus its project, Spec, agent, and lease; in-progress Specs remain visible without
an active claim and show completed versus total tasks. **Settings** switches the same card to a
dedicated second view showing Synchronization and Backup controls directly, without nested
disclosures. The fixed footer opens Help on the left and stops or starts Pimpampum on the right. A
44-unit vector header icon opens Settings and changes to a back arrow on internal pages, without
opening a competing Quattro popout.
Horizontal bars place mark and count side by side;
vertical bars stack them. Project rows open the exact registered workspace root.

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
- Synchronization actions use the bounded `pimpampum-sync` helper. It derives a safe device ID from
  the hostname and accepts only status, configure, sync-now, pause, resume, conflict-list, and forget.
- Service actions use the bounded `pimpampum-service` helper. It accepts only status, start, stop,
  and restart for the fixed `pimpampum.service` systemd user unit; it accepts no user-controlled
  service name or shell input. Stopping the daemon leaves the Quickshell widget installed so the
  user can start it again without a terminal.
- Workspace paths are accepted only when absolute and are passed to `xdg-open`
  as one argument. They are never evaluated as shell source.
- The UI exposes no project, task, or claim mutation. Its writes are limited to the fixed service
  lifecycle and daemon-owned synchronization and automatic-backup preferences.
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

Open **Settings** in the Pimpampum popout and use the **Backup** card. **Choose backup
destination…** opens the native GTK directory picker. If the picker is unavailable, the card points
to the bounded Pimpampum CLI instead of exposing a second path-entry implementation. **Open** launches the configured directory through
`xdg-open`, **Back Up Now** retries immediately, and **Disable** stops future
automatic refreshes without deleting the existing snapshot.

The live SQLite database remains local. Only `pimpampum-latest.sqlite` is
written to the selected directory, which may be inside Dropbox, Google Drive,
or another synchronized folder. Configuration errors and backup health are
reported inline; a failed backup never invalidates the project mutation that
triggered it.

## Synchronization settings

Open **Settings** and use the **Synchronization** card to exchange portfolio state with other computers.
Choose a location already synchronized by Dropbox, Syncthing, Google Drive through a mounted
filesystem, or a similar provider. Selection alone does not enable synchronization: the widget
previews the effective destination and explains that existing snapshots may be imported before the
user confirms **Enable synchronization**.

Pimpampum creates or reuses a `Pimpampum` child inside the selected location, unless that location
is already named `Pimpampum`. It shows the effective path and derived device identity after setup.
**Sync now**, pause/resume, shared-folder opening, and forgetting remain explicit actions. Forgetting
removes only this computer's setting; it does not delete local portfolio data or shared snapshots.
Conflicts remain visible and require inspection outside the compact widget before resolution.

Synchronization and backup are deliberately separate. Synchronization exchanges path-neutral JSON
portfolio snapshots between computers. Automatic backup writes `pimpampum-latest.sqlite` for local
recovery and never acts as a merge transport.

## Service controls

The final card in **Settings** shows whether the Pimpampum daemon is running. **Restart service**
restarts only the background daemon. **Stop Pimpampum…** requires confirmation and stops agents,
synchronization, and automatic backups without deleting local data or removing the widget. While
stopped, the same card exposes **Start Pimpampum**, so no launcher entry or terminal command is
required to recover.

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
omarchy version
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
  bounded scrolling with a fixed footer, long-name disambiguation, in-progress Spec progress,
  completed-Spec expansion/collapse, safe workspace opening, Help, and Quit/Start.
- Backup unconfigured, healthy, backing-up, and failed presentations; native folder selection;
  destination preview; explicit enable/disable confirmation; and serialized configure, retry, and
  disable actions.
- Synchronization unconfigured, healthy, pending, importing, exporting, paused,
  unavailable, failed, and conflicted presentations; provider-location selection and effective
  `Pimpampum` destination preview; explicit enable/forget confirmation; device identity, timestamps,
  pending count, open-folder, sync-now, and pause/resume actions. If the native picker dependency is
  unavailable, the UI points to the bounded CLI instead of exposing a duplicate path form.

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

`quattro-live.json` must be generated by the exact opt-in workflow above from a full checkout on the
target machine. Fixtures, static validation, failure transcripts, and `quattro-live.example.json`
are not live evidence.
