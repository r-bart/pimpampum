#!/bin/sh
set -eu

plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${PIMPAMPUM_CLI:-}" ] && [ "${PIMPAMPUM_CLI#/}" != "$PIMPAMPUM_CLI" ] &&
  [ -x "$PIMPAMPUM_CLI" ] && [ ! -L "$PIMPAMPUM_CLI" ]; then
  pimpampum_cli=$PIMPAMPUM_CLI
else
  pimpampum_cli="$plugin_root/pimpampum-plugin-lifecycle"
fi
exec "$pimpampum_cli" uninstall
