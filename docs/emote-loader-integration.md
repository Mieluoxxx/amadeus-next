# E-mote 数据层集成

模型烘焙由仓库内的 TypeScript 数据层完成，任何平台都不需要 Rust、Cargo 或预编译的二进制。
渲染仍由 FreeMote WebGL 3.9 运行时负责；数据层只把模型整理成它能直接 `loadData()` 的字节，
产出 `PSB + metadata + snaps + parts` 契约，口型、表情和部件显隐逻辑不变。

## 输入契约：解压即用

用户拿到的是一个 emote 文件夹（通常是压缩包，解压后直接导入）：

```text
emote/
  FreeMoteDriver.js、emoteplayer.js      # 固定哈希的 FreeMote 运行时
  models/<model>/
    <model>.psb.m.json                    # FreeMote PsbDecompile 的解包产物
    <model>.psb.m.resx.json
    <model>.psb/*.png、<model>.psb/extra/*.bin
```

- **打包应用**：场景错误页点「导入角色资源」，选解压出的文件夹即可。压缩包多套的一层目录会自动进入；
  `__MACOSX/`、`.DS_Store`、`._*` 这类压缩残留不复制、不计入指纹。
- **开发环境**：把 emote 文件夹解压到 `resources/`（`resources/emote/` 或 `resources/character/emote/`），
  然后 `npm run dev`。也可以用 `npm run assets:emote -- /path/to/amadeus-next-emote` 从实验室仓库整理一份。

数据层不处理游戏原包（`.psb.m` 的 MZS 压缩加密外壳、`body.bin` 归档、BC7 贴图）：那是更上游的解包步骤，
输入契约从 FreeMote 解包目录开始。

## 结构

| 位置 | 职责 |
|---|---|
| `src/shared/emote/` | 平台无关的核心：数值类型保真解析、5 条兼容规范化、离散轨道摘除、部件查表、PNG 解码、PSB 写出。读文件、解压、写出都由调用方注入 |
| `src/main/emoteBakeNode.ts` | Node 适配：`fs` 读写、`zlib` 流式解压；测试与场景 harness 在进程内直接用 |
| `src/main/emote-bake-worker.ts` | Electron `utilityProcess` 入口 |
| `src/main/emoteBakeHost.ts` | 每次烘焙开一个子进程，完成、失败或超时（120 s）都会结束它 |
| `src/main/emoteBake.ts` | 校验、指纹、缓存发布、原子导入 |

烘焙放在独立进程，是因为它峰值约 150 MB，而 V8 用过的大块内存不会还给系统；进程结束后常驻归零，
主进程不受影响。实测一次烘焙（含进程启动）约 0.6 s。

## 兼容规范化（顺序不可调换）

上游数据是 E-mote 3.03，运行时是 3.9：

1. 选择器取值换成选项序号，删掉 `lower`/`upper`（3.9 不认区间）；缺区间的选项要占位，否则序号整体错位；
2. 丢掉被选择器接管的遗留合并口控，否则它会覆盖 `face_mouth`；
3. 中性 RGB 的打包 `cw` 权重换算成旧版 `opa`，mask 隐藏位换成 `0x400`；非中性 RGB 报 `error.cwColor`；
4. `spec = "ems"`，贴图类型写成 `RGBA8`；
5. 基础入口改成 `all_parts / 全体構造`（顶层合成入口在 3.9 上是黑色剪影）。

PNG 直接解码成直通 alpha 的 RGBA8，不经过 canvas：canvas 会预乘 alpha，把 alpha=0 像素的 RGB 抹掉。
只接受 8 位 RGBA 非隔行 PNG，其余格式明确报错。

## 与原 Rust 烘焙器的关系

数据层替换了原先 vendor 的 `amadeus-emote-loader`（Rust）。四个模型逐一对照过：解码后的 PSB 树类型与取值一致，
全部资源逐字节一致，meta 的 `metadata`、`parts`、`snaps` 一致。有意保留的差异：

- PSB 文件字节不同（名字 trie 布局不同，也不写 emote-psb 的内部标记名），解码结果相同；输出是确定性的。
- 浮点按正确舍入解析：原实现所用的 serde_json 会把每个模型里 18–49 个极小的 `mesh.bp` 值解析偏 1 ULP。
- meta 不再输出宿主没有使用的 `actions`。

JSON 里写成 `1.0` 的整数会保留为双精度（`Double`），与写成 `1` 的整数区分开：PSB 按书写区分两种类型。

## 缓存

缓存位于 `<userData>/emote-cache/<model>/<fingerprint>/`，可用 `AMADEUS_EMOTE_CACHE` 覆盖。
指纹覆盖模型目录的文件路径和内容、`BAKER_VERSION` 与缓存协议版本；不依赖时间戳。
**改了烘焙语义或产物格式时，递增 `src/shared/emote/bake.ts` 的 `BAKER_VERSION`**，旧缓存随之失效。

同一输入的并发请求合并；先在临时目录生成 PSB 和 sidecar，校验结构、记录文件长度，再整体发布。
失败或源文件在烘焙期间变化时不发布。缓存截断或 sidecar 缺失会重新烘焙。场景 URL 包含指纹，
避免重载期间 PSB 与 metadata 来自不同世代。旧世代暂不自动清理。

运行时仍需 `Module.TOTAL_MEMORY = 512 MiB`：这是 FreeMote 驱动的固定堆，与数据层无关。

## 验收入口

```bash
npm run typecheck
npm test                 # 含数据层单测与真实素材烘焙（缺素材时跳过）
npm run build
npm run test:dev
npm run test:electron    # Electron GUI 验收：冷缓存经 worker 烘焙并出画
```
