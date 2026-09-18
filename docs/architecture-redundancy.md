# 架构冗余审查

审查范围：整个仓库（`src/`、`resources/render/web/`、`native/`、`scripts/`、打包配置）。
方法：入口可达性分析 + 跨模块契约核对 + 逐项功能对照，每条都附代码位置与可复现命令。
**未跑运行时 profile**，因此本文档只陈述静态可证事实，不含量化收益承诺。

报告按可行动性分三档，另设一节"看起来冗余但其实不是"，避免把兼容层误判为死代码。

- **A 档 · 立即修复**：现状即缺陷，修法明确，不依赖产品决策。
- **B 档 · 产品决策后隔离**：仅在当前 Electron 宿主中不可达；删或独立打包，取决于是否继续支持 legacy/standalone 模式。
- **C 档 · 保留**：职责不同或本就该存在，不要合并。

## 入口可达性基线

严格按 Vite 的 7 个入口（`src/main/index.ts`、`pi-worker.ts`、`src/preload/index.ts`、
`src/renderer/main.tsx`、`src/scene/index.ts`、`audioWorklet.ts`、`scripts/build.mjs`）做
相对导入 + `@/` 别名的闭包遍历：

```
入口可达: 64 / 源文件总数: 66
不可达: src/renderer/env.d.ts、src/renderer/types.d.ts   （仅类型声明，tsc 使用，正常）
```

结论：**TS/TSX 侧没有不可达模块**。`WorkPage`、`SettingsPage`、`McpConnections` 都经
`ScenePage → sceneAuxiliary → WorkPage` / `ScenePage → SettingsPage` 可达，不是死页面。
冗余集中在 **`resources/render/web/` 的 JS 层（共 9,470 行）与契约失配的壳层**。

## A 档 · 立即修复

### A1. 双字幕渲染器 —— `__DISABLE_RENDERER_SUBTITLE__` 只写不读

同一次调用同时驱动两套字幕：

```js
// wallpaper_scene.js:2434-2441
setSubtitle(text) {
  const value = String(text || "");
  desktopScene._lastSubtitleText = value;
  if (value) scenarioRuntime.noteActivity();
  wallpaperSubtitle.setText(value);                                    // 94-193,  100 行，带 PNG 边框
  characterRuntime.setSubtitle(desktopScene._defaultSubtitleEnabled ? value : "");
  //   ↑ callRender → renderer.js:1591 renderApp.setSubtitle → SubtitleOverlay.setText（1486-1530, 45 行）
  desktopScene._scheduleSubtitleClear(value);
}
```

抑制开关被写了两次、**全仓库没有任何读取点**：

```
$ grep -rn "__DISABLE_RENDERER_SUBTITLE__" resources/render/web/ src/
wallpaper_engine.html:35      window.__DISABLE_RENDERER_SUBTITLE__ = true;
wallpaper_scene.js:1975       window.__DISABLE_RENDERER_SUBTITLE__ = !this._defaultSubtitleEnabled;
（无读取）
```

对照：`__DISABLE_RENDERER_WS__` 在 `renderer.js:1695` 被真正读取，说明原设计意图就是
"由宿主关掉 renderer 自带的字幕/WS"，只是字幕那半没实现。

`sceneHost.ts:79` 传 `defaultSubtitleEnabled: true` → 条件恒真 → **两套字幕实现都收到同一段文本并各自绘制**。
两者位置/样式不同（`wallpaperSubtitle` 带 PNG 边框，`SubtitleOverlay` 是纯文本层），
是否在同一位置同屏可见需要运行时目视确认；静态可证的是"双份写入 + 双份绘制工作 + 一层冗余状态"。

同一个 html 里设了两个抑制开关，只有 WS 那个被真正读取（`renderer.js:1695`，行为正确）——
这说明 A1 是漏改而非设计意图。

修法：在 `SubtitleOverlay.setText` 或 `RenderApp.setSubtitle` 里真正读取该开关
（1 行），或让 `wallpaper_scene.js:2439` 不再转发。先定字幕归属者，再删另一套。

### A2. 设置翻译层契约失配（zh/ja 一直回退英文）

```ts
// i18n/index.tsx:425
export function translateSetting(locale, kind, id, fallback) {
  return SETTING_COPY[locale][kind][id] ?? fallback
}
```

- 主进程发的 field key 是**小写配置键**：`asr_language`、`FISH_API_KEY`、`FISH_VOICE_ID`、`FISH_API_MODEL`（`main/index.ts:450-472`）。
- `ZH_SETTINGS.field` 维护的是**遗留大写环境变量名**，共 71 个：`ASR_BACKEND`、`TTS_BACKEND`、`VTS_WS_URL`、`DEEPSEEK_API_KEY`、`CODEX_APP_SERVER_MODEL` …
- `SETTING_COPY['en-US']` 的 `field` / `description` / `groupDescription` **全是空对象**（`i18n/index.tsx:418`），英文靠主进程硬编码 `label: 'Recognition language'` 兜底。

可复现的匹配率：

```
main 提供的 field key: asr_language, FISH_API_KEY, FISH_VOICE_ID, FISH_API_MODEL
ZH_SETTINGS.field 键数: 71
按小写直接匹配的交集: (空)
大写化后匹配: ASR_LANGUAGE（仍因大小写不同取不到）
```

即在**当前主进程 schema 下命中数为 0**：主进程只发出这 4 个 id，没有一个能在 zh/ja 表里查到。
表中 71 个键里 70 个属于遗留 schema（`ASR_BACKEND`、`TTS_BACKEND`、`VTS_WS_URL`、
`DEEPSEEK_*`、`CODEX_*` 等），对应的是本项目当前并未包含的后端。

后果：中文/日文界面在 ASR/TTS 卡片上显示英文标签（回退到主进程硬编码 label）。
那 70 个键的去留取决于是否恢复这些后端，不是无条件可删。

修法：主进程输出稳定规范化 schema，renderer 只保留当前真实存在的键
（`asr_language`、`FISH_API_KEY`、`FISH_VOICE_ID`、`FISH_API_MODEL`），并补齐 `en-US` 表。

### A3. Mock 回放夹具进了生产包

```
src/renderer/components/work/mockWorkTurn.fixture.ts   425 行
src/renderer/components/work/mockWorkboardPlayback.ts  137 行
WorkPage.tsx:14-15,166,286-331,1489-1520...            散落分支
```

开关是 `import.meta.env.DEV && searchParams.get('workDemo') === '1'`（`WorkPage.tsx:166`）。
生产构建里 `import.meta.env.DEV` 被替换为 `false`，但**字符串与代码仍在包内**（已核验）：

```
$ node -e "...在 dist/renderer/assets/index-CUlBxAgh.js 里搜 fixture 独有串..."
在包内  "Waiting for a work request."
在包内  "Refined active work layout"
在包内  "electron/src/renderer/components/WorkPage.tsx"
（bundle 647,961 字节）
```

修法：把 fixture 与回放适配器抽成 **DEV 专用、可懒加载的模块**，让 Rollup 整块剔除。
`WorkPage` 的渲染是同步的，不能直接在函数体里裸 `await import()`；可行做法是把 mock 分支
抽到独立组件后用 `React.lazy` + `Suspense`，或仅在 `import.meta.env.DEV` 下动态 import。
这是纯收益、无决策成本。

### A4. `ambientUrl` 契约漂移（已在上一份性能报告详述）

`sceneHost.ts:75` 传 `ambientUrl`，`wallpaper_scene.js:1780-1781` 只消费
`ambientLowUrl`/`ambientDeltaUrl` → `if (!this.ambientDeltaUrl)` 恒真 → 每次启动都跑
`_buildAmbientFromBackground`（`wallpaper_scene.js:2224`，280,026 px 逐像素循环）。
主进程已经提供了预烘焙的 `amadeus_ambient_high_blend.png` 却没人用。
详见 `docs/perf-wasm-assessment.md` §2。

## B 档 · 产品决策后隔离

这一档全部是 "在当前 Electron 宿主中不可达，但在原始 standalone HTML 路径中可达"。
**不要直接删**：`resources/render/web/wallpaper_engine.html` 仍是一个可独立打开的页面，
它的脚本表在 `sceneHost.ts:26-34` 被改写前，本来是为 legacy 宿主 + Python
`runJavaScript` 设计的。要先决定：这个 standalone 模式还支持吗？

| 项 | 位置 | 行数 | 当前宿主下的状态 | 依据 |
|---|---|---|---|---|
| CRT canvas 工作台 | `crt_canvas_surface.js` | 5,198 | 不实例化，但仍下载+解析 | `useSceneBridge.ts:173` 带 `sliceHost=electron` → `wallpaper_scene.js:1777` `_externalCanvasHost=true` → `1786` 的 `createCrtCanvasSurface()` 不调用 |
| 旧角色状态机 fallback | `renderer.js:972-1409` `SpriteForgeRuntime` | 438 | 被 factory 覆盖 | `src/scene/index.ts:71` 注入 `__SALIERI_CHARACTER_FACTORY__`；`renderer.js:1540-1542` 三元取 factory。html 替换保证了 `/next/scene.js` 先执行 |
| Live2D 前景路径 | `renderer.js:1411-1482` + `_mode` 分支 + `?live2d` 注入 | 72 | 不可达 | TS 侧无任何 `setMode` 调用（`grep -rn setMode src/` 为空）；唯一外部调用是 `renderer.js:1724` 的 WS bridge，已被禁用；且 `vendor/live2dcubismcore.min.js`、`vendor/pixi-live2d-display.cubism4.min.js` **不存在** → `?live2d=1` 必然两个 404 |
| 场景活动引擎 | `wallpaper_scene.js:492-713` `scenarioRuntime` | 222 | 永不开 | `enabled = !!payload.enabled`；`sceneHost.ts:79` 硬编码 `scenario: { enabled: false }`，且 TS 侧无第二个来源 |
| 键盘音效引擎 | `wallpaper_scene.js:195-490` `keyboardSfx` | 296 | 随上一项一起永不开 | 唯一启停在 `scenarioRuntime.tick`（`714-715`）+ `_updateComputerUseSfx`（`1087-1088`），都在 `scenarioRuntime` 内部 |
| 旧 WS bridge | `renderer.js:1694-1823` | 130 | 被开关正确挡住 | 功能重复：`src/scene/index.ts` 已用 MessagePort 承担同一职责 |

连带死字段/死资源（与 A4 同款模式：payload 传了但消费者被关掉）：

- `sceneHost.ts:78` 传 `keyboardSfxUrl` → 唯一消费者是 `keyboardSfx.configure`（B 档第 5 项）。
- `resources/assets/audio/sfx/computer_use_keyboard_loop.wav`（含 LICENSE.txt）只服务该路径。

**建议的目标切分**（若保留 standalone）：

```
scene-core      Pixi SpriteRenderer + TS character controller   ← 两条路径共用
electron-scene  wallpaper / audio(worklet) / subtitle           ← Electron 必需
legacy-scene    CRT canvas + 旧 WS bridge + Live2D + scenario    ← 按能力懒加载，或整体删
```

隔离收益：Electron 路径每次启动少下载并少解析 5,198 + 438 + 72 + 130 + 222 + 296
≈ **6,356 行 JS**。注意这是"少解析"，不是"少渲染"——这些代码本来就不执行。

### B 档补充：产品壳层"接上或移除"

| 项 | 行数 | 现状 | 选择 |
|---|---|---|---|
| MCP 连接编辑器 | `McpConnections.tsx` 561 | `main/index.ts:437` 永远返回 `mcpConnections: [], mcpConnectionsLocked: true` | 接真实数据源，或不在 Settings 里挂载编辑器 |
| Provider 选择器 | `lib/chatProviders.ts` 24 | `CHAT_PROVIDER_OPTIONS` 只有一项 `Pi`；渲染成下拉框（`SceneDock.tsx:101`、`SettingsPage.tsx:1009`），主进程也不消费 `llm_provider` | README 明确"不增加 provider registry"，单选项应改成静态状态或删 |

## C 档 · 保留（不要动）

| 项 | 为什么不是冗余 |
|---|---|
| `SpriteRenderer` vs TS 状态机 | 职责分层：前者是 Pixi 帧/嘴型/纹理的低层驱动器，后者是高层的图状态控制。`renderer.js` 头部注释已写明这是有意的适配边界 |
| `chatWorkActivity.ts` vs `work/workProjection.ts` | 语义不同且源码注释强调：前者是 provider **attempt**，后者是 WorkItem/acceptance。合并会破坏"不得把 attempt 成功当任务验收"的约束 |
| `WorkPage` / `SettingsPage` | 都经 `ScenePage` 可达，是当前唯一的工作台/设置实现 |
| `FluentIcon.tsx` | 只是 lucide-react 的命名适配层，没有引入第二套图标依赖 |
| `resources/` 与 `dist/` | 源资源 vs 构建产物，不是重复实现 |
| `@msgpack/msgpack`、`ws`、`react-markdown` 等 | 每个都有唯一消费者，无替代品 |
| `src/renderer/env.d.ts`、`types.d.ts` | 不在值依赖图上属正常（仅类型） |

## 附录：清理项（非架构问题）

- `LICENSE` 与 `resources/LICENSE` md5 相同（同一文件两份）；`resources/THIRD_PARTY_NOTICES.md`
  引用的 10 个文件中 8 个不存在。
- 空目录 `wasm/` 与 `dist/wasm/`：README 已说明旧 receive-side WASM meter 被移除，目录是残留。
- `.gitignore:13,16` 排除 `/resources/assets/images/*`（仅豁免壁纸）与
  `/resources/assets/spriteforge/runtime/`，而 `resources/README.md` 说打包会复制角色包。
  文件确实存在于本地。**在当前 .gitignore 下（除另有资源供给机制以外）**，新克隆无法
  按 README 的 `npm ci && npm run build && npm start` 跑起来。这是发布策略问题，需要明确：
  要么解除豁免，要么在 README 标注前置条件。

## 独立问题：第三方 notices 与证据漂移（合规审查项，非架构）

`resources/THIRD_PARTY_NOTICES.md` 引用了 10 个证据文件，实际只存在 2 个：

```
存在 LICENSES/FIRST-PARTY-BRAND-ASSETS.md
存在 LICENSES/pixi-basis-ktx2-MIT.txt
缺失 LICENSES/AP-BWE-MIT.txt
缺失 LICENSES/Bert-VITS2-Cantonese-Yue-AGPL-3.0.txt
缺失 LICENSES/GPT-SoVITS-MIT.txt
缺失 LICENSES/GPT-SoVITS-NESTED-NOTICES.md
缺失 LICENSES/GPT-SoVITS-UPSTREAM-RELIANCE.md
缺失 LICENSES/Live2D-Cubism-Core-NOTICE.md
缺失 LICENSES/pixi-live2d-display-MIT.txt
缺失 LICENSES/provenance.json
```

这 8 项里有 5 项属于本项目当前并未包含的组件（GPT-SoVITS、Bert-VITS2、AP-BWE、
Live2D Cubism Core、pixi-live2d-display）；另需注意两点，因此**本节能下的结论只是"漂移"**：

- `provenance.json` 是来源/构建清单，不指向某个具体组件，不能算"缺失的组件"；
- Live2D 相关代码在该仓库中**仍然存在**（见 B 档 `Live2D 前景路径`），所以不能单凭
  "本项目不包含" 就判定这些条目应删。

需合规审查定夺：补齐证据文件，还是移除不再声明的条目。本文档只负责指出
notices 声明的证据与仓库现状不一致。

## 建议动作顺序

1. **A3**（mock 动态导入）——零决策成本。
2. **A1**（让抑制开关真正生效，确定唯一字幕所有者）——1 行修复 + 删一套。
3. **A2**（设置 schema 规范化 + 清 zh/ja 旧键）——影响用户可见语言。
4. **B 档**：先回答"standalone HTML 还支持吗"，再按 `scene-core / electron-scene / legacy-scene`
   切分或整体删除；顺带把 8 个连带的死 payload 字段与死资源一起处理。
5. **B 档补充**：MCP 与 provider 选择器"接上或移除"。
6. **附录 + 许可证**：清理项与合规项，与架构改动分开提交。

关于孤儿 i18n 键的说明：本报告用静态引用扫描得到 **173 / 412** 个无引用键
（已扣除 `translateDynamic` 的 `settings.option` / `settings.status` / `settings.asrBackend`
三个动态前缀）。这个数字是**候选集，不是删除清单**——错误码可能来自运行时拼接。
其中可归因到已移除能力的域（`backend.*`、`artifact.*`、`session.drafts`、
`asrBackend.*`、`TTS_BACKEND`/`GPT_SOVITS`/`TTS_REF_*`/`AEC_*`/`WAKE_*`/`VTS_*`、
`chat.vision_*`、`chat.submode_*`）优先级最高，但删除前仍需逐个确认生产者不存在。
