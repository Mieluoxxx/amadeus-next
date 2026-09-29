# Amadeus Next runtime resources

This directory contains independent local copies of the assets the Electron
scene host serves:

- `emote/`: locally provisioned FreeMote runtime and all four AB/C ordinary-clothes/white-coat model packs. Developer-local; excluded from packaging. The PSB parser is a pinned native artifact under `vendor/emote-loader/` (see `docs/emote-loader-integration.md`).
- `assets/idle/`: the idle scene stills and `scenario_graph.json`.
- `assets/images/`: room background, ambient layers, and subtitle frame.
- `render/web/`: room drawing scripts, PixiJS, retained Basis/KTX2 decoding,
  and `wallpaper_engine.html`. The legacy `renderer.js` is no longer loaded.
- `wallpaper/crt_config.json`: authored room geometry.
- `LICENSE`, `LICENSES/`, `THIRD_PARTY_NOTICES.md`: copied license/provenance notices.

`wallpaper_engine.html` loads `/next/scene.js` and `/next/start.js` directly, so
its script list is the single source of truth for load order. The scene host no
longer rewrites the HTML; it only generates the tiny `/next/start.js` bootstrap.

## Asset provisioning

Development reads this directory directly. Packaging copies it to
`Contents/Resources/amadeus-assets`, excluding `emote/` (see
`THIRD_PARTY_NOTICES.md`). Runtime assets therefore no longer require the legacy
checkout or an external path.

Provision the model and runtime once, from the project root:

```bash
npm run assets:emote -- ../amadeus-next-emote
```

The source argument is required and is used only during import. No symlinks are
created. The packaged app's scene error page can copy this prepared `emote/`
directory into its own `<userData>/emote/`; it never depends on the source path.

This copies the four upstream packs into `models/` under ASCII names —
`kurisu_ab`, `kurisu_ab_white`, `kurisu_c` and `kurisu_c_white` — including
model JSON, resource indexes, textures and binary resources, plus the source
READMEs. The upstream pack directories and their
inner file names are Japanese; the import renames them and rewrites the
pack-relative paths inside each `*.psb.m.resx.json` so no scene URL carries a
non-ASCII segment. Nothing else is rewritten: the parser reads those indexes
relative to the pack directory.
It downloads the pinned FreeMote v3.9 scripts once and verifies their
SHA-256 hashes (subsequent imports reuse valid local scripts). At runtime all
requests go to the loopback asset server; no CDN or sibling checkout is needed.
The HTML's `/emote/` base still serves the runtime; baked models are served from the read-only `/emote-cache/` route.
The scene continues to load the white-coat AB pack, explicitly selecting B
(crossed arms); copying the other packs does not add a model-switching UI.
The parser converts neutral `cw` alpha keyframes into legacy `opa` keyframes at
bake time and also exports the part-visibility lookup table, so the renderer can
keep writing head/body activation and mutually exclusive A/B sleeves every frame
without depending on an adapter module.
Layers and source art are not deleted or reordered to hide rendering errors.

Some media are **intentionally not tracked by Git** (see `.gitignore`):

- `/resources/assets/images/*` — only `amadeus_desktop_wallpaper.png` is tracked;
  the ambient blend layers and subtitle frame are not.
- `/resources/assets/audio/sfx/*.wav` — only `computer_use_keyboard_loop.wav` is
  tracked; other sound effects are not.
- `/resources/emote/` — imported runtime and private model resources.

A fresh clone therefore cannot run a complete scene until those files are copied
in from the asset source. Missing ambient layers do not stop the room. Missing
E-mote data produces a visible error and does not claim character/voice readiness.

Only the foreground monitor role is replaced. Computer-use and blackboard
background scenarios in the old Salieri checkout remain untouched; this import
does not migrate that separate scenario layer into Next. The packaged app ships
no `emote/` runtime or model packs; the idle scenario stills, other assets and the
retained texture decoders are copied unchanged.

The imported runtime is **CC BY-NC-SA 4.0**; the parser is a separate **Apache-2.0** project; character assets retain
their original rights. The FreeMote runtime and models are developer-local and
excluded from packaging; the Apache-2.0 parser and its notices are shipped. See
`LICENSES/FreeMote-NOTICE.md` before redistribution.
This is a local non-commercial compatibility preview: the old 3.9 runtime uses
`all_parts / 全体構造`, not all original top-level composition effects. Its heap
reserves 512 MiB, so smaller disk assets do not imply equally small RAM usage.
Rendering uses an 800×600 canvas at up to 2× pixel density and an existing Pixi
texture; moving between different-DPI screens requires a scene reload.

Large/private media stay local files under the existing Git ignore policy;
copying them does not change their original ownership or license.
