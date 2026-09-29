# FreeMote / E-mote local integration

- Runtime: FreeMote-SDK WebGL v3.9, Ulysses / Project AZUSA (2018).
  <https://github.com/Project-AZUSA/FreeMote-SDK/tree/4340e8fc2138f013157d5b9cd40ba17d01347093/WebGL/driver>
- Revision: `4340e8fc2138f013157d5b9cd40ba17d01347093`.
- The driver header states **CC BY-NC-SA 4.0**:
  <https://creativecommons.org/licenses/by-nc-sa/4.0/>
  Legal code: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>.
- `scripts/provision-emote.mjs` downloads the two unmodified runtime scripts,
  verifies SHA-256, and preserves their headers. The runtime is not checked in.
- The PSB parsing/compatibility layer is **no longer copied in**. It lives in a
  separate repository (`amadeus-emote-loader`, **Apache-2.0** — the same terms
  as this project). A pinned native artifact is stored under `vendor/emote-loader/`
  with its revision, SHA-256 and licenses; build/dev only verify and copy it.
  The renderer consumes its baked
  output (`*.psb` plus a `*.meta.json` sidecar) and no longer imports any
  first-party adapter module, so the earlier unresolved adapter licence
  (CC BY-NC-SA 4.0 vs AGPL-3.0, depending on which upstream declaration governs)
  is moot — that code is gone.
  See `docs/emote-loader-integration.md`.
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
own license and copies model packs from an explicit source directory supplied by
the developer. It does not copy an adapter or create symlinks. It is also excluded
from Git; see `.gitignore`. The packaged app may copy user-provided resources into
its own user-data directory; this does not grant redistribution rights.

## 状态：适配器已替换，引擎仍在

原先计划用一套自写的运行时替掉全部三层。**实际做到的**是换掉了代码那层：

- ✅ `psb.mjs` 适配层已删除，改为独立仓库 `../amadeus-emote-loader`（Apache-2.0）编译出的原生工具。
  它的兼容转换按可观察行为重写，没有沿用原适配器的结构或命名。
- ⚠️ **FreeMote WebGL 驱动与 `emoteplayer.js` 仍是 CC BY-NC-SA 4.0**，没有替换。
  也就是说 Amadeus 仍然依赖那份非商业、copyleft 的运行时二进制 —— 这是有意保留的：
  E-mote 引擎本身是 M2 的闭源产品，自写一个能在保真度上替代它的引擎不在计划内。

因此这一层的约束没变：运行时仅限本地非商业使用，本项目不分发它。
`src/scene/emote.ts` 仍是运行时的唯一消费者；`src/scene/index.ts` 与 React 层只用
`EmoteCharacter` 接口，所以将来若要换后端，需要满足的是那个类型而不是 FreeMote 的 API 形状。
