# Salieri Next runtime resources

This directory contains independent local copies of the assets the Electron
scene host serves:

- `assets/spriteforge/runtime/kurisu/`: character animation clips, graph, mouth
  profiles, and all manifest-indexed KTX2 textures.
- `assets/images/`: room background, ambient layers, and subtitle frame.
- `render/web/`: scene drawing scripts (`renderer.js`, `wallpaper_scene.js`,
  PixiJS, Basis/KTX2 decoding) and `wallpaper_engine.html`.
- `wallpaper/crt_config.json`: authored room geometry.
- `LICENSE`, `LICENSES/`, `THIRD_PARTY_NOTICES.md`: copied license/provenance notices.

`wallpaper_engine.html` loads `/next/scene.js` and `/next/start.js` directly, so
its script list is the single source of truth for load order. The scene host no
longer rewrites the HTML; it only generates the tiny `/next/start.js` bootstrap.

## Asset provisioning

Development reads this directory directly. Packaging copies it to
`Contents/Resources/amadeus-assets`, including the character pack. Runtime assets
therefore no longer require the legacy checkout or an external path.

Some media are **intentionally not tracked by Git** (see `.gitignore`):

- `/resources/assets/images/*` — only `amadeus_desktop_wallpaper.png` is tracked;
  the ambient blend layers and subtitle frame are not.
- `/resources/assets/spriteforge/runtime/` — the character pack.

A fresh clone therefore cannot run a complete scene until those files are copied
in from the asset source. Nothing degrades hard: the room renders without an
ambient layer (the host logs a warning), and a missing character pack is
diagnosed and pruned while an available idle clip stays usable.

Large/private media stay local files under the existing Git ignore policy;
copying them does not change their original ownership or license.
