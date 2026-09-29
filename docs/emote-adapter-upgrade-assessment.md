# E-mote 适配器升级与重导入链路评估

结论：上游 `../amadeus-next-emote` 的 `psb.mjs` 相对我们 pin 的版本**只有 i18n 重构**，
没有渲染、PSB 编码、部件显隐或 `cw` 适配行为的改动；模型数据也逐字节相同。因此
**不建议现在重锁 pin**：收益为零，代价是新引入一个运行时依赖文件 `i18n.mjs`、一条
key→文案的消费契约，以及代码声明许可从 CC BY-NC-SA 4.0 变成 **AGPL-3.0** 这个需要
主人定性的问题。

`npm run assets:emote` 保持"校验 pin，不符就停下等复核"的设计即可——它现在报错是
**正确行为**，不是故障。下面每条都带代码位置与实测依据。

## 1. 两份适配器的差异

| 项 | pin 版本（本地运行中） | 上游当前版本 |
|---|---|---|
| 行数 | 226 | 227 |
| 导出面 | `nameTable` / `encodePsb` / `partVariables` / `prepareModel` / `loadModel` | 完全一致，签名一致 |
| 依赖 | 无 | `import { fail } from "./i18n.mjs"` |
| 进度回调 | `report("读取模型与资源索引…")` 等中文串 | `report("status.readingIndex", {…})` 等 key |
| 异常 | `throw new Error("中文…")` | `throw fail("error.xxx", {…})` |

全部 35 处改动都是文案外置，**没有任何算法分支被触碰**：

- `fail(key, params) = Object.assign(new Error(key), { i18n: { key, params } })`
  （`../amadeus-next-emote/i18n.mjs:2`）——注意 `error.message` 从此是 key，不是文案。
- `psb.mjs:17/47/129/147/190` 五个导出的函数体，除文案与 import 外逐行相同。

## 2. 模型数据差异

| 对比项 | 结果 |
|---|---|
| 4 个 pack 的 `*.psb.m.json` | 四次 `cmp` 全部逐字节相同 |
| 4 个 pack 除 `*.resx.json` 外的文件内容集 | 哈希相同（`resx.json` 差异来自我们自己的路径前缀重写） |
| pack 目录名 | 上游仍是日文原名，未变 |

即：重导入不会带来任何素材更新，也不会改变渲染结果。

## 3. 采纳它的真实代价（不是一次哈希 bump）

| 影响面 | 事实 | 位置 |
|---|---|---|
| 新增文件依赖 | 适配器现在 `import "./i18n.mjs"`；provision 只写 `psb.mjs`，运行时会 404 导致整个模块加载失败 | `scripts/provision-emote.mjs:42` |
| 进度文案变 key | `report` 回调直接写进 `#amadeus-diagnostic`，界面会显示 `status.decodingAtlas`，且 `{index,total}` 参数丢失 | `src/scene/emote.ts:112`、`:124`、`src/scene/index.ts:42` |
| 异常文案变 key | 失败链是 `String(error)`，会显示成 `Error: error.cwColor` | `src/scene/index.ts:274` |
| 许可声明层 | 该仓库自有代码现声明 **AGPL-3.0**；我们 notice 记的是 CC BY-NC-SA 4.0 | `resources/LICENSES/FreeMote-NOTICE.md`、`../amadeus-next-emote/README.md:110` |

## 4. 若将来决定采纳：最小改法（约 20 行）

1. `scripts/provision-emote.mjs`：pin 换成 `ffc51c2…`；额外拷 `i18n.mjs`。
   base 路径断言仍然成立——上游 `psb.mjs:191` 依旧是 `./红莉栖E-mote模型/${name}/`，
   甚至连上游自己的 `AGENTS.md:28` 都把"中文目录名硬编码"写成了它的契约。
2. `src/scene/emote.ts`：一行**对两版都成立**的包装——
   `loadModel(model, (key, values) => report(translate('zh', key, values)))`，
   其中 `translate` 从 `/emote/i18n.mjs` 动态导入（与现有 `moduleUrl` 同一手法）。
   旧适配器传的是中文串，`translate` 查不到 key 时原样回落，因此包装不绑定版本。
3. 失败路径：`error?.i18n?.key ? translate('zh', key, params) : String(error)`。
4. 验证：`npm run typecheck` + `npm test` + `npm run test:electron`（含 white-coat B 用例）。

`i18n.mjs` 的 `pickLanguage` / `applyTranslations` 只在调用时触碰 `location`/`document`，
从场景 iframe 里 import 它是安全的；`psb.mjs` 本身只用 `fail`。

## 5. `tex#000-texture.png` 的 `#`（本次未动）

- **现状可用**：`loadModel` 用 `encodeURIComponent` 逐段编码，`#` → `%23`；4 个 pack
  共 23 个资源经 `SceneHost` 实拉全部 200（含 `image/png` 类型）。
- **会坏的地方**：任何不做编码的路径拼接（`base + path`）、`file://` 直开、部分
  打包/同步工具。我们自己的 `sceneHost.ts` 走 `URL` + 切片，不在此列。
- **改法**：与包名 ASCII 化同一套机器（重命名 + resx 前缀重写），4 包 × 5 个文件。
  风险低，但收益只在上面那几种场景里兑现。
- **建议**：暂留，等真出现无法编码的消费者再说。

## 6. 已执行的事实更正（与上面的决策无关）

- `scripts/provision-emote.mjs` 的源默认路径：`../salieri-next-emote` → `../amadeus-next-emote`。
- `resources/LICENSES/FreeMote-NOTICE.md`：源项目名、"unmodified adapter" 的说法、
  pin 的描述与实际导入行为对齐（pin 校验上游原始字节，导入时仅替换一处 base 路径常量）。

## 7. 待主人决定

1. pin 保持 `165d3ae…`（建议）还是升到 `ffc51c2…`？
2. 适配器（`psb.mjs` + `i18n.mjs`）按 AGPL-3.0 还是沿用原 CC BY-NC-SA 记录？
   这直接决定 notice 该怎么写，也决定"clean-room Rust 替换"的紧迫程度。
3. `#` → `_` 现在做还是留？
