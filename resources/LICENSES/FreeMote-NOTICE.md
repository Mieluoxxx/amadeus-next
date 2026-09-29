# FreeMote / E-mote local integration

- Runtime: FreeMote-SDK WebGL v3.9, Ulysses / Project AZUSA (2018).
  <https://github.com/Project-AZUSA/FreeMote-SDK/tree/4340e8fc2138f013157d5b9cd40ba17d01347093/WebGL/driver>
- Revision: `4340e8fc2138f013157d5b9cd40ba17d01347093`.
- The driver header states **CC BY-NC-SA 4.0**:
  <https://creativecommons.org/licenses/by-nc-sa/4.0/>
  Legal code: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>.
- `scripts/provision-emote.mjs` downloads the two unmodified runtime scripts,
  verifies SHA-256, and preserves their headers. The runtime is not checked in.
- The `psb.mjs` adapter is imported from the owner's local `amadeus-next-emote`
  project. The importer verifies the upstream source byte-for-byte against a
  pinned SHA-256 and applies exactly one substitution: the `./红莉栖E-mote模型/`
  base path becomes the ASCII `./models/`. No parser or compatibility change is
  applied to it.
- License of that adapter is unresolved: the copied README declares CC BY-NC-SA
  4.0 (`resources/emote/SOURCE-README.md`), while the current upstream of the
  same code declares AGPL-3.0 for its own `*.mjs` sources. See
  `docs/emote-adapter-upgrade-assessment.md`.
- The four Kurisu AB/C packs, each in ordinary clothes and a white coat, are
  imported locally. The scene currently selects white-coat B from the AB pack.
  E-mote is developed by **M2**.
  Character images, models, and animation remain the original rights holders'
  property. The runtime license grants no rights to distribute those assets.

This integration is for local non-commercial evaluation. Imported material is
not relicensed under the project's Apache License 2.0. Public redistribution and
commercial use require a separate rights review.

`resources/emote/` is excluded from the packaged app: `package.json` filters it
out of `extraResources`, so a built artifact ships no CC BY-NC-SA runtime code.
The directory stays a developer-local asset produced by
`npm run assets:emote`, which fetches the FreeMote driver from jsDelivr under its
own license and copies the adapter and model packs from a sibling checkout the
developer supplies. It is also excluded from Git; see `.gitignore`.

## Planned replacement: clean-room Rust runtime

The WebGL driver and `emoteplayer.js` are CC BY-NC-SA 4.0; the `psb.mjs` adapter
is CC BY-NC-SA 4.0 or AGPL-3.0 depending on which upstream declaration governs
(see above). All three are scheduled to be replaced by an independently written
Rust runtime so that Amadeus no longer depends on a noncommercial, copyleft
runtime.

Clean-room means the replacement is written without reading the CC BY-NC-SA /
AGPL-3.0 sources, and keeps no copied structure, naming or tables from them.
Working from the public PSB/E-mote format description and from observable
behaviour is what makes the replacement independently licensable; porting or
translating the existing JavaScript would carry the ShareAlike — or AGPL —
obligation into the new code and defeat the purpose.

The swap is cheap by construction: `src/scene/emote.ts` is the only consumer of
the runtime. Everything downstream (`src/scene/index.ts` and the React layer)
uses the `EmoteCharacter` interface, so a new backend has to satisfy that type
plus the small player surface `emote.ts` calls, not the FreeMote API shape.
