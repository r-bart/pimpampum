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

rm -rf "$output_root/pim • pam • pum.app" "$output_root/Pimpampum.app" "$app_root"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$binary_root/PimpampumMenuBar" "$app_root/Contents/MacOS/PimpampumMenuBar"
cp "$package_root/Resources/Info.plist" "$app_root/Contents/Info.plist"
cp "$compact_mark" "$app_root/Contents/Resources/PimpampumCompact.pdf"

partial_plist=$(mktemp "$output_root/.Pimpampum-icon-partial.XXXXXX")
trap 'rm -f "$partial_plist"' EXIT INT TERM
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
