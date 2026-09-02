#!/bin/sh
# Shared prologue for the Pimpampum Omarchy helpers. pimpampum-bootstrap, pimpampum-connections,
# pimpampum-control-route and pimpampum-plugin-lifecycle source this file by absolute path; it is
# never executed on its own and defines functions only.
#
# Contract for the sourcing helper:
#   - Set `helper_name` before sourcing. `fail` prefixes every message with it.
#   - `fail EXIT_CODE MESSAGE...` prints one stderr line and exits.
#   - `fail_typed EXIT_CODE CODE MESSAGE` is what the shared checks call. The default renders the
#     message through `fail`; a helper with a machine-readable error contract redefines it after
#     sourcing and reports CODE instead.

fail() {
  code=$1
  shift
  printf '%s\n' "${helper_name:-pimpampum}: $*" >&2
  exit "$code"
}

fail_typed() {
  fail "$1" "$3"
}

require_absolute() {
  case $1 in
    /*) ;;
    *) fail_typed 64 invalid_path "$2 must be absolute" ;;
  esac
}

sha256_file() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/sha256sum "$1" | /usr/bin/awk '{print $1}'
  elif [ -x /usr/bin/shasum ]; then
    /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
  else
    fail_typed 69 checksum_unavailable 'sha256sum or shasum is required'
  fi
}

# Exact version pinned by a runtime manifest: `manifest_version MANIFEST`.
manifest_version() {
  /usr/bin/awk '
    /"version"[[:space:]]*:/ {
      value = $0
      sub(/^[^:]+:[[:space:]]*"/, "", value)
      sub(/"[[:space:]]*,?[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$1"
}

# One scalar under the selected target: `manifest_value MANIFEST TARGET KEY`.
manifest_value() {
  /usr/bin/awk -v target="\"$2\"" -v key="\"$3\"" '
    index($0, target ":") { selected = 1; next }
    selected && index($0, key ":") {
      value = $0
      sub(/^[^:]+:[[:space:]]*/, "", value)
      sub(/,[[:space:]]*$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
    selected && $0 ~ /^    }/ { exit }
  ' "$1"
}

# `validate_home EXIT_CODE` sets `home_directory`. It rejects every character the launchers
# (single quotes), the JSON receipts (double quotes and backslashes) and the one-line logs
# (control characters) cannot carry. Spaces and non-ASCII letters are accepted.
validate_home() {
  home_directory=${HOME:-}
  case $home_directory in
    /) fail_typed "$1" invalid_home 'HOME must not be the filesystem root' ;;
    /*) ;;
    *) fail_typed "$1" invalid_home 'HOME must be absolute' ;;
  esac
  case $home_directory in
    *"'"* | *'"'* | *\\*)
      fail_typed "$1" invalid_home 'HOME contains characters unsafe for launchers or receipts'
      ;;
  esac
  case $home_directory in
    *[[:cntrl:]]*) fail_typed "$1" invalid_home 'HOME contains control characters' ;;
  esac
  [ -d "$home_directory" ] && [ ! -L "$home_directory" ] ||
    fail_typed "$1" invalid_home 'HOME must be a regular directory and not a symlink'
}

# `verify_control_launcher EXIT_CODE` sets `data_directory`, `receipt` and `control_launcher`
# from `home_directory`, and proves that the private runtime receipt owns the stable control
# launcher before any helper executes it.
verify_control_launcher() {
  data_directory="$home_directory/.pimpampum"
  receipt="$data_directory/runtime-install-receipt.json"
  control_launcher="$home_directory/.local/share/pimpampum/bin/pimpampum-control"
  [ -d "$data_directory" ] && [ ! -L "$data_directory" ] ||
    fail_typed "$1" runtime_not_installed 'runtime is not installed'
  [ -f "$receipt" ] && [ ! -L "$receipt" ] ||
    fail_typed "$1" runtime_not_installed 'runtime receipt is missing or unsafe'
  receipt_mode=$(/usr/bin/stat -c '%a' "$receipt" 2>/dev/null ||
    /usr/bin/stat -f '%Lp' "$receipt" 2>/dev/null || true)
  [ "$receipt_mode" = 600 ] ||
    fail_typed "$1" receipt_mismatch 'runtime receipt permissions are unsafe'
  for private_directory in \
    "$home_directory/.local" \
    "$home_directory/.local/share" \
    "$home_directory/.local/share/pimpampum" \
    "$home_directory/.local/share/pimpampum/bin"; do
    [ -d "$private_directory" ] && [ ! -L "$private_directory" ] ||
      fail_typed "$1" unsafe_runtime_path 'control launcher directory is unsafe'
  done
  [ -f "$control_launcher" ] && [ ! -L "$control_launcher" ] && [ -x "$control_launcher" ] ||
    fail_typed "$1" control_unavailable 'receipt-owned control launcher is unavailable'
  /usr/bin/grep -Fq "\"controlLauncherPath\": \"$control_launcher\"" "$receipt" ||
    fail_typed "$1" receipt_mismatch 'runtime receipt does not own the control launcher'
  expected_launcher_sha=$(/usr/bin/awk -F'"' \
    '/"controlLauncherSha256"[[:space:]]*:/ { print $4; exit }' "$receipt")
  printf '%s\n' "$expected_launcher_sha" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' ||
    fail_typed "$1" receipt_mismatch 'runtime receipt control launcher hash is invalid'
  [ -x /usr/bin/sha256sum ] || [ -x /usr/bin/shasum ] ||
    fail_typed "$1" checksum_unavailable 'sha256sum or shasum is required'
  [ "$(sha256_file "$control_launcher")" = "$expected_launcher_sha" ] ||
    fail_typed "$1" launcher_mismatch 'control launcher differs from its runtime receipt'
}
