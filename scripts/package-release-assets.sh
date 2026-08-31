#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_root=${1:-"$repository_root/release"}
version=$(node -p "require('$repository_root/package.json').version")
app_root="$repository_root/platforms/macos/dist/PimpampumMenuBar.app"
runtime_bundles_root=${PIMPAMPUM_RUNTIME_BUNDLES_ROOT:-}
runtime_work=""

cleanup() {
  if [ -f "$repository_root/.pimpampum-package.repository.json" ]; then
    node "$repository_root/scripts/restore-package-manifest.mjs"
  fi
  if [ -n "$runtime_work" ]; then rm -rf "$runtime_work"; fi
}
trap cleanup EXIT INT TERM

if [ "${PIMPAMPUM_REQUIRE_NOTARIZATION:-0}" = 1 ]; then
  node "$repository_root/scripts/check-macos-artifact.mjs" \
    "$app_root" --require-signature --require-notarization
else
  node "$repository_root/scripts/check-macos-artifact.mjs" "$app_root"
fi
node "$repository_root/scripts/check-macos-evidence.mjs"
# Quattro live evidence is opt-in, not a release gate (thoughts/notes/2026-08-28_quattro-gate-removed.md).

if [ -z "$runtime_bundles_root" ]; then
  runtime_work=$(mktemp -d "${TMPDIR:-/tmp}/pimpampum-release-runtime.XXXXXX")
  runtime_bundles_root="$runtime_work"
  for target in linux-arm64 linux-x64; do
    node "$repository_root/scripts/build-runtime-bundle.mjs" \
      --target "$target" \
      --output "$runtime_bundles_root" \
      --repository "$repository_root"
  done
fi

find_runtime_bundle() {
  target=$1
  for candidate in \
    "$runtime_bundles_root/pimpampum-runtime-$version-$target" \
    "$runtime_bundles_root/runtime-$target"; do
    if [ -f "$candidate/runtime-manifest.json" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'Missing reviewed runtime bundle for %s under %s\n' "$target" "$runtime_bundles_root" >&2
  return 1
}

mkdir -p "$output_root"
for target in linux-arm64 linux-x64; do
  bundle=$(find_runtime_bundle "$target")
  node "$repository_root/scripts/check-runtime-bundle.mjs" \
    "$bundle" --target "$target" --lockfile "$repository_root/package-lock.json"
  archive="pimpampum-runtime-$version-$target.tar.gz"
  cp "$bundle/$archive" "$output_root/$archive"
  cp "$bundle/runtime-manifest.json" \
    "$output_root/pimpampum-runtime-$version-$target.manifest.json"
  cp "$bundle/runtime-inventory.json" \
    "$output_root/pimpampum-runtime-$version-$target.inventory.json"
  cp "$bundle/runtime-sbom.spdx.json" \
    "$output_root/pimpampum-runtime-$version-$target.sbom.spdx.json"
  cp "$bundle/archive-sha256.json" \
    "$output_root/pimpampum-runtime-$version-$target.archive-sha256.json"
done

OUTPUT_ROOT="$output_root" RELEASE_VERSION="$version" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outputRoot = process.env.OUTPUT_ROOT;
const version = process.env.RELEASE_VERSION;
const targets = {};
for (const target of ['linux-arm64', 'linux-x64']) {
  const descriptor = JSON.parse(
    readFileSync(
      join(outputRoot, `pimpampum-runtime-${version}-${target}.archive-sha256.json`),
      'utf8',
    ),
  );
  targets[target] = {
    url: `https://github.com/r-bart/pimpampum/releases/download/v${version}/${descriptor.file}`,
    sha256: descriptor.sha256,
    maximumBytes: 100663296,
  };
}
writeFileSync(
  join(outputRoot, `pimpampum-omarchy-runtime-manifest-${version}.json`),
  `${JSON.stringify({ version, targets }, null, 2)}\n`,
  { flag: 'wx', mode: 0o644 },
);
NODE

generated_plugin_manifest="$output_root/pimpampum-omarchy-runtime-manifest-$version.json"
reviewed_plugin_manifest="$repository_root/integrations/omarchy/pimpampum-status/runtime-manifest.json"
if ! cmp -s "$reviewed_plugin_manifest" "$generated_plugin_manifest"; then
  printf 'The checked-in Omarchy runtime manifest does not match the exact release archives.\n' >&2
  printf 'Review %s and update %s before tagging.\n' \
    "$generated_plugin_manifest" "$reviewed_plugin_manifest" >&2
  exit 1
fi

npm pack --pack-destination "$output_root" >/dev/null
/usr/bin/ditto -c -k --sequesterRsrc --keepParent \
  "$app_root" "$output_root/PimpampumMenuBar-$version-macos-arm64.zip"

(
  cd "$output_root"
  shasum -a 256 \
    "pimpampum-$version.tgz" \
    "PimpampumMenuBar-$version-macos-arm64.zip" \
    "pimpampum-runtime-$version-linux-arm64.tar.gz" \
    "pimpampum-runtime-$version-linux-x64.tar.gz" \
    "pimpampum-runtime-$version-linux-arm64.manifest.json" \
    "pimpampum-runtime-$version-linux-x64.manifest.json" \
    "pimpampum-runtime-$version-linux-arm64.inventory.json" \
    "pimpampum-runtime-$version-linux-x64.inventory.json" \
    "pimpampum-runtime-$version-linux-arm64.sbom.spdx.json" \
    "pimpampum-runtime-$version-linux-x64.sbom.spdx.json" \
    "pimpampum-runtime-$version-linux-arm64.archive-sha256.json" \
    "pimpampum-runtime-$version-linux-x64.archive-sha256.json" \
    "pimpampum-omarchy-runtime-manifest-$version.json" \
    > SHA256SUMS
)

printf 'Release assets are ready in %s\n' "$output_root"
