# E-mote 原生加载器集成

产品继续使用 Rust 原生烘焙，不复制实验室的浏览器适配器，不使用软链接。
`amadeus-next-emote` 的 WASM 路线是浏览器实验入口；这里复用相同的
`PSB + metadata + snaps + parts` 契约，保留现有口型、表情和部件显隐逻辑。

## 依赖交付

`vendor/emote-loader/<platform>-<arch>/` 保存本应用自己的二进制、源提交、SHA-256
和许可证。当前提供 macOS arm64，固定源提交为
`3310e6008266793da89a564e764bbbdbd31e26a2`。

只有维护者显式升级才需要上游源码和 Rust：

```bash
npm run emote:loader -- /path/to/amadeus-emote-loader <commit>
```

升级从指定 Git 提交导出到临时目录，用 `cargo build --release --locked --bin emote-loader`
编译，**忽略上游工作区的未提交修改**。更新产物目录需一并提交。

日常 `build` / `dev` 只校验本仓库产物并复制到 `dist/bin`，不执行 Cargo、不查找相邻仓库。
打包入口强制要求加载器存在，并通过 `extraResources` 放到 asar 外；加载器随应用一起签名。
其他架构须在相应系统准备产物；目前不支持跨架构打包。

## 模型与运行时导入

开发素材需要显式准备一次：

```bash
npm run assets:emote -- /path/to/amadeus-next-emote
```

这一步只复制资源并规范化目录名，不复制解析器代码。结果为独立的 `resources/character/emote/`。
完成后即可移走素材来源仓库；日常运行不访问它，也不访问 CDN。

FreeMote 和游戏模型依然不随公开发行物分发。打包应用的场景错误页提供“导入角色资源”，
选择上一步生成的 `emote/` 目录，将其复制到 `<userData>/emote/`。

- 只接受固定哈希的 `FreeMoteDriver.js` 与 `emoteplayer.js`，不执行任意导入脚本。
- 拒绝软链接、特殊文件和模型资源索引中的越界路径。
- 新资源先复制到暂存目录并试烘焙，成功后才替换应用资源；失败保留旧目录。
- 导入目录优先于开发资源，不持久化外部来源路径，不改写签名后的应用包。

## 启动与恢复

```text
AppRuntime.init → 启动 SceneHost / Pi → 打开窗口
React wallpaper.start
  → 校验应用自己的运行时
  → ensureBakedModel
  → SceneHost 发布该缓存世代的 URL
  → 渲染端 fetch PSB + meta → FreeMote loadData
```

缺加载器、缺模型、校验或烘焙失败只让场景进入错误状态，不阻断窗口和设置。
确定性的资源错误不自动重试；用户可导入资源或手动重试。场景重载也走同一准备路径。

## 缓存

缓存位于 `<userData>/emote-cache/<model>/<fingerprint>/`，可用 `AMADEUS_EMOTE_CACHE` 覆盖。
指纹覆盖模型目录的文件路径和内容（JSON、resx、PNG、附加资源）、加载器字节和缓存协议版本。
不依赖时间戳，也不用非确定性 PSB 产物的哈希作为缓存键。

同一输入的并发请求合并；先在临时目录生成 PSB 和 sidecar，校验结构、记录文件长度，
再整体发布目录。失败或源文件在烘焙期间变化时不发布。缓存截断或 sidecar 缺失会重新烘焙。
场景 URL 包含指纹，避免重载期间 PSB 与 metadata 来自不同世代。

旧世代暂不自动清理，以保护仍在加载的场景；频繁替换模型后可在应用关闭时删除缓存目录。
运行时仍需 512 MiB 堆，原生加载器不是渲染器，不消除这项约束。

## 验收入口

```bash
npm run typecheck
npm test
npm run build
npm run test:dev
npm run test:scene       # 可选：独立浏览器出画检查
npm run test:electron   # Electron GUI 验收
```

自动检查覆盖本地二进制校验、无相邻源码的开发副本、冷/热缓存、保留时间戳的贴图修改、
加载器升级、损坏缓存、烘焙失败、资源越界、独立复制导入、缺资源启动与手动恢复。
真实素材验收仅在合法本地素材存在时运行；GUI 验收不能以 Node 测试代替。
