# macOS artifact source provenance

The packaged macOS app is bound to its reviewed sources by `sourceInputSha256`, recorded in
`platforms/macos/dist/PimpampumMenuBar.artifact.json` at approval time and re-verified on every
later check, including `prepack`.

That hash was not reproducible. `macosSourceHash()` enumerated build inputs with a recursive
`readdirSync` walk and hashed every regular file it found. The walk has no notion of the Git index,
so any ignored working-tree file inside `platforms/macos/Sources`, `platforms/macos/Resources`,
`branding/app-icon`, or the build script was hashed as if it were reviewed source.

On macOS, Finder writes `.DS_Store` into directories a user browses. The Finder-reveal behaviour of
the menu-bar app is exercised by hand during live testing, in exactly those directories. Approvals
therefore recorded a hash covering files that were never committed and never reviewed.

The failure was silent in both directions. `approvedSourceCommit()` refuses to approve from a dirty
tree, but it calls `git status --porcelain --untracked-files=all`, which does not report ignored
files — so the approval gate saw a clean, reviewed tree while the hash it wrote did not describe
one. Verification then failed anywhere the stray file was absent, which is every machine except the
one that approved. Recomputing the hash from committed content at four separate approval commits
(`2288026`, `5234eb2`, `1373dc5`, `be040c7`) reproduced none of them.

Enumeration now comes from `git ls-files --cached` over the same source paths. Content is still
read from the working tree, so local modifications continue to move the hash; only the file _set_
is taken from the index. A stray ignored file can no longer rebind artifact identity to content
nobody reviewed.

## Test placement

`test/macos-package-artifact.test.ts` is `describe.skipIf(process.platform !== 'darwin')`, so the
Linux lane in CI executed none of it and this defect was invisible there for its whole lifetime.
The hashing logic moved into `scripts/macosSourceHash.mjs` so that
`test/macos-source-hash.test.ts` can cover it on any platform, against a temporary Git fixture
built under an isolated Git environment.

## Consequence

Every previously approved `sourceInputSha256` is invalid, and the recorded macOS live evidence is
bound to those values. The artifact must be re-approved and the live evidence re-recorded on the
target Mac before a V1 tag is authorized.
