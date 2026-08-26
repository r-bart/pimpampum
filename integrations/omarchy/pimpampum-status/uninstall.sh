#!/usr/bin/env bash
set -euo pipefail

if [[ -n ${PIMPAMPUM_CLI:-} && ${PIMPAMPUM_CLI:0:1} == / && -x $PIMPAMPUM_CLI ]]; then
  pimpampum_cli=$PIMPAMPUM_CLI
else
  pimpampum_cli=$(command -v pimpampum || true)
fi

if [[ -z $pimpampum_cli || ${pimpampum_cli:0:1} != / || ! -x $pimpampum_cli ]]; then
  printf '%s\n' 'pimpampum-omarchy-uninstall: no absolute Pimpampum CLI executable was found' >&2
  exit 127
fi

exec "$pimpampum_cli" uninstall
