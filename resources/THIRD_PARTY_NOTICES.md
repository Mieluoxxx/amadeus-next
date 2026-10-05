# Third-party notices

Amadeus first-party code, documentation, modifications, and recorded original
brand assets are published under the Apache License 2.0 (see the repository root
`LICENSE`). That license does not replace or narrow third-party rights.
Publishing components in the same repository does not change their existing
MIT, Apache-2.0, CC-BY-NC-SA, or proprietary terms.

This file records source and license evidence for third-party material checked
into the Amadeus repository. Package-manager dependencies are accounted for by
`package.json` / `package-lock.json` rather than duplicated here.

## Affiliation and commercial status

Amadeus is an unofficial community fan project. It is **not affiliated with,
endorsed by, or connected to** MAGES., Nitroplus or 5pb., nor with any other
rights holder of the Steins;Gate franchise.

The project is maintained as a hobby and is **not operated as a commercial
activity**. No fee is charged for the software, and the maintainers offer no
commercial support, hosting or distribution. The Apache-2.0 grant covers
first-party code and documentation only; it grants no right to character, model,
voice or other third-party material, and is not a substitute for one.

## Not bundled with the packaged application

The following components are developer-local only. `package.json` filters
`character/emote/**` (and legacy `emote/**`) out of `extraResources`, so no distributed artifact contains them.

### FreeMote / E-mote runtime

- Runtime: FreeMote-SDK WebGL v3.9, Ulysses / Project AZUSA (2018).
  Revision `4340e8fc2138f013157d5b9cd40ba17d01347093`.
- License: **CC BY-NC-SA 4.0**, stated in the driver header. Noncommercial.
- `scripts/provision-emote.mjs` fetches the two unmodified runtime scripts from
  jsDelivr, verifies SHA-256, and preserves their headers. The runtime is not
  checked in.
- The four Kurisu AB/C model packs are unpacked game assets whose rights are
  held by the original publisher and are not cleared for redistribution at all.
  See `LICENSES/FreeMote-NOTICE.md`.

Neither the runtime nor the model packs may be redistributed. Both are excluded
from any shipped artifact.

### Idle scene stills

The stills under `character/idle/` (formerly `assets/idle/`) have no recorded
source, license, or consent, and reproduce character art whose rights stay with
the original publishers. They are not covered by the repository's code license.
See `resources/README.md` for their current tracking and packaging status.

## Bundled

## PixiJS

- Source: <https://github.com/pixijs/pixijs>
- Checked-in bundle: PixiJS v7.4.3, loaded by `scene/stage/index.html` (formerly `render/web/wallpaper_engine.html`)
- License: MIT
- Local evidence: notice retained in `scene/stage/vendor/pixi.min.js`.

## First-party brand assets

See `LICENSES/FIRST-PARTY-BRAND-ASSETS.md` for the checked-in first-party
wallpaper and its license scope.

This is an engineering provenance record, not legal advice.
