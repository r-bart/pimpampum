#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_root="$repository_root/platforms/macos"
output_root="$package_root/dist"
app_root="$output_root/PimpampumMenuBar.app"
compact_mark="$package_root/Resources/PimpampumCompact.pdf"
app_icon="$repository_root/branding/app-icon/Pimpampum.icon"
fallback_asset_catalog="$package_root/Resources/Assets.car"
fallback_app_icon="$package_root/Resources/Pimpampum.icns"
runtime_work=""
partial_plist=""

cleanup() {
  if [ -n "$partial_plist" ]; then rm -f "$partial_plist"; fi
  if [ -n "$runtime_work" ]; then rm -rf "$runtime_work"; fi
}
trap cleanup EXIT INT TERM

if [ ! -f "$compact_mark" ]; then
  printf 'Missing required macOS mark resource: %s\n' "$compact_mark" >&2
  exit 1
fi

if [ ! -d "$app_icon" ]; then
  printf 'Missing required Icon Composer source: %s\n' "$app_icon" >&2
  exit 1
fi

swift build --package-path "$package_root" --configuration release --arch arm64
binary_root=$(swift build --package-path "$package_root" --configuration release --arch arm64 --show-bin-path)

version=$(node -p "require('$repository_root/package.json').version")
runtime_bundle=${PIMPAMPUM_RUNTIME_BUNDLE:-}
if [ -z "$runtime_bundle" ]; then
  runtime_work=$(mktemp -d "${TMPDIR:-/tmp}/pimpampum-macos-runtime.XXXXXX")
  node "$repository_root/scripts/build-runtime-bundle.mjs" \
    --target darwin-arm64 \
    --output "$runtime_work" \
    --repository "$repository_root"
  runtime_bundle="$runtime_work/pimpampum-runtime-$version-darwin-arm64"
fi
node "$repository_root/scripts/check-runtime-bundle.mjs" \
  "$runtime_bundle" \
  --target darwin-arm64 \
  --lockfile "$repository_root/package-lock.json"

rm -rf "$output_root/pim • pam • pum.app" "$output_root/Pimpampum.app" "$app_root"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$binary_root/PimpampumMenuBar" "$app_root/Contents/MacOS/PimpampumMenuBar"
cp "$package_root/Resources/Info.plist" "$app_root/Contents/Info.plist"
cp "$compact_mark" "$app_root/Contents/Resources/PimpampumCompact.pdf"

runtime_resources="$app_root/Contents/Resources/PimpampumRuntime"
mkdir -p "$runtime_resources"
cp "$runtime_bundle/runtime-manifest.json" "$runtime_resources/runtime-manifest.json"
cp "$runtime_bundle/runtime-inventory.json" "$runtime_resources/runtime-inventory.json"
cp "$runtime_bundle/runtime-sbom.spdx.json" "$runtime_resources/runtime-sbom.spdx.json"
cp -R "$runtime_bundle/payload" "$runtime_resources/payload"

if [ -n "${PIMPAMPUM_SIGNING_IDENTITY:-}" ]; then
  runtime_node="$runtime_resources/payload/bin/node"
  runtime_addon="$runtime_resources/payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  /usr/bin/codesign --force --options runtime --timestamp \
    --sign "$PIMPAMPUM_SIGNING_IDENTITY" "$runtime_node"
  /usr/bin/codesign --force --options runtime --timestamp \
    --sign "$PIMPAMPUM_SIGNING_IDENTITY" "$runtime_addon"
  PIMPAMPUM_EMBEDDED_RUNTIME="$runtime_resources" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.PIMPAMPUM_EMBEDDED_RUNTIME;
const manifestPath = join(root, 'runtime-manifest.json');
const inventoryPath = join(root, 'runtime-inventory.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.files = manifest.files.map((file) => {
  const path = join(root, 'payload', ...file.path.split('/'));
  const content = readFileSync(path);
  return {
    ...file,
    sha256: createHash('sha256').update(content).digest('hex'),
    mode: statSync(path).mode & 0o777,
    size: content.length,
  };
});
manifest.unpackedBytes = manifest.files.reduce((total, file) => total + file.size, 0);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
writeFileSync(
  inventoryPath,
  `${JSON.stringify({ schemaVersion: 1, target: 'darwin-arm64', files: manifest.files }, null, 2)}\n`,
  { mode: 0o644 },
);
NODE
fi

partial_plist=$(mktemp "$output_root/.Pimpampum-icon-partial.XXXXXX")
used_icon_composer=false
if [ "${PIMPAMPUM_USE_PRECOMPILED_ICON:-0}" != 1 ]; then
  xcrun actool "$app_icon" \
    --compile "$app_root/Contents/Resources" \
    --platform macosx \
    --minimum-deployment-target 13.0 \
    --app-icon Pimpampum \
    --output-partial-info-plist "$partial_plist" \
    >/dev/null
  used_icon_composer=true
fi

if [ "$used_icon_composer" = false ] || \
  [ ! -f "$app_root/Contents/Resources/Assets.car" ] || \
  [ ! -f "$app_root/Contents/Resources/Pimpampum.icns" ]; then
  if [ ! -f "$fallback_asset_catalog" ] || [ ! -f "$fallback_app_icon" ]; then
    printf 'Icon Composer did not produce complete assets and no reviewed fallback exists.\n' >&2
    exit 1
  fi
  used_icon_composer=false
  cp "$fallback_asset_catalog" "$app_root/Contents/Resources/Assets.car"
  cp "$fallback_app_icon" "$app_root/Contents/Resources/Pimpampum.icns"
fi

if [ "$used_icon_composer" = true ] && \
  [ "$(/usr/bin/plutil -extract CFBundleIconName raw -o - "$partial_plist")" != "Pimpampum" ]; then
  printf 'Icon Composer returned an unexpected app icon name.\n' >&2
  exit 1
fi

chmod 755 "$app_root/Contents/MacOS/PimpampumMenuBar"
/usr/bin/plutil -lint "$app_root/Contents/Info.plist"

printf '%s\n' "$app_root"
