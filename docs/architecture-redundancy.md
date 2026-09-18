# 架构冗余审查与清理执行

状态：**A 档与 B 档已执行完成**（基线 commit `57cafb4`，全部改动可 `git diff` 复核）。
C 档与合规项未动。

清理结果：

```
9 files changed, 198 insertions(+), 7997 deletions(-)
```

| 文件 | 前 | 后 | 处置 |
|---|---|---|---|
| `resources/render/web/crt_canvas_surface.js` | 5,198 | **0** | 整个文件删除 |
| `resources/render/web/wallpaper_scene.js` | 2,445 | 663 | 删 scenarioRuntime / keyboardSfx / 运行时环境光生成器 / characterRuntime |
| `resources/render/web/renderer.js` | 1,825 | 1,016 | 删 SpriteForgeRuntime fallback / Live2DRenderer / SubtitleOverlay / 旧 WS bridge |
| `src/renderer/i18n/index.tsx` | 515 | 504 | 删 155 个孤儿键（373 个键值对），SETTING_COPY 对齐主进程 schema |
| `src/renderer/components/WorkPage.tsx` | 1,788 | 1,815 | mock 夹具改为 DEV 守卫的动态导入 |
| `resources/assets/audio/sfx/computer_use_keyboard_loop.*` | — | — | 删除（2 个文件，含 wav） |

验证：`npm run typecheck` ✓ · `npm test` 31/31 ✓ · `npm run build` ✓ ·
`npm run test:electron` ✓（真实 IPC + PCM 播放 + 表情 cue + drain + stale 拒绝）。

> 修正：本文档初版把 `scenarioRuntime` 记为 222 行——那是它内部 `tick` 方法的行号。
> 该对象实际是 **1,215 行**（473–1687）。清理量因此高于初版估计。

## 入口可达性基线

按 Vite 的 7 个入口做导入闭包遍历：

```
入口可达: 64 / 源文件总数: 66
不可达: src/renderer/env.d.ts、src/renderer/types.d.ts   （仅类型声明，tsc 使用，正常）
```

**TS/TSX 侧没有不可达模块。**冗余集中在 `resources/render/web/` 的 JS 层与契约失配的壳层。

## A 档 · 已执行

### A1. 双字幕渲染器 → 保留 `wallpaperSubtitle`，删除 `SubtitleOverlay`

`wallpaper_scene.js:2434` 曾把同一段文本同时喂给两套实现。抑制开关
`__DISABLE_RENDERER_SUBTITLE__` **被写两次、全仓库无读取点**——而同一 html 的
`__DISABLE_RENDERER_WS__` 被真正读取且行为正确，说明这是漏改。

处置：`wallpaperSubtitle` 是唯一字幕所有者（带 PNG 边框，功能更完整）；
删除 `renderer.js` 的 `SubtitleOverlay` 类、`RenderApp.setSubtitle`、
`characterRuntime.setSubtitle` 转发链，以及失效的 `defaultSubtitleEnabled` payload
字段（`sceneHost.ts`）。

### A2. 设置翻译层契约失配 → 已对齐

主进程只发 4 个 field key（`asr_language`、`FISH_API_KEY`、`FISH_VOICE_ID`、
`FISH_API_MODEL`）与 2 个 group id（`asr_local`、`speech_synthesis`）；
而 `ZH_SETTINGS`/`JA_SETTINGS` 曾维护 71 个遗留大写键（`ASR_BACKEND`、`TTS_BACKEND`、
`VTS_WS_URL`、`DEEPSEEK_*`、`CODEX_*`…），当前 schema 下命中数为 0 → zh/ja 一直回退英文。

处置：`SETTING_COPY` 缩减为与主进程 schema 匹配的键；`MESSAGES` 中 155 个静态无引用键
（`backend.*`、`artifact.*`、`session.*`、`chat.vision_*`、`chat.submode_*`、
`chat.pixi_render`/`switch_vts`/`current_render`/`expression_presets`/`transparent_overlay`、
`settings.field.*`、`settings.detail.*`、`settings.label.*_detail` 等）删除。
`chat.error.*` 保留——它由 `ScenePage` 运行时拼接（`code.startsWith('chat.error.')`）。

结果：孤儿键 **0**（扫描 `node /tmp/i18n3.mjs` 可复现）。

### A3. Mock 夹具移出生产包 → 保留 DEV 功能，构建时消除

两个夹具模块（`mockWorkTurn.fixture.ts` 425 行、`mockWorkboardPlayback.ts` 137 行）
的字符串曾进入 `dist/renderer/assets/index-*.js`。

处置：改为 `import.meta.env.DEV` 守卫的动态导入 + state。

```ts
useEffect(() => {
  if (!import.meta.env.DEV || !demoPlaybackRequested) return
  void Promise.all([import('./work/mockWorkboardPlayback'), import('./work/mockWorkTurn.fixture')])…
}, [demoPlaybackRequested])
```

生产构建把该 flag 替换为 `false`，整个 effect 连同 import 被消除。

验证：产物只剩一个 JS bundle（无 mock chunk），fixture 独有串已不在包内。
唯一的例外 `"Waiting for a work request."` 仍存在，因为 `workState.ts:16` 与
`workModels.ts:133` 也在**生产代码**里使用同一文案——那是合法的，不是泄漏。

### A4. `ambientUrl` 契约漂移 → 消费预烘焙资源，删除运行时生成器

主进程一直提供 `ambientUrl`（`amadeus_ambient_high_blend.png`），但
`wallpaper_scene.js` 只读 `ambientLowUrl`/`ambientDeltaUrl`，导致
`if (!this.ambientDeltaUrl)` 恒真、每次启动都跑 `_buildAmbientFromBackground`
——那是全项目唯一的 JS 逐像素循环（280,026 px）+ 两次全画布 blur。

处置：新增 `setAmbientHigh(payload.ambientUrl)` 消费预烘焙图；
删除 `_buildAmbientFromBackground`、`setAmbientDelta`、`ambientDeltaUrl` 状态与
`generated-mask` 分支。

**渲染行为保持**：生成器用 `BLEND_MODES.ADD`，预烘焙路径现在同样设置 ADD。

## B 档 · 已执行（legacy/standalone 路径整体移除）

前提确认：`wallpaper_engine.html` 的脚本表原本为 legacy 宿主 + Python
`runJavaScript` 设计；主人已决定不再支持 standalone。

| 项 | 行数 | 处置 |
|---|---|---|
| CRT canvas 工作台 | 5,198 | 删文件 + 从 html 脚本表移除 + 删 `canvasSurface`/`_externalCanvasHost`/`canvasBoundsAboveNixie` |
| 旧角色状态机 fallback（`SpriteForgeRuntime`） | 438 | 删除；`RenderApp` 现在要求 factory 存在，缺失即抛出明确错误 |
| Live2D 前景路径 | 72 | 删除类 + `_mode` 分支 + html `?live2d` 注入 |
| 场景活动引擎（`scenarioRuntime`） | **1,215** | 删除对象及全部调用点 |
| 键盘音效引擎（`keyboardSfx`） | 296 | 删除对象 + wav + LICENSE + `keyboardSfxUrl` payload |
| 旧 WS bridge | 130 | 删除；职责已由 `src/scene/index.ts` 的 MessagePort 承担 |
| `characterRuntime` 转发层 | ~20 | 删除；TS `src/scene/index.ts` 直接驱动注入的 `SpriteRenderer` |

连带清理：`sceneHost.ts` 的 `scenario`/`keyboardSfxUrl`/`defaultSubtitleEnabled` payload、
`desktopScene` 的 `_mode`/`setMode`/`setActivity`/`setWorkMode`/`setAsrStatus`、
`src/scene/index.ts` 的 `setAsrStatus` 调用、`wallpaperApp` 公开面从 26 个方法收缩到 3 个。

### 执行后的 renderer.js ↔ wallpaper_scene.js 契约

```
wallpaper_scene.js 调用: getPixiApp / setSpriteViewportBounds / setSpriteViewportMask
renderer.js 提供:       getPixiApp / setSpriteViewportBounds / setSpriteViewportMask
```

已用脚本验证**差集为空**（无"被调用但未提供"的方法）。
`wallpaper_engine.html` 的就绪探针依赖 `renderApp._sprite`，仍保留。

## C 档 · 保留（不要动）

| 项 | 为什么不是冗余 |
|---|---|
| `SpriteRenderer` vs TS 状态机 | 职责分层：前者是 Pixi 帧/嘴型/纹理的低层驱动，后者是高层图状态控制 |
| `chatWorkActivity.ts` vs `work/workProjection.ts` | 前者是 provider **attempt**，后者是 WorkItem/acceptance；合并会破坏"不得把 attempt 成功当验收"的约束 |
| `WorkPage` / `SettingsPage` | 都经 `ScenePage` 可达，是当前唯一的工作台/设置实现 |
| `FluentIcon.tsx` | 只是 lucide-react 的命名适配层，没有引入第二套图标依赖 |
| `chat.error.*` i18n 键 | 运行时由 `code.startsWith('chat.error.')` 拼接，静态扫描看不到引用 |

## 未执行 · 需要产品决策

| 项 | 行数 | 现状 | 选择 |
|---|---|---|---|
| MCP 连接编辑器 | `McpConnections.tsx` 561 | `main/index.ts:437` 永远返回 `mcpConnections: [], mcpConnectionsLocked: true` | 接真实数据源，或不在 Settings 里挂载 |
| Provider 选择器 | `lib/chatProviders.ts` 24 | `CHAT_PROVIDER_OPTIONS` 只有一项 `Pi`，却渲染成下拉框；主进程也不消费 `llm_provider` | README 明确"不增加 provider registry"，单选项应改成静态状态或删 |

这两项是"半实现的功能"而非"不可达的代码"，删除会移除 UI 入口而不只是死代码，
因此留给主人决定。

## 仅剩的清理项（非架构）

- `LICENSE` 与 `resources/LICENSE` md5 相同（同一文件两份）。
- 空目录 `wasm/`、`dist/wasm/`：旧 receive-side WASM meter 的残留。
- `sources`/`locked`/`secrets` 的空壳：`desktopSettings()` 返回 `sources: {}` 与
  `locked: {}`，而 `SettingsPage.tsx:302,308` 会读取它们（当前恒为默认值）——
  属于"契约已声明但未填充"，不是冗余，接了真实来源才有意义。

## 独立问题：第三方 notices 与证据漂移（合规审查项）

`resources/THIRD_PARTY_NOTICES.md` 引用 10 个证据文件，实际只有 2 个存在
（`FIRST-PARTY-BRAND-ASSETS.md`、`pixi-basis-ktx2-MIT.txt`）。

其中 5 项属于本项目并未包含的组件（GPT-SoVITS、Bert-VITS2、AP-BWE、Live2D Cubism
Core、pixi-live2d-display）；`provenance.json` 是来源清单而非组件。注意 Live2D 的
**前端代码**本次已删除，但 notices 的处理仍需合规判断——
**本文档只指出 notices 声明的证据与仓库现状不一致，不给出删除建议。**
