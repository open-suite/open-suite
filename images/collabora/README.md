# Open Suite Collabora CODE image

`ghcr.io/open-suite/collabora` is the digest-pinned upstream
`collabora/code:26.04.1.4.1` image with one source-owned fix for the classic
menubar's SmartMenus lifecycle.

The reviewable source change is
[`patches/smartmenus-lifecycle.patch`](patches/smartmenus-lifecycle.patch),
against Collabora Online tag `cp-26.04.1-4` (peeled commit
`7d478de54b81a47d88ad4cf71180b9ceeb466848`). CODE ships only the compiled
`browser/dist/bundle.js`, so `patch-smartmenus-lifecycle.pl` applies the exact
equivalent change to that bundle and refuses to build if any upstream fragment
does not occur exactly once.

The fix makes the first refresh return after the recursive document-layer
initialization, destroys the existing SmartMenus instance before each later
menu subtree rebuild, and destroys it again before the menubar container is
removed.

CI checksum-pins and patches the authoritative source file, builds an amd64
contract image, inspects its runtime bundle and inherited image configuration,
then publishes amd64 and arm64 images. Release tags are the upstream version and
`sha-<commit>`.

Run the repository-side contracts with:

```sh
node ci/test-collabora-image-runtime.mjs
```
