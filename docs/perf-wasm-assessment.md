# 性能点与 WASM 替换评估

结论：**当前没有组件需要换成 WASM。** 现有 JS 工作量要么在 GPU 上、要么每次调
用只有微秒级、要么已经是 WASM（Basis/KTX2）、要么已经走原生（Apple Speech）。
引入 WASM 只会增加 100–500KB 产物、构建步骤和跨边界拷贝，换不来可测量的收益。

下面每条都带代码位置和实测/推算依据。

## 0. 先看运行时形态

| 项 | 事实 |
|---|---|
| 宿主 | Electron 44，主进程 / Pi utility process / preload / renderer / scene 五份产物 |
| 渲染 | PixiJS **7.4.3**（WebGL），`resources/render/web/vendor/pixi.min.js` |
| 场景 | 独立 iframe（`sceneHost.ts:58`，带 `sliceHost=electron`），React 只转发带类型校验的消息 |
| ASR | 原生 Swift 辅助进程（`native/SpeechRecognizer.swift`），已编译为 `dist/bin/SalieriSpeechRecognizer` |
| TTS | Fish Audio 云端 WebSocket，msgpack 帧（`src/main/fishTts.ts`） |
| 现状 WASM | 只有 `resources/render/web/vendor/basis_transcoder.wasm`（472,914 B），用于 KTX2/Basis 纹理解码 |

即：**唯一该用 WASM 的地方已经用了 WASM**，位置正确。

## 1. 逐项判定

| 组件 | 位置 | 单次工作量 | 该换 WASM？ | 理由 |
|---|---|---|---|---|
| Basis/KTX2 转码 | `vendor/basis_transcoder.wasm` + `pixi-basis-ktx2.global.js` | 每纹理一次 | **已经是** | 正确选择，保持 |
| 语音识别 | `native/SpeechRecognizer.swift` | 连续麦克风 | 否（反向） | 已是原生，改 WASM 是降级 |
| PCM Int16→Float32 + 末位字节拼接 | `src/scene/index.ts` 的 `pcm()` | 24kHz 下每块约数百~2400 样本，纯算术 | 否 | 边界拷贝（`postMessage` transfer）比循环本身更贵 |
| Worklet 混音 + RMS | `src/scene/audioWorklet.ts`（70 行） | 每 128 帧一次拷贝 + 累加，`sampleRate/30` 上报 | 否 | 迁 WASM 不会引入额外消息边界（本就在音频渲染线程内），但工作量只有 128 帧拷贝 + RMS 累加，迁移成本高于收益 |
| 环境光遮罩生成 | `wallpaper_scene.js:2224` `_buildAmbientFromBackground` | **280,026 px 逐像素 JS 循环 + 2 次全画布 blur** | **否** | 见 §2：应删/预烘焙，而不是加速 |
| 场景逐帧（扫描线 / 辉光） | `wallpaper_scene.js:2143` `tick` → `_drawGlow` / `_drawScanlineNoise` | 每帧 `clear()` + 重建 Graphics，约 100–230 段线 | 否 | GPU 几何，WASM 帮不上；该做的是缓存几何/纹理 |
| 角色状态机 / EMO 词法 / 对齐时间轴 | `src/shared/character.ts`、`presentation.ts` | 微秒级、字符串规模 | 否 | 体量离热点差几个数量级 |
| Markdown / diff 渲染 | React + `markdownLite` | DOM + 字符串 | 否 | 非数值负载 |
| msgpack / JSON | `@msgpack/msgpack`、`JSON` | 文本规模 | 否 | 同上 |

## 2. 本次审查发现的主要浪费：运行时重新生成环境光遮罩 —— **已删除**

> 状态：已在同批清理中删除。`_buildAmbientFromBackground` 整体移除，改由
> `setAmbientHigh(payload.ambientUrl)` 消费主进程本就提供的预烘焙图。
> 详见 `docs/architecture-redundancy.md`。以下保留原始分析作为记录。

`wallpaper_scene.js:2224-2315` 是本次审查发现的**主要 JS 逐像素循环**（不宣称是唯一一处）：

1. `new Image()` 重新解码整张壁纸（1672×941），画进 `willReadFrequently` canvas；
2. `getImageData(rect)`，rect 由 `ambient_rect [1370,120,220,480]` 加 55%/19% 内边距再按图裁剪得到 → **423×662 = 280,026 px**；
3. 逐像素算 cyan/blue/luma、`Math.pow`、羽化，`createImageData`/`putImageData`；
4. 对整张 1672×941 画布做两次 Skia 模糊：`blur(36px)` + `blur(14px)`（`lighter` 混合）。

微基准（Node 24，抽出同源循环 + 合成像素数据，10 次均值）：**4.77 ms**——这是循环本身
的量级参考，**不是 Chromium 实测**。加上整图解码、`getImageData`/`putImageData` 和两次
全画布模糊，单次总量**粗略估算 30–80 ms**（估算值，未经 profile 证实），发生在场景启动
时壁纸载入之后，会落在首帧附近。要下结论请按 §5 用 Chrome Performance 实测。

**而且它拿的是一张已经预烘焙好的等价资源却没用**：

- `src/main/sceneHost.ts:75` 传了 `ambientUrl: /assets/images/amadeus_ambient_high_blend.png`；
- 但 `wallpaper_scene.js:1780-1781` 只消费了 `payload.ambientLowUrl` 和
  `payload.ambientDeltaUrl`，**`payload.ambientUrl` 全项目无人读取**
  （`ambientUrl` 字段只在 1720 声明、2226 被生成器自己赋值）；
- 于是 `ambientDeltaUrl === ""` → `1785/1851` 的 `if (!this.ambientDeltaUrl)` 恒真 →
  每次场景启动都跑一遍生成器。

`ambient_high_blend.png` / `ambient_low_blend.png` 被 `.gitignore:13`
（`/resources/assets/images/*`，只豁免壁纸）排除，属于"本地媒体副本"策略：
新克隆里它们不存在。低光层没有运行时生成器，缺了就只有一条 warn；高光层则由生成器
兜底。所以生成器可能是**有意的兜底**，不是纯冗余——但"传了预烘焙图却没人用"这件事
本身还是需要主人定夺：

- 若预烘焙资源应当随包发布 → 取消豁免，或让 `init()` 消费 `payload.ambientUrl`，
  这 30–80 ms 直接消失（改动约 2 行）；
- 若维持忽略策略 → 保留生成器，接受这一次性开销（说实话不值得为它上 WASM）。

## 3. 连热点都算不上的地方（已核实，避免误判）

- **扫描线/辉光逐帧重建**：`_drawScanlineNoise` 每帧 `clear()` 后按 `bounds.height/3`
  重画。默认窗口 1100×800 下 CRT 高度约 291–377 CSS px → **约 100–125 段**；
  2560×1440 全屏（scale≈1.53）→ **约 226 段**。量级就是亚毫秒到 1–2 ms，
  真正的成本在 Pixi 每帧重新细分+上传顶点缓冲。只有窗口再大一个数量级才值得改成
  缓存纹理或自定义 shader，且仍与 WASM 无关。
- **`crt_canvas_surface.js`（5197 行）在 Electron 路径中功能未实例化**：场景 URL 带
  `sliceHost=electron`（`useSceneBridge.ts:173`）→ `_externalCanvasHost = true`
  （`wallpaper_scene.js:1777`）→ 1786 行的 `createCrtCanvasSurface()` 永不调用。
  注意它**不是**死文件：仍会被下载、解析，注册 IIFE（`window.createCrtCanvasSurface = ...`）
  照常执行，只是那套"每次更新重建整卡 innerHTML"的路径在运行时不触发。
  可做的小优化：在 `sliceHost=electron` 时从脚本表里排除该文件，省掉一次下载与解析。
  另：`wallpaper_engine_bridge.js` 不存在**不会**产生 404——`sceneHost.ts:29` 在返回 HTML 前
  已把该条目替换为 `/next/start.js`（已核验，替换后无残留引用）。
- **纹理流水线已经做过防卡顿**：7552 个 KTX2 / 2.7GB 资源，加载被切成
  2 帧/片、1 个并发帧集、`requestIdleCallback` 或 24ms 让出、优先级队列、说话期间
  推迟推测加载（`renderer.js:275-410`）。转码仍在 renderer 主线程，但已被切片；
  真要进一步，方向是把它移出主线程（Worker），不是换 WASM——转码本身就是 WASM；
  OffscreenCanvas 只是 Worker 里做 GPU 上传时的一种手段，并非转码的必需条件。
- **ReactMarkdown 逐行实例化**（`WorkPage.tsx:1542`）只出现在 mock 回放夹具里，
  行数是个位数，不是热点。
- 音效噪声缓冲（`_noiseBuffer`）每次点击新建约 960 样本的 `AudioBuffer`，
  量级可忽略。

## 4. 什么情况下会出现真正的 WASM 候选

按可能性排序——这些都是**新增能力**带来的负载，而不是现有代码提速。
注意：下面每一项都只是**候选**，不是必然方案。这是 Electron 应用，跨平台原生 helper、
ONNX Runtime、WebGPU 在多数场景下比 WASM 更划算；WASM 只在沙箱/纯 Web 分发或跨平台
原生构建代价过高时才成为首选。

1. **跨平台/离线 ASR**：把 macOS 专属的 Apple Speech 换成进程内 Whisper
   （whisper.cpp / whisper.wasm）或 Silero VAD。届时每帧麦克风都要过 VAD、
   每句话都要过 mel 频谱 + 编码器，这才是 WASM/SIMD 的正当 workload。
   `native/SpeechRecognizer.swift` 是 macOS-only，这里是**最可能的 WASM 候选**。
2. **离线 TTS**：把云端 Fish WS 换成本地 ONNX/WASM 模型（Piper/VITS 类）。
3. **音频引擎复杂化**：如果 sound-effect 合成长成多声部、逐样本 DSP 的实时引擎，
   把 worklet 内 DSP 迁到 WASM（Rust/AssemblyScript）才是常规做法；
   今天那里只有一条队列 + 一个 RMS 累加器。
4. **交互式图像处理**：如果遮罩生成变成多兆像素、每帧 CPU 合成（4K 滤镜类），
   WASM SIMD 才划算；今天是每个场景启动一次、28 万像素的静态 pass。
5. 顺带：KTX2 转码搬进 Worker 是**线程问题**，不是 WASM 问题。

## 5. 如果要先测再改，按这个顺序

1. **先修 §2 的 ambient 字段/资源发布策略**——这是本次唯一已确认的可执行问题。
2. Electron 场景不再加载 `crt_canvas_surface.js`（纯省下载与解析）。
3. 用 Chrome Performance 实测会话切换 / 表情爆发时 KTX2 转码的尖峰；**确认阻塞后**
   再考虑 Worker 化（转码本身已是 WASM，OffscreenCanvas 不是转码的必需条件）。
4. 只有在 profile 显示 Pixi Graphics 逐帧重建确实显著时，才把扫描线/辉光改成
   shader 或缓存纹理。
5. 一次真实 agent 运行里 provider 事件 → React 渲染这条链路（目前没有跑得起来的高频
   JS 路径，但如果事件推送频率上去了，这里会先疼）。

在拿到可复现的卡顿症状之前，"需要换成 WASM 的组件"清单是空的；真正的收益来自资源管线
统一、减少无用脚本解析、必要的 Worker 化和 GPU shader，而不是 WASM。
