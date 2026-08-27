#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app_root=${1:-"$repository_root/platforms/macos/dist/PimpampumMenuBar.app"}

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'macOS distribution verification requires macOS.\n' >&2
  exit 1
fi

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_root"
signature=$(/usr/bin/codesign -dvvv "$app_root" 2>&1)
case "$signature" in
  *"Authority=Developer ID Application:"*"TeamIdentifier="*) ;;
  *)
    printf 'The app is not signed with a Developer ID Application identity.\n' >&2
    exit 1
    ;;
esac

/usr/sbin/spctl --assess --type execute --verbose=2 "$app_root"
xcrun stapler validate "$app_root"
printf 'Verified Developer ID signature, notarization ticket, and Gatekeeper acceptance.\n'
