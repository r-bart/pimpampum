#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_root=${1:-"$repository_root/release"}
version=$(node -p "require('$repository_root/package.json').version")
app_root="$repository_root/platforms/macos/dist/PimpampumMenuBar.app"

mkdir -p "$output_root"
node "$repository_root/scripts/check-macos-artifact.mjs" "$app_root"
node "$repository_root/scripts/check-macos-evidence.mjs"
# Quattro live evidence is opt-in, not a release gate (thoughts/notes/2026-08-28_quattro-gate-removed.md).

npm pack --pack-destination "$output_root" >/dev/null
/usr/bin/ditto -c -k --sequesterRsrc --keepParent \
  "$app_root" "$output_root/PimpampumMenuBar-$version-macos-arm64.zip"

(
  cd "$output_root"
  shasum -a 256 \
    "pimpampum-$version.tgz" \
    "PimpampumMenuBar-$version-macos-arm64.zip" \
    > SHA256SUMS
)

printf 'Release assets are ready in %s\n' "$output_root"
