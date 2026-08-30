# Design Specification: Pimpampum Desktop Status Surfaces

**Date:** 2026-08-26  
**Language:** English  
**Status:** Ready for visual design  
**Scope:** macOS menu-bar app and Omarchy Quattro bar widget only  
**Primary user:** A single-machine developer/operator coordinating multiple projects and agents  
**Product posture:** Minimal, local, read-only operational awareness with one small backup-settings exception

---

## 1. Purpose of this document

This is the complete design brief for the two native Pimpampum desktop surfaces. It describes only
what the product needs for version 1. It is intended to be pasted into a design tool and converted
into polished visual mockups without inventing additional product functionality.

The two integrations represent the same single Pimpampum daemon:

- macOS: a menu-bar indicator, compact popover, and small backup-settings window.
- Omarchy Quattro: a bar widget and compact Quickshell popout with an inline Backup section.

Both surfaces are primarily read-only. They show projects, current agent work, availability, daemon
health, and automatic-backup health. They do not become miniature project-management applications.

---

## 2. Product intent

Pimpampum is an agent-first, local project coordinator. A user may have many repositories and
agents working across them, but only one Pimpampum instance on the machine. The desktop surfaces
answer three questions at a glance:

1. Is Pimpampum online and healthy?
2. Is an agent working on anything right now?
3. Which projects have active or available work?

The secondary utility is automatic-backup configuration:

1. Is automatic backup enabled and healthy?
2. Where is the rolling snapshot written?
3. Can the user choose, open, retry, change, or disable that destination?

The UI should feel like a quiet system utility: compact, native, legible, and trustworthy. It should
not feel like Linear, Basecamp, a kanban board, or a dashboard squeezed into a popover.

---

## 3. Non-negotiable scope boundaries

### Included

- A persistent Pimpampum indicator in the macOS menu bar.
- A Pimpampum widget in horizontal and vertical Omarchy Quattro bars.
- A compact status popover on both platforms.
- Global daemon/project status.
- Active-claim counter.
- Active work with project/task, agent, and remaining lease.
- Project rows with workspace disambiguation and work counts.
- Collapsed completed-project group.
- Opening a project's workspace folder.
- Connection, authentication, incompatibility, stale-data, empty, truncation, and reveal errors.
- One daemon-owned automatic-backup destination.
- Native folder selection on macOS.
- Folder dialog when available and absolute-path fallback on Quattro.
- Opening the backup folder.
- Manual backup retry and disabling automatic backup.
- Settings and Quit actions in the macOS popover.

### Excluded

- Creating or editing projects.
- Creating or editing PRDs, context documents, tasks, or subtasks.
- Claiming, renewing, releasing, or completing work.
- A persisted `doing` state. Current work comes only from unexpired agent claims.
- Starting, stopping, or restarting the daemon from these visible surfaces.
- Logs, terminal output, diagnostics browser, or database inspection.
- Notifications.
- Search, filters, sorting controls, tabs, navigation sidebar, or command palette.
- Per-project backup settings.
- Backup history, retention, restore UI, provider accounts, or cloud-provider branding.
- Preferences unrelated to automatic backup.
- Analytics or charts.
- A Dock icon or ordinary application window on macOS.
- Waybar support. The Linux target is Omarchy Quattro/Quickshell only.

If a control or section is not described in this document, it should not appear in the design.

---

## 4. Shared information model

### 4.1 Current work

An unexpired claim is the only representation of work in progress:

```text
unexpired claim = currently being worked on
no unexpired claim = not currently being worked on
```

Never label a task or project as persisted “Doing.” The user-facing section is **Active work**.

### 4.2 Global status precedence

When more than one condition applies, render the first matching state:

1. Connection, authentication, schema, or payload error.
2. One or more active claims.
3. Available work but no active claims.
4. Draft projects only.
5. Every project complete.
6. No projects.

The compact counter is always the number of unexpired active claims, not the number of projects or
tasks. Hide the counter when it is zero.

### 4.3 Global semantic states

| State          | Required label         | Semantic color          | Meaning                                              |
| -------------- | ---------------------- | ----------------------- | ---------------------------------------------------- |
| Loading        | `Loading`              | Neutral                 | No valid response has arrived yet.                   |
| Active         | `Active`               | Blue                    | At least one unexpired claim exists.                 |
| Available      | `Work available`       | Amber                   | Work can be claimed, but nothing is active.          |
| Draft          | `Drafts only`          | Neutral gray            | Projects exist but none is ready/actionable.         |
| Complete       | `All complete`         | Green                   | Every project is complete.                           |
| Empty          | `No projects`          | Neutral gray            | No projects exist.                                   |
| Offline        | `Offline`              | Red                     | No daemon response and no valid cached overview.     |
| Stale          | `Offline — stale data` | Red/neutral combination | Cached overview remains visible but is not current.  |
| Authentication | `Authentication error` | Red                     | Local credentials were rejected or cannot be loaded. |
| Incompatible   | `Incompatible version` | Red                     | The daemon returned an unsupported schema.           |
| Invalid        | `Invalid response`     | Red                     | The integration rejected malformed data.             |

Color is never the only signal. Every state needs a shape, label, or both.

### 4.4 Project semantic states

| State     | Priority | Required visual                | Detail text                                    |
| --------- | -------: | ------------------------------ | ---------------------------------------------- |
| Active    |        1 | Blue active marker             | `N active` and, when non-zero, `· N available` |
| Available |        2 | Amber available marker         | `N available`                                  |
| Draft     |        3 | Neutral outlined/dashed marker | `Draft`                                        |
| Complete  |        4 | Green completion marker        | `Complete · N completed tasks`                 |

A project may have active and available work simultaneously. Its primary state is Active, and both
counts remain visible.

### 4.5 Backup semantic states

| State    | Required label                   | Semantic color | Required action                                         |
| -------- | -------------------------------- | -------------- | ------------------------------------------------------- |
| Loading  | `Loading backup settings…`       | Neutral        | None until loading finishes.                            |
| Disabled | `Automatic backup is off`        | Neutral        | Choose a folder.                                        |
| Pending  | `Backing up…` / `Backup pending` | Amber          | Wait; controls disabled while the request is in flight. |
| Healthy  | `Up to date`                     | Green          | Back Up Now, open, change, or disable.                  |
| Error    | `Backup needs attention`         | Red            | Try Again, open/change destination, or disable.         |

Automatic backup writes one rolling file named `pimpampum-latest.sqlite`. The live database stays
local. Disabling automatic backup does not delete an existing snapshot.

---

## 5. Shared visual principles

### 5.1 Identity must remain constant

The compact bar icon must be recognizably Pimpampum in every state.

- The approved mark is **variant C: one exact circle containing a lowercase `p`**, suitable for a
  14–16 pt menu/bar glyph.
- Preserve that circle-and-`p` silhouette unchanged in every compact state on both platforms.
- It must work as a one-color template icon and remain legible on light and dark backgrounds.
- Do not use Wi-Fi, cloud, database, generic warning, or backup icons as the product identity.
- Do not replace the product mark when the daemon goes offline.
- Express state with a small adjacent/overlaid status shape, semantic color, count, tooltip, and
  detailed copy inside the popover.
- The active-claim count sits beside the mark. It is not baked into the logo.

The design deliverable must include the base mark and its state treatments at actual menu-bar size.

### 5.2 Native, not branded chrome

- macOS should use native vibrancy, materials, typography, controls, traffic lights, focus rings,
  hover behavior, and semantic colors.
- Quattro should inherit the active bar's foreground, background, urgent color, font family,
  position, and size.
- Pimpampum may add semantic blue, amber, and green where needed, but not a parallel theme system.
- Avoid gradients, glass cards inside glass popovers, large illustrations, decorative shadows,
  hero areas, or marketing language.

### 5.3 Density

- Optimize for a glance lasting two to ten seconds.
- Use section spacing and typography before adding boxes.
- Use a tinted container only for actionable warnings and active-work items that need grouping.
- Keep row heights compact but comfortably clickable.
- Do not show raw IDs, token paths, database paths, PRD text, task bodies, or artifacts.

### 5.4 Motion

- No decorative animation.
- Loading may use the platform spinner/progress indicator.
- Opening/closing disclosures uses the platform default transition.
- Status changes may crossfade subtly if the platform provides it naturally.
- Respect reduced-motion settings.

---

## 6. Component inventory

| Component           | macOS                    | Quattro               | Variants                                         |
| ------------------- | ------------------------ | --------------------- | ------------------------------------------------ |
| PimpampumMark       | Menu bar                 | Bar widget            | Base plus status treatment                       |
| ActiveClaimCount    | Menu bar                 | Bar widget            | Hidden, 1 digit, 2+ digits                       |
| GlobalStatusHeader  | Popover                  | Popout                | All global states                                |
| ConnectionNotice    | Popover                  | Popout                | Offline, stale, auth, invalid, incompatible      |
| SummaryBlock        | Popover                  | Optional compact line | Populated, loading, omitted                      |
| ActiveWorkSection   | Popover                  | Popout                | Empty, populated, truncated                      |
| ActiveWorkRow       | Popover                  | Popout                | Project claim, task claim, long content          |
| ProjectsSection     | Popover                  | Popout                | Empty, populated, truncated                      |
| ProjectRow          | Popover                  | Popout                | Active, available, draft, complete, reveal error |
| CompletedDisclosure | Popover                  | Popout                | Collapsed, expanded                              |
| BackupSection       | Separate settings window | Inline disclosure     | Loading, disabled, pending, healthy, error       |
| InlineNotice        | Both                     | Both                  | Information, warning, error                      |
| FooterActions       | Popover                  | Not required          | Quit, Settings                                   |

---

## 7. macOS surface A: menu-bar indicator

### 7.1 Location and footprint

- Native `MenuBarExtra`; no Dock icon.
- Use the standard macOS menu-bar height and alignment.
- The clickable area is the normal macOS menu-extra hit target.
- Content is one fixed Pimpampum mark plus an optional numeric counter.
- Do not place the word `Pimpampum` in the menu bar.
- Do not show an always-visible status word.

### 7.2 Required variants

The mark stays fixed. Apply a compact state treatment:

| State                               | Treatment                                          | Counter                                                                        |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Loading                             | Neutral mark with subtle progress treatment        | Hidden                                                                         |
| Active                              | Blue state accent                                  | Show active-claim count                                                        |
| Available                           | Amber state accent                                 | Hidden                                                                         |
| Draft                               | Neutral subdued state accent                       | Hidden                                                                         |
| Complete                            | Green completion accent                            | Hidden                                                                         |
| Empty                               | Neutral outline/subdued accent                     | Hidden                                                                         |
| Offline/stale                       | Red disconnected/error badge beside the fixed mark | Preserve count only for stale cached data if clearly secondary; otherwise hide |
| Authentication/incompatible/invalid | Red alert badge beside the fixed mark              | Hidden                                                                         |

The offline state must not turn the entire app into a Wi-Fi icon.

### 7.3 Count rules

- Hidden for zero.
- Use monospaced/tabular digits.
- One or two digits display directly.
- For values above the space available, use `99+` rather than expanding indefinitely.
- Keep the count visually secondary to the product mark but clearly readable.

### 7.4 Tooltip and accessibility

- Tooltip/accessibility label format: `Pimpampum: {status label}, {N active claims}`.
- Singular: `1 active claim`.
- Plural and zero: `{N} active claims`.
- Clicking toggles the popover.
- The icon and count form one accessibility element.

---

## 8. macOS surface B: status popover

### 8.1 Container

- Native anchored menu-bar popover/window.
- Width: 360 pt.
- Maximum scrollable body height: approximately 480 pt; header and footer remain visible.
- Background: native regular material.
- Outer shape and shadow: platform default.
- Internal horizontal padding: 16 pt.
- Section spacing: 16 pt.
- Header and footer separated from the body with native 1 px dividers.
- Body scrolls when content exceeds available screen height.

### 8.2 Information order

The order is fixed:

1. Header.
2. Connection/authentication/incompatibility notice, when applicable.
3. Login approval notice, when applicable.
4. Summary.
5. Active work.
6. Projects.
7. Completed-project disclosure.
8. Truncation and folder-reveal errors near the relevant content.
9. Footer with Quit and Settings.

Do not add navigation, tabs, filters, or backup controls to this popover.

### 8.3 Header

Layout:

```text
[fixed Pimpampum mark + state]  Pimpampum                    [How it works]
                                {global status label}
```

- Mark/state and active count use the same component as the menu bar.
- Product name: headline weight.
- Status: caption, secondary color.
- Show an icon-only native `questionmark.circle` button at the trailing edge of the header.
  Its accessibility label and tooltip are `How it works`.
- The button opens a compact native sheet. The sheet explains local operation, PRDs/tasks,
  agent access through MCP/CLI/API, active claims, Finder opening, and backup configuration.
- The sheet contains no onboarding flow or settings and closes with a default `Done` button.
- Do not show a continuously changing data-age counter in the healthy state.
- Freshness belongs in the connection notice only when data is stale or unavailable.

### 8.4 Connection notice

Show only when not fully online.

| Condition            | Title                           | Detail                                             |
| -------------------- | ------------------------------- | -------------------------------------------------- |
| Initial loading      | `Loading overview`              | No detail required.                                |
| Offline, no cache    | `Pimpampum is offline`          | Sanitized connection error, maximum three lines.   |
| Offline, cached data | `Offline — showing stale data`  | Sanitized connection error, maximum three lines.   |
| Invalid credentials  | `Authentication error`          | Actionable local repair message; never show token. |
| Schema mismatch      | `Incompatible overview version` | Actionable version message.                        |

Appearance:

- Compact horizontal notice with leading state icon.
- 10 pt inner padding, 8 pt corner radius.
- Red-tinted background for failures; neutral treatment for loading.
- Title semibold subheadline; detail caption/secondary.
- Do not use modal alerts for these states.

### 8.5 Login approval notice

Show only when macOS requires explicit login-item approval.

- Icon: system login/security symbol.
- Title: `Login approval required`.
- Body: `Allow Pimpampum in Login Items to start it automatically.`
- Action: `Open Login Items Settings`.
- Amber-tinted compact container.
- This notice is unrelated to automatic-backup configuration.

### 8.6 Summary

- Section label: `SUMMARY`, small uppercase semibold secondary text.
- Primary line: `{projects} projects · {active claims} active · {available work} available`.
- Do not expose daemon version or uptime in the user-facing popover.
- Treat the summary line as one accessibility element.

### 8.7 Active work section

- Section label: `ACTIVE WORK`.
- If empty: `No active work` in secondary subheadline text.
- Otherwise, one compact row per unexpired claim.
- Do not add actions to an active-work row.

Active-work row contents:

1. Work title, medium subheadline, maximum two lines.
2. If the claim belongs to a task, project title below it, caption/secondary, one line.
3. Agent ID with a person icon.
4. Remaining lease with a timer icon.

Lease copy:

- `Expired`
- `<1m remaining`
- `Nm remaining`
- `Nh remaining`
- `Nh Nm remaining`

Row treatment:

- 10 pt inner padding.
- 8 pt corner radius.
- Native quaternary/subtle background.
- Agent and timer on one line with approximately 10 pt separation.
- Entire row combines into one accessibility element.

If the API truncates active work, show:

`Active work is truncated. Refine the project set to see more.`

This is informational, not a button.

### 8.8 Projects section

- Section label: `PROJECTS`.
- Incomplete projects appear first, already ordered Active → Available → Draft.
- Completed projects never mix into this primary list.
- If no projects: `No projects yet`.

Each project row is one full-width plain button that opens its workspace root in Finder.

Project row contents:

1. 16 pt fixed-width semantic state marker.
2. Project title, medium subheadline, maximum two lines.
3. `{workspace name} · {project slug}`, caption/secondary, one line.
4. State/count detail, caption-2/secondary.
5. Trailing subtle `open externally`/Finder affordance.

State/count detail:

- Active with available work: `{N} active · {N} available`.
- Active only: `{N} active`.
- Available: `{N} available`.
- Draft: `Draft`.
- Complete: `Complete · {N} completed tasks`.

Interaction:

- Hover highlights the complete row using a native subtle hover treatment.
- Pointer changes appropriately.
- Click/Enter/Space opens the workspace root in Finder.
- Do not expose or open a guessed project subdirectory; use the registered workspace root exactly.
- Accessibility label: `Open {project title} in Finder`.
- Accessibility hint: `Opens workspace {workspace name}`.

If Finder cannot open the path, keep the project visible and show an inline error after the project
section:

- Title: `Workspace could not be opened`.
- Detail: `{project title}: {sanitized error}`.
- No modal alert.

If the API truncates projects, show:

`The project list is truncated. Counts still include every project.`

### 8.9 Completed projects

- Collapsed by default on every app launch.
- Disclosure label: `Completed ({N})`.
- Omit the disclosure when the count is zero.
- Expansion lasts only for the current running session.
- Expanded rows use the same project-row component and Finder interaction.
- Accessibility hint: `Collapsed by default. Expand to show completed projects.`

### 8.10 Empty and unavailable body states

If no compatible authenticated overview is available, replace Summary, Active work, and Projects
with:

- Title: `Status unavailable`.
- Body: `No project data is shown until a compatible authenticated overview is available.`

If overview is valid but contains no workspaces/projects:

- Show normal header and Summary.
- Active work: `No active work`.
- Projects: `No projects yet`.
- Do not show an illustration or large onboarding card.

### 8.11 Footer

Fixed below the scrollable body:

```text
[Quit Pimpampum]                                      [gear Settings…]
```

- Both are plain native buttons.
- `Quit Pimpampum` terminates only the menu-bar application; it does not delete data.
- `Settings…` opens or focuses one real `Pimpampum Settings` window.
- Opening Settings must work even though the app has no Dock icon.
- Repeated Settings clicks focus the same window rather than creating duplicates.

---

## 9. macOS surface C: Backup Settings window

### 9.1 Window

- Standard titled macOS utility window with native traffic lights.
- Title: `Pimpampum Settings`.
- One window only; reopening focuses the existing instance.
- Initial content size: 460 × 270 pt, excluding the native title bar.
- Fixed compact layout is acceptable; if content needs more room for accessibility text sizing or
  localized errors, allow vertical growth rather than clipping.
- No sidebar, toolbar, tabs, or General/Advanced sections in version 1.
- The sole page is Backup.

### 9.2 Header

```text
Backup                                                    [refresh]
Keep one current snapshot after every change. The live database stays local.
```

- `Backup`: title-2 semibold.
- Description: secondary subheadline.
- Refresh: borderless native icon button with tooltip/accessibility label
  `Refresh backup status`.
- Disable refresh while an operation is in flight.
- Avoid cloud-provider logos because the destination may be local, Dropbox, Drive, iCloud, or any
  other synchronized folder.

### 9.3 Loading state

- Compact native progress indicator.
- Copy: `Loading backup settings…`.
- Disable all backup actions until the request completes.
- If a previous valid state exists, retain it and indicate activity rather than replacing all
  content with a blank screen.

### 9.4 Disabled state

Contents:

- Neutral external-drive/snapshot state icon.
- Copy: `Automatic backup is off`.
- Primary action: `Choose Folder…`.

Do not show a disabled path, last-success time, retry, open, or disable action.

### 9.5 Folder selection

- `Choose Folder…` and `Change…` open a native directory-only `NSOpenPanel`.
- Allow exactly one directory.
- Do not allow file selection or creation of arbitrary files.
- If changing an existing destination, initialize the picker at that folder when available.
- Cancel closes the picker and changes nothing.
- Confirmation sends the folder to the daemon and immediately enters Pending.
- The UI must not claim success until the daemon confirms configuration.

### 9.6 Configured state

Information order:

1. `FOLDER` small uppercase section label.
2. Full configured path in selectable monospaced text, maximum two visual lines.
3. `Change…` and `Open in Finder` actions.
4. Backup health row.
5. Primary operational action and destructive Disable action.

Path behavior:

- Preserve the full absolute path.
- Allow selection/copying.
- Prefer wrapping or middle truncation that keeps both root and final folder visible.
- Never expose the bearer token, data-directory token path, or live database path.

### 9.7 Healthy state

- Green completion marker.
- Label: `Up to date`.
- If available: `Last successful backup {localized date and time}`.
- Primary action: `Back Up Now`.
- Secondary actions: `Change…`, `Open in Finder`.
- Destructive action: `Disable`.

### 9.8 Pending state

- Native compact spinner or progress indicator.
- Label: `Backing up…`.
- Retain the configured folder so the user knows the destination.
- Disable Change, Open, Back Up Now/Try Again, Disable, and Refresh while the request is in flight.
- No progress percentage: the API does not provide one.

### 9.9 Error state

- Red warning marker.
- Label: `Backup needs attention`.
- Show the sanitized server error below the label in selectable caption text.
- If available, retain `Last successful backup {date and time}` to show data recency.
- Primary action label changes to `Try Again`.
- Keep `Change…`, `Open in Finder` when the path is still openable, and `Disable`.
- A backup failure does not imply project data was lost; avoid catastrophic language.

### 9.10 Operation/configuration error

Client, receipt, authentication, invalid-folder, and Finder-opening errors appear as one compact
inline error below the main content:

- Leading warning icon.
- Red semantic text.
- Selectable copy.
- Wrap as needed; do not truncate the actionable message below usefulness.
- Do not use a sheet or alert for routine errors.
- Never render credentials or raw response payloads.

Example copy:

- `Pimpampum's installation receipt could not be read. Run pimpampum install.`
- `Choose another folder.`
- `Pimpampum rejected the local token. Run pimpampum install to reconcile it.`
- `Finder could not open the backup directory: {path}`.

### 9.11 Disable behavior

- `Disable` uses the native destructive role/color.
- No confirmation dialog in version 1 because disabling does not delete the existing snapshot.
- On success, transition to Disabled.
- On failure, retain the configured state and show an inline error.

### 9.12 Keyboard and accessibility

- Full keyboard navigation in visual order.
- Native focus rings.
- Escape closes folder picker, not the settings window unless platform default behavior does so.
- Enter/Space activates the focused button.
- Every icon-only action has a tooltip and accessibility label.
- Status icon and text combine into one meaningful accessibility element.
- Support VoiceOver and increased contrast.
- Do not rely on red/green alone.

---

## 10. Omarchy surface A: Quattro bar widget

### 10.1 Integration behavior

- Native Quickshell `bar-widget` plugin.
- Must work in horizontal and vertical bar layouts.
- Inherit the bar's foreground, background, urgent color, font family, bar position, and bar size.
- Never draw a separate fixed background panel behind the widget unless Quattro provides a standard
  hover/active treatment.
- Hot reload must not leave duplicate popouts.

### 10.2 Horizontal layout

```text
[fixed Pimpampum mark + state] [optional active count]
```

- Center vertically in the inherited bar size.
- Approximately 4 themed spacing units between mark and count.
- Approximately 12 themed spacing units of total horizontal breathing room.
- Count uses the bar's small body size and semibold/bold weight.
- Use tabular/monospaced digits when supported by the inherited font.

### 10.3 Vertical layout

- Stack mark and count vertically.
- Center horizontally.
- Respect inherited bar width.
- Hide count at zero.
- Keep the click target equal to the widget bounds.

### 10.4 States and tooltip

- Same global semantics and precedence as macOS.
- Use the fixed Pimpampum mark in every state.
- Status treatment may be an adjacent dot, ring, corner badge, or color accent, provided it remains
  legible at the actual bar size.
- On hover, show a native Quattro tooltip with the full status label.
- When stale: `Stale · {last known status}`.
- Clicking toggles the Pimpampum popout.
- Pointer cursor on hover.

---

## 11. Omarchy surface B: Quattro status popout

### 11.1 Container

- Use Quattro's native `PopupCard` anchored to the widget.
- Target content width: 380 themed spacing units.
- Maximum content height: 520 themed spacing units or available screen height, whichever is lower.
- Body scrolls with clipped content and stops at bounds.
- The bar owns popout switching so Pimpampum does not create competing popup windows.
- Use inherited theme background, foreground, urgent color, font, radii, and spacing wherever
  available.

### 11.2 Information order

1. Pimpampum title and connection state.
2. Connection/reveal error, when applicable.
3. Empty/setup instruction, when applicable.
4. Active work.
5. Incomplete projects.
6. Completed-project disclosure.
7. Backup disclosure.

The Quattro popout may omit the daemon version/uptime Summary block if space is tight. It must not
omit active work, projects, connection state, or backup.

### 11.3 Header and connection state

- `Pimpampum`: inherited subtitle size, bold.
- Adjacent connection label: `online`, `offline`, `credentials`, `invalid`, or `incompatible`.
- Use normal foreground when online and urgent color otherwise.
- Use `Stale` when cached overview is shown after a failure.
- Connection error appears as wrapped urgent body-small text below the header.

Required repair copy for rejected credentials:

Credentials rejected are presented as a recoverable setup state rather than a raw inline error:

- Headline `Authentication required` in bold body text.
- Explanation `The saved credentials no longer match the local daemon.` in caption text.
- The repair command `pimpampum install` on its own translucent foreground surface, following
  the same wrapping and alignment rules as the no-workspaces command.

Never expose the token or raw stderr.

### 11.3.1 Updates

- `pimpampum update:check` queries the canonical npm registry metadata and never changes state.
- `pimpampum update` installs the latest stable package globally, then invokes that newly installed
  CLI's idempotent installer so the daemon and desktop integration move together.
- Updates preserve the database, token, settings, logs, backups, exports, and registered workspaces.
- An already-current update still reconciles the installation and reports `updated: false`.
- Registry and reconciliation failures are retryable `unavailable` errors and never expose raw npm
  stderr, tokens, or registry configuration.
- Desktop help surfaces name both commands. Omarchy Settings also provides a manual check and a
  single install action when a release is available. It does not poll the network or update
  silently.

### 11.4 Empty states

Amended 2026-08-30. An empty popout is a first-run screen, not an error report, so each state
carries a headline, one line of explanation, and — only where a single command resolves it —
that command on its own surface.

- No workspaces:
  - Headline `No workspaces` in bold body text.
  - Explanation `Register a folder as a workspace to start tracking projects.` in caption text
    at the same reduced opacity as the header's connection label.
  - The command `pimpampum workspace:add` on a translucent foreground surface, so the shell
    verb is never read as prose. It wraps rather than elides; a truncated command is useless.
- Workspaces but no projects:
  - Headline `No projects`, explanation `Projects appear here as your agents create them.`
  - No command surface: project creation needs arguments the popout does not have.
- Use ordinary body text, not a large illustration.
- Keep the block left-aligned on the panel's text column; centring it alone would break the
  alignment every other section follows.

### 11.5 Active work

- Heading: `Active work ({N})` only when active work exists.
- Each item shows:
  - `{project title}` for a project claim.
  - `{project title} — {task title}` for a task claim.
  - `{agent ID} · {remaining lease}` on a secondary line.
- Long primary text elides at the end.
- Lease may use compact Quattro copy: seconds below one minute, rounded-up minutes thereafter.
- No row action.
- If truncated: `Active work list truncated` in urgent caption text.

### 11.6 Projects

- Heading: `Projects ({N})` for incomplete projects.
- Each incomplete row shows:
  - `{project title} · {status}`.
  - `{workspace name} / {slug} · {N} active · {N} available`.
- Long text elides at the end.
- Entire row is clickable and opens the exact workspace root through the system file explorer.
- Use pointer cursor and a subtle inherited hover treatment.
- Missing/unopenable workspace keeps the row visible and shows:
  `Could not open the workspace directory`.
- If truncated: `Project list truncated` in urgent caption text.

### 11.7 Completed projects

- Disclosure label: `Completed ({N})` with a clear collapsed/expanded chevron.
- Collapsed by default.
- Omit when zero.
- Expanded rows show `{project title} · {workspace name} / {slug}`.
- Rows open the workspace root.
- Expansion is local UI state only.

### 11.8 Backup disclosure

- Label: `Backup` with collapsed/expanded chevron.
- Collapsed by default.
- Expanding refreshes the canonical daemon-owned setting.
- Keep this section after projects so backup administration does not dominate operational status.

Expanded information order:

1. Configured path when enabled, middle-elided.
2. Health label and last-success time.
3. Status/operation error, when present.
4. Manual absolute-path label and input.
5. Available action buttons.
6. Folder-picker fallback explanation, when needed.

### 11.9 Quattro backup path input

- Label: `Backup folder (absolute path)`.
- Placeholder: `/home/you/Dropbox/Pimpampum`.
- Single-line field, clipped horizontally.
- User may select and edit text with the mouse and keyboard.
- Enter saves only when the value is a syntactically absolute path.
- Disable the field while a backup operation is running.
- The daemon remains the final validator; the UI must not claim success from local validation alone.

### 11.10 Quattro backup actions

Render compact wrapping action chips/buttons in this order:

1. `Choose…` — only visible when the optional Qt FolderDialog is available.
2. `Save` — enabled only when the manual path is absolute.
3. `Open` — enabled only when automatic backup is configured.
4. `Back Up Now` — enabled only when configured.
5. `Disable` — enabled only when configured; visually destructive/urgent but not oversized.

While busy:

- Disable all actions and the path field.
- Reduce control emphasis/opacity.
- Health copy becomes `Updating…`.
- Never launch two helper processes in parallel.

Folder-dialog fallback copy:

`Folder picker unavailable; enter an absolute path above.`

### 11.11 Quattro backup health

- Disabled: `Automatic backup is off`, neutral/subdued.
- Pending: `Backup pending`, neutral or amber.
- Healthy without timestamp: `Up to date`, green.
- Healthy with timestamp: `Up to date · {localized time}`, green.
- Error: `Backup needs attention`, urgent/red.
- Operation errors appear below the health label in wrapped urgent caption text.
- Error copy is bounded and sanitized; never design space for raw logs.

### 11.12 Quattro accessibility and input

- Every clickable row/button needs visible hover and focus treatment.
- Keyboard activation should mirror pointer activation where Quickshell permits.
- Text and controls must meet the active theme's accessible contrast.
- Color must be paired with state text or shape.
- The bar mark has accessible status text.
- The active count has accessible copy `{N} active claims`.
- Do not create custom pointer gestures that block scrolling.

---

## 12. Shared refresh and freshness behavior

The design must communicate transient activity without presenting a manual-dashboard metaphor.

### Overview

- Refresh immediately at integration startup.
- Refresh immediately when the popover/popout opens.
- Refresh approximately every five seconds while open.
- Refresh approximately every ten seconds while closed.
- Keep the last valid overview in memory if a later request fails.
- Mark cached content explicitly as stale.
- Claims disappear when expired, even between server refreshes where supported.

### Backup

- Refresh when the settings window/disclosure opens.
- Refresh after configure, retry, or disable.
- macOS provides an explicit refresh icon.
- Quattro refreshes while the popout is open.
- During an operation, keep the last known destination visible and disable competing actions.

No pull-to-refresh, progress bar, toast, or success celebration is needed.

---

## 13. Typography and token guidance

### macOS

Use semantic native styles rather than fixed font sizes wherever possible:

| Use                   | Native style                              |
| --------------------- | ----------------------------------------- |
| Window page title     | `title2`, semibold                        |
| Popover product title | `headline`                                |
| Section headings      | `caption`, semibold, uppercase, secondary |
| Row primary text      | `subheadline`, medium                     |
| Supporting text       | `caption`, secondary                      |
| Tertiary metadata     | `caption2`, secondary                     |
| Paths                 | `body`, monospaced                        |

Use native primary, secondary, tertiary, quaternary, red, orange/amber, blue, and green semantic
colors. Do not hardcode light-mode grays.

### Quattro

Use the active theme's tokens:

- `bar.foreground`
- `bar.background`
- `bar.urgent`
- `bar.fontFamily`
- `bar.barSize`
- Quattro `Style.font.*`
- Quattro `Style.space(*)`

Semantic status accents may introduce blue, amber, and green only if equivalent theme tokens are
unavailable. They must be checked on both light and dark Quattro themes.

---

## 14. Spacing and sizing guidance

These values describe the intended density and may map to the native platform scale rather than
literal pixels.

| Element                   |    macOS |                        Quattro |
| ------------------------- | -------: | -----------------------------: |
| Popover/popout width      |   360 pt |               380 themed units |
| Maximum body height       |   480 pt |               520 themed units |
| Main horizontal padding   |    16 pt | `Style.space(10)` contextually |
| Settings padding          |    24 pt |                 Not applicable |
| Major section gap         | 16–18 pt |              `Style.space(10)` |
| Compact row inner padding |    10 pt |              6–10 themed units |
| Compact control height    |   Native |            ~28–30 themed units |
| Small corner radius       |     8 pt |        Theme radius/~4–8 units |
| Mark-to-count gap         |     4 pt |               `Style.space(4)` |

Do not increase the popover width to solve long text. Use wrapping, truncation, scrolling, and
workspace/slug disambiguation as specified.

---

## 15. Content rules

- All UI copy is English.
- Use sentence case, except uppercase micro section labels on macOS.
- Use ellipsis `…` for actions that open another UI before completing: `Settings…`,
  `Choose Folder…`, `Choose…`, `Change…`.
- `Back Up Now` performs immediately and has no ellipsis.
- `Disable` performs immediately and has no confirmation in version 1.
- `Quit Pimpampum` is explicit; do not use a power icon without text.
- Use `Active work`, never `Doing`.
- Use `available`, not `todo` or `backlog`.
- Never describe a backup error as lost data unless the server explicitly reports data loss.
- Never display internal error stacks, JSON, access tokens, PRD bodies, or task bodies.

---

## 16. Long-content and boundary rules

### Project and workspace content

- Project title: maximum two lines on macOS; one elided line on compact Quattro rows.
- Duplicate titles: workspace name and slug must remain visible as disambiguation.
- Workspace name/slug: one line, end-elided if necessary.
- Agent ID: one line; preserve enough text to distinguish agents.
- Completed task counts may be large; never allow them to push the external-open affordance away.

### Paths

- Backup paths may include spaces, Unicode, quotes, and shell metacharacters.
- Treat paths only as text.
- Prefer middle elision for a single-line path so root and destination folder remain visible.
- macOS settings path may wrap to two lines and must be selectable.
- Never design shell-escaping affordances or command previews.

### Counts

- Counts are non-negative integers.
- Popover detail may show full values.
- Compact bar count caps visually at `99+` if required by available width.

### Error messages

- Popover connection detail: maximum three visible lines.
- Settings and backup errors may wrap enough to remain actionable.
- Quattro errors remain compact and bounded; no scrollable log area.

---

## 17. Required design frames

This is the minimum complete handoff set. Do not create unrelated screens.

### macOS

1. **Menu-bar state strip** at actual size: Loading, Active with count, Available, Draft, Complete,
   Empty, Offline, Authentication error.
2. **Popover — active mixed workload**: multiple active claims, active/available/draft projects,
   completed disclosure collapsed.
3. **Popover — completed expanded**: completed group expanded and scroll behavior annotated.
4. **Popover — offline stale**: cached rows retained with stale notice.
5. **Popover — unavailable/setup**: no valid overview plus login approval variant annotation.
6. **Settings — disabled**.
7. **Settings — healthy configured** with a long synchronized path.
8. **Settings — pending**.
9. **Settings — backup error** with last-success time and Try Again.
10. **Settings — installation/authentication error** showing inline error behavior.

### Omarchy Quattro

11. **Bar state strip, horizontal and vertical**: same semantic states and active counter.
12. **Popout — active mixed workload**, backup collapsed.
13. **Popout — completed expanded and long content**.
14. **Popout — offline stale/error**.
15. **Backup expanded — disabled with FolderDialog available**.
16. **Backup expanded — healthy configured**.
17. **Backup expanded — pending/busy**.
18. **Backup expanded — error**.
19. **Backup expanded — FolderDialog unavailable**, showing the manual absolute-path fallback.

Variants may share one component board when all specified copy, controls, dimensions, and
interactions remain unambiguous. The handoff does not require 19 separate polished canvases if a
well-structured component/variant sheet covers the same states.

---

## 18. Required design deliverables

The design handoff must include:

- The approved variant C compact mark—one exact circle containing a lowercase `p`—in vector form.
- Monochrome/template variant suitable for macOS.
- Light and dark state treatments.
- Horizontal and vertical Quattro widget variants.
- Component variants for all shared global, project, and backup states.
- The required frames or an equivalent complete state matrix.
- Exact copy from this specification.
- Dimensions, spacing, typography styles, semantic colors, corner radii, and divider usage.
- Hover, pressed, focus, disabled, busy, selected/open, and error states for interactive controls.
- Scrolling and maximum-height annotations.
- Long-title, long-path, duplicate-title, two-digit count, `99+`, and multiline-error examples.
- Accessibility names for icon-only controls and compact indicators.
- Notes identifying which values come from the macOS system and which inherit from Quattro.

No marketing illustration, full application shell, mobile version, web dashboard, or additional
settings pages are required.

---

## 19. Acceptance checklist

### Identity

- [ ] The fixed variant C circle containing a lowercase `p` remains visible in every compact state.
- [ ] Offline is not represented by replacing the product mark with a Wi-Fi icon.
- [ ] Active count is readable and hidden at zero.
- [ ] Every semantic color is paired with text or a distinct shape.

### macOS

- [ ] Menu-bar app has no Dock presence.
- [ ] Popover is 360 pt wide with fixed header/footer and scrollable body.
- [ ] Active work and project data match the exact hierarchy in this document.
- [ ] Completed projects are collapsed by default.
- [ ] Project rows clearly open Finder and show disambiguation.
- [ ] Offline cached data is visibly stale.
- [ ] Footer contains both `Quit Pimpampum` and `Settings…`.
- [ ] Settings opens/focuses one real window.
- [ ] Backup Settings covers loading, disabled, pending, healthy, and error.
- [ ] Folder selection is native and directory-only.
- [ ] Errors are inline and actionable.

### Quattro

- [ ] Widget supports horizontal and vertical bar geometry.
- [ ] Widget inherits active Quattro theme tokens.
- [ ] Popout uses native PopupCard behavior and remains scrollable/bounded.
- [ ] Active work, projects, completed disclosure, and backup appear in the required order.
- [ ] Workspace rows clearly open the system file explorer.
- [ ] Backup remains collapsed by default.
- [ ] Folder dialog and manual absolute-path fallback are both designed.
- [ ] Busy operations disable competing actions.
- [ ] No token, raw stderr, or shell command appears in the UI.

### Scope

- [ ] No project/task/PRD editing controls were added.
- [ ] No `Doing` lifecycle state appears.
- [ ] No daemon lifecycle controls were added.
- [ ] No backup history, restore flow, or provider account UI was added.
- [ ] No extra navigation or settings categories were added.

---

## 20. Handoff note

Visual polish may change typography metrics and native token mapping, but it must preserve the exact
variant C circle-with-lowercase-`p` geometry and
must not change the information architecture, state semantics, actions, copy intent, or scope
defined here. If the design tool proposes additional functionality, treat it as out of scope unless
the product specification is explicitly revised.
