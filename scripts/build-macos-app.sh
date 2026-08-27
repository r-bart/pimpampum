#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_root="$repository_root/platforms/macos"
output_root="$package_root/dist"
app_root="$output_root/PimpampumMenuBar.app"
compact_mark="$package_root/Resources/PimpampumCompact.pdf"
app_icon="$repository_root/branding/app-icon/Pimpampum.icon"

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
xcrun actool "$app_icon" \
  --compile "$app_root/Contents/Resources" \
  --platform macosx \
  --minimum-deployment-target 13.0 \
  --app-icon Pimpampum \
  --output-partial-info-plist "$partial_plist" \
  >/dev/null

for icon_artifact in Assets.car Pimpampum.icns; do
  if [ ! -f "$app_root/Contents/Resources/$icon_artifact" ]; then
    printf 'Icon Composer did not produce %s\n' "$icon_artifact" >&2
    exit 1
  fi
done

if [ "$(/usr/bin/plutil -extract CFBundleIconName raw -o - "$partial_plist")" != "Pimpampum" ]; then
  printf 'Icon Composer returned an unexpected app icon name.\n' >&2
  exit 1
fi

chmod 755 "$app_root/Contents/MacOS/PimpampumMenuBar"
/usr/bin/plutil -lint "$app_root/Contents/Info.plist"

printf '%s\n' "$app_root"
