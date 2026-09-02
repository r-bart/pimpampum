# Reproducing the Omarchy runtime digests without a second tag

**Date**: 2026-09-02
**Type**: Runbook + measurement
**Branch**: `remediation/deep-review`

## The problem this solves

`integrations/omarchy/pimpampum-status/runtime-manifest.json` pins the two Linux runtime archives by
`sha256`. The release workflow's `runtime-manifest` job rebuilds those archives and refuses the tag
if a pin differs. Until now the accepted way to get the right digests was to tag once, read them
from the failing job, commit them, and tag again. The `v1.2.11` release took four attempts.

A local build does not help by itself. Measured on this Mac at tag `v1.2.11`:

| Build host                           | linux-arm64 digest                                                 |
| ------------------------------------ | ------------------------------------------------------------------ |
| macOS 26 (arm64), Node 24.19.0       | `260ff2f3a69a7514d0aaa319bb60b0f0f4356215cd64caf72171e5ff86cd48d3` |
| `node:24.19.0-bookworm`, linux/arm64 | `56f7045ead8887025ce86171c23bb4139c0eb4933c133b6cbad651fa19d4dbf3` |
| What CI pinned at `v1.2.11`          | `56f7045ead8887025ce86171c23bb4139c0eb4933c133b6cbad651fa19d4dbf3` |

The container matches CI exactly. The macOS build does not, even though both produce the same file
count (2,490) and the same unpacked size (149,827,394 bytes), so the difference is metadata inside
the archive rather than its contents.

## The recipe

Build each target in a container whose platform matches the target. Run it from a clean worktree so
the repository's own `node_modules` and `dist/` are not involved.

```bash
W=$(mktemp -d)/repro
git worktree add --detach "$W" <ref>

cat > "$W/container-build.sh" <<'SH'
set -e
rm -rf node_modules dist out-*
npm ci --no-audit --no-fund >/dev/null 2>&1
node scripts/build-runtime-bundle.mjs --target "$1" --output "/work/out-$1"
cat "/work/out-$1/pimpampum-runtime-$2-$1/archive-sha256.json"
SH

for target in linux-arm64 linux-x64; do
  case "$target" in
    linux-arm64) platform=linux/arm64 ;;
    linux-x64)   platform=linux/amd64 ;;
  esac
  docker run --rm --platform "$platform" \
    -v "$W":/work -w /work -e HOME=/tmp --user "$(id -u):$(id -g)" \
    node:24.19.0-bookworm sh /work/container-build.sh "$target" <version>
done
```

Then write the two digests into `runtime-manifest.json` with the release URLs, and confirm locally:

```bash
node scripts/check-reviewed-runtime-manifest.mjs <bundles-root>
```

## What matters and why

- **The container's Node must be 24.19.0.** That is the version the `runtime` job pins with
  `setup-node`, and it supplies the zlib that gzips the archive.
- **The platform must match the target.** `npm ci` resolves platform-specific optional packages, and
  the bundle carries the target's `better-sqlite3` addon. On Apple Silicon, `--platform linux/amd64`
  runs under emulation; emulation changes the speed, not the bytes.
- **Run as your own uid.** Without `--user`, the container writes root-owned files into the
  worktree and the next step cannot clean them.
- **Use a worktree, not the checkout.** The build runs `npm run build` and `npm ci` in the
  repository root it is given, so pointing it at the working tree destroys `dist/` and
  `node_modules` while other work is in flight.
- **The archive itself is already deterministic.** `build-runtime-bundle.mjs` writes its own tar
  with mtime 0, uid and gid 0, sorted entries and fixed modes, and gzips with Node's `zlib`. The
  pinned Node tarball is verified by `sha256`. That is why one container run is enough.

## What is not proven

One container run per target was compared against CI. Determinism across container runs was not
measured here; CI's own claim is that it reproduces the digests exactly across runs, and the single
comparison above is consistent with that. If a digest ever disagrees with the release job, treat the
job as the authority and copy from its `generated-runtime-manifest` artifact.
