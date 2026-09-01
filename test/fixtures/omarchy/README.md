# Omarchy command fixtures

`test/service-omarchy.test.ts` replays these files as the stdout of the `omarchy` and
`omarchy-shell` commands the adapter issues. The fake fails when a command has no fixture, so a new
command in `src/service/omarchy.ts` must land here with the bytes the real CLI wrote.

## Status

**Every file in this directory is synthetic.** It was seeded on 2026-09-01 from the shapes the test
author wrote for the in-memory fake, not from an Omarchy host. Until an Omarchy Quattro machine
replaces them, the adapter is proven only against the author's expectation of the CLI.

## Capture on an Omarchy host

Run each command on the Quattro machine with the Pimpampum plugin installed and enabled, and copy
stdout verbatim (no trailing newline added or removed):

| Fixture                      | Command                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `version.txt`                | `omarchy version`                                                                                       |
| `plugin-list.json`           | `omarchy plugin list --json` with the plugin installed                                                  |
| `plugin-list-empty.json`     | `omarchy plugin list --json` with the plugin removed                                                    |
| `plugin-validate.txt`        | `omarchy plugin validate ~/.config/omarchy/plugins/dev.pimpampum.status`                                |
| `plugin-enable.txt`          | `omarchy plugin enable dev.pimpampum.status`                                                            |
| `plugin-disable.txt`         | `omarchy plugin disable dev.pimpampum.status`                                                           |
| `plugin-enable-help.txt`     | `omarchy plugin enable --help`                                                                          |
| `plugin-remove-help.txt`     | `omarchy plugin remove --help`                                                                          |
| `plugin-remove.txt`          | `omarchy plugin remove dev.pimpampum.status --yes`; replace the reported backup path by `{BACKUP_PATH}` |
| `shell-ping.txt`             | `omarchy-shell shell ping`                                                                              |
| `shell-rescanPlugins.txt`    | `omarchy-shell shell rescanPlugins`                                                                     |
| `shell-listShellConfig.json` | `omarchy-shell shell listShellConfig`                                                                   |
| `shell-enablePlugin.txt`     | `omarchy-shell shell enablePlugin dev.pimpampum.status '{"section":"right","index":0}'`                 |
| `shell-setPluginEnabled.txt` | `omarchy-shell shell setPluginEnabled dev.pimpampum.status false`                                       |
| `shell-setBarWidget.txt`     | `omarchy-shell shell setBarWidget dev.pimpampum.status <key> <json> '{"section":"right","index":0}'`    |
| `shell-unknown.txt`          | `omarchy-shell shell enablePlugin dev.pimpampum.unknown '{}'` (the not-yet-rediscovered response)       |

## How the fake uses them

- Text fixtures are returned byte for byte.
- `plugin-list.json` is parsed; the fake rewrites `enabled` and `active` of the Pimpampum entry from
  its simulated state and serialises the array again, so the recorded key set and order are kept.
- `shell-listShellConfig.json` is parsed; the fake substitutes `bar.layout` with the simulated layout
  and keeps every other recorded key.
- `plugin-remove.txt` has `{BACKUP_PATH}` replaced by the backup directory the fake created.

When you replace a fixture with real output, update the **Status** section with the Omarchy version
and the date of capture.
