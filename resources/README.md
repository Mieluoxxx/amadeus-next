# Salieri Next runtime resources

This directory contains independent local copies of the resources used by Next:

- `assets/spriteforge/runtime/kurisu/`: 39 animation clips, graph, mouth profiles,
  and all manifest-indexed KTX2 textures.
- `assets/images/`: room background, two ambient layers, and subtitle frame.
- `assets/audio/sfx/`: keyboard sound and its license notice.
- `render/web/`: scene drawing scripts, PixiJS, and Basis/KTX2 decoding files.
- `wallpaper/crt_config.json`: authored room geometry.
- `LICENSE`, `LICENSES/`, `THIRD_PARTY_NOTICES.md`: copied license/provenance notices.

The source copies came from the same relative paths in the legacy repository.
They are regular independent files, not symlinks. Changes to the old asset tree
are not synchronized into Next automatically.

Development reads this directory directly. Packaging copies it to
`Contents/Resources/amadeus-assets`, including the character pack. Runtime
assets therefore no longer require the legacy checkout or an external path.
Large/private media remain local files under the existing Git ignore policy;
copying them does not change their original ownership or license.
