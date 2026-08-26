#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_root="$repository_root/platforms/macos"
output_root="$package_root/dist"
app_root="$output_root/PimpampumMenuBar.app"

swift build --package-path "$package_root" --configuration release
binary_root=$(swift build --package-path "$package_root" --configuration release --show-bin-path)

rm -rf "$app_root"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$binary_root/PimpampumMenuBar" "$app_root/Contents/MacOS/PimpampumMenuBar"
cp "$package_root/Resources/Info.plist" "$app_root/Contents/Info.plist"
chmod 755 "$app_root/Contents/MacOS/PimpampumMenuBar"
/usr/bin/plutil -lint "$app_root/Contents/Info.plist"

printf '%s\n' "$app_root"
