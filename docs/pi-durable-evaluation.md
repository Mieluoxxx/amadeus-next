# pi-durable 评估

> 评估 `@earendil-works/pi-durable` 能否替代当前 `pi-worker` 中基于 `pi-coding-agent` 的运行时，作为委托（handoff）与长期记忆的底座。
> 调研日期：2026-10-10。依据为 npm 包 1.1.0 的 README、CHANGELOG、`dist/*.d.ts`，以及仓库示例 `test/examples/23-subagent-background.ts`。标注“未验证”的结论只来自类型或文档，没有实际运行。
> 基于本评估的整体架构见 `architecture.md`；记忆与工具的具体设计见 `long-term-memory.md` v5、`pi-tool-constraints.md` v2。

---

## 0. 结论

**值得采用，但先做原型，不直接迁移。**

- pi-durable 的子代理、收件箱、持久任务和自定义条目，几乎一一对应 `docs/pi-tool-constraints.md` 的 handoff 设计和 `docs/long-term-memory.md` 的注入设计。原本要自己写的任务表、调度器、重放表，大部分可以删掉。
- 代价是**整体替换运行时**：它与 `pi-coding-agent` 的 `AgentSession` 平级，不是插件。现有会话格式、扩展写法、事件订阅都要改。
- 包标注 **Experimental**，1.0.0 到 1.1.0 的 6 天内有两次破坏性变更，必须锁版本。

---

## 1. 它是什么

| 项 | 内容 |
| :--- | :--- |
| 包 | `@earendil-works/pi-durable` 1.1.0（2026-10-07），与当前 Pi 同一 monorepo、同一版本线 |
| 依赖 | `@earendil-works/pi-ai`、`@earendil-works/chord`；**不依赖** `pi-coding-agent` |
| 定位 | 持久化 agent 运行时：对话、模型调用、工具调用、应用状态都先原子提交到存储，再对外可见；进程崩溃后重开存储即可从断点继续 |
| 稳定性 | README 首行：Experimental，API 在版本间随时变化 |

### 1.1 核心概念

| 概念 | 含义 | 对我们的意义 |
| :--- | :--- | :--- |
| Harness | 一个打开的存储加上运行 agent 的机制，所有修改走同一条原子提交线 | 取代 `ModelRuntime` + `AgentSession` 的组合 |
| Conversation | 一份由不可变条目组成的对话记录；可以创建多个、可以分叉 | 主会话和每个子代理各是一个 Conversation |
| Entry | 一条记录。`model` 字段进入模型上下文，`data` 字段只给界面和扩展；`edits` 可以在上下文中覆盖更早的条目 | 记忆快照、增量块、handoff 结果都可以是自定义条目 |
| Document | 与对话记录同事务提交的类型化 JSON 状态 | 子代理登记表、记忆基线等状态 |
| Task | 每一步都存检查点的持久状态机，有明确的归属者 | handoff 的投递与汇报 |
| Submission | 交给对话的输入或写入，可以等待其完成；`requestId` 幂等 | 用户输入、结果回送都不会重复 |
| Extension | 一组 tools、sections、hooks、wraps、tasks | 红莉栖角色、记忆、handoff 各自一个扩展 |

---

## 2. 与现有设计的对应

### 2.1 委托（对应 `pi-tool-constraints.md` §3）

官方示例 `23-subagent-background.ts` 已经实现了我们要的模式：

```text
subagent 工具（spawn / send / stop / status）
 └─ 一个 commit 内：
     ├─ 创建后台“锚”任务 Anchor（background: true，立即结束）
     ├─ 创建子对话，归属于锚任务；configure 去掉 subagent 扩展、设定 instructions
     └─ 创建后台汇报任务 Reporter
Reporter
 ├─ deliver：向子对话 submit（requestId 幂等），等待回答，在同一 commit 中记录已汇报
 └─ report：把回答作为 followUp 输入提交给主对话（requestId 幂等）
```

| 我们的需求 | pi-durable 的机制 |
| :--- | :--- |
| handoff 立即返回，主回合照常结束 | 工具只负责创建任务；后台任务不让主对话保持忙碌 |
| 主人按停止不影响已委托的任务 | `background: true` 是边界：主对话的 abort 和空闲等待都到此为止；`abort({ background: true })` 才会连带停止 |
| 子代理不能递归委托 | 子对话 `configure({ extensions: { remove: [HandoffTools] } })` |
| 子代理用不同模型、工具、目录 | 每个对话可单独 `configure` 模型、thinking、扩展、工具、`instructions`、`cwd` |
| 结果回到主对话 | Reporter 以 `whenBusy: "followUp"` 提交：主对话空闲时直接开启新回合，忙时排在当前回答之后 |
| 重启不丢、不重复 | 任务按检查点恢复；`requestId` 去重保证子代理只收到一次消息、主对话只收到一次汇报 |
| 取消任务 | `subagent stop` 对子对话调用 `abort()`，子对话本身保留，之后还能继续使用 |
| 写操作需要确认 | `wrapTool` 包装工具，在 `execute` 中把确认请求写入文档并等待（`beforeTool` hook 不能提交事务，等待也不持久，只适合同步拦截） |
| 子代理在独立目录里运行 | `env: ({ cwd }) => new NodeExecutionEnv({ cwd })`，每次调用都按对话的 `cwd` 构造执行环境 |
| 任务卡片 UI | `harness.taskGraph()` / `watchTaskGraph()` 给出整棵实时任务树 |

**需要我们补的部分**：主人说话或语音播放时不打断。durable 的 followUp 只区分对话忙和闲，不知道主人正在说话。另外 durable 的任务只能等待其他任务，不能等待某个文档变化。

已定方案（`architecture.md` §4.3）：Reporter 不直接提交给主对话，而是把结果写进主对话的 `app.outbox` 文档；主进程的话筒仲裁在话筒空闲时发 `report.deliver`，worker 再以 `requestId` 幂等地提交汇报输入。durable 负责不丢、不重复，主进程负责时机。

### 2.2 长期记忆注入（对应 `long-term-memory.md` §4）

| 原设计 | pi-durable 下的做法 |
| :--- | :--- |
| 快照钉在第一条 user 消息上，存 `injections` 表，`context` 事件重放 | 首轮通过 `write` 提交一个自定义条目 `amadeus.memory-snapshot`，在 `model` 字段放快照文本。条目本身就是持久化的，**不需要重放表** |
| 增量块挂在本轮 user 消息上 | 有变化时先 `write` 一个 `amadeus.memory-update` 条目，再提交用户输入 |
| 重新冻结：改写第一条消息上的快照、删除增量块 | 用新条目的 `edits` 在上下文中覆盖旧快照、隐藏旧增量（未验证 `edits` 的具体语义） |
| 会话压缩后重新冻结 | 压缩后 durable 会生成新基线；在 `CompactionTask` 的 hook 或下一轮中重新写入快照 |
| “不落会话记录”契约 | 改为“**不出现在用户可见的记录里**”：条目存在存储中，界面和字幕按 `kind` 过滤 |
| `session_baseline` 表 | 改为一个 conversation 级 Document |

另一种方式是用 `hook(GenerationTask, { beforeRequest })` 只改写单次请求的消息、不写入对话记录。这种方式更接近原设计，但要自己保证每次请求结果相同。**建议优先用条目方式**，因为持久化和确定性由运行时保证。

**条目由谁写**：`HookApi` 只能读文档、使用 `models` 和 `memo`，**不能 `commit`**。所以记忆条目不能在 hook 里写，而是由 pi-worker 的宿主代码在提交用户输入或汇报输入之前、在同一个 commit 中写入（`long-term-memory.md` §4.1）。

### 2.3 回合后抽取（对应 `long-term-memory.md` §5.2）

- hook 不能提交事务，所以 `onYield`、`afterTools` 不能用来创建抽取任务。改由 worker 事件桥观察到 run 结束后，由宿主代码在主对话上提交一个**后台任务**（`background: true`）：天然持久，重启后可以继续，也不阻塞主对话。
- 任务的 runtime 可以通过 `models` 使用同一份模型配置发起请求（1.1.0 新增 `api.models`），抽取用的模型调用无需另外配置。

### 2.4 system prompt 与缓存

- system prompt 由所选扩展的 sections 按顺序拼成，`instructions` 排在最后。只有变化的部分会作为位置化的 system 条目重发（1.1.0 修复后，首条 system 位于上下文开头，Anthropic 在工具变化时也能保住缓存）。
- 每个对话有一个持久的 UUIDv7 作为 pi-ai 的 `sessionId`，用于 provider 端的缓存与会话亲和性；它在重启、重试、重置、压缩后都保持不变，分叉和子对话则会拿到新的 id。
- 约束不变：section 不能返回随时间变化的内容（例如当前时间），否则缓存失效。

---

## 3. 迁移代价

| 项 | 现状 | 迁移后 | 工作量 |
| :--- | :--- | :--- | :--- |
| 运行时 | `createAgentSession` + `DefaultResourceLoader` | `Harness.open(storage, { models, registry, settings, env })` | 重写 `pi-worker.ts` 主体 |
| 模型配置 | `ModelRuntime.create({ authPath, modelsPath, ... })` | `ModelRuntime` 实现了 pi-ai 的 `Models` 接口，可直接作为 `models` 传入（**仅类型层面确认，未验证**） | 小 |
| 角色 prompt | `systemPromptOverride` → `composePrompt` | 一个扩展的 `section`；热更新改为 `registry.install()` 同名替换 | 小 |
| 流式输出 | `session.subscribe` 的 `message_update` / `text_delta` | `watchEvents(harness, id)` 给出同名的事件流；部分回答默认每 100ms 提交一次 | 中：需要验证首包延迟 |
| 中断 | `session.abort()` | `conversation.abort()` | 小 |
| 会话存储 | Pi jsonl（`piSessions.ts`）+ `SessionStore` | 一个 SQLite 文件（`openNodeSqliteStorage`，底层 `node:sqlite`） | 中：历史会话要迁移或只读保留 |
| 内置工具 | 默认 read / bash / edit / write | 默认没有工具；`@earendil-works/pi-durable/tools` 提供同名工具，需要时显式安装 | 无，正好符合“主对话不带内置工具” |
| 扩展 | 不使用外部扩展 | `defineExtension`；Registry 是进程内对象，不会读 `~/.pi/agent` 的扩展与 MCP | 无 |
| 依赖体积 | — | 根入口加载 TypeBox，未打包时峰值 RSS 约 +23MB，tree-shake 后约 4MB | 可接受 |

### 3.1 约束

- **单进程独占存储**，没有跨进程锁。只能由 `pi-worker` 打开存储，主进程通过 worker 命令读取。
- **SQLite 的持久性**：WAL 模式 + `synchronous = NORMAL`，进程崩溃不丢提交，断电或宿主机故障可能丢最新一次提交。对陪伴场景足够。
- **工具重放语义**：工具调用中途崩溃时，只有声明 `replay: "safe"` 的工具会在重开后重新执行，其余工具会给模型返回 `interrupted` 结果。`remember` 应当做成幂等的，并声明 `safe`；`handoff` 按示例声明 `unsafe`。
- **API 不稳定**：`package.json` 锁定精确版本，每次升级先读 CHANGELOG 里的 Breaking Changes。

---

## 4. 原型计划

目标：用最少的代码回答“能不能迁移”。原型与现有 `pi-worker` 并存，用环境变量切换，不改动渲染进程。

### 4.1 范围

- `Harness` + `openNodeSqliteStorage(<userData>/pi-durable.sqlite)` + 现有 `ModelRuntime`。
- 扩展 `amadeus-role`：一个 section 输出 `composePrompt()` 的结果。
- 扩展 `amadeus-handoff`：照示例 23 改写的 `handoff` 工具 + Anchor / Reporter 任务；子代理只开 `research` 类型。
- 扩展 `amadeus-memory`（只做最小注入）：首轮写入一个固定内容的快照条目。
- `watchEvents` 转成现有的 `text` / `tool` / `done` 端口消息，复用当前的字幕与 TTS 链路。

### 4.2 验收

| # | 项目 | 通过标准 |
| :--- | :--- | :--- |
| P1 | 模型配置复用 | 现有 `auth.json` / `models.json` 下能正常对话，无需改配置 |
| P2 | 首包延迟 | 与现有 `pi-worker` 对比，首个 `text_delta` 到达时间的中位数差距 ≤ 100ms |
| P3 | 缓存 | 真实 Anthropic 模型连续 20 轮，第 2 轮起 `cacheRead / input ≥ 80%` |
| P4 | 委托 | handoff 后主回合立即结束；子代理完成后红莉栖主动汇报；期间主人可以继续聊天 |
| P5 | 重启恢复 | 子代理运行中杀掉 worker 再重启，结果仍然送达且只送达一次 |
| P6 | 中断边界 | 主对话 abort 不影响后台子代理；`stop` 能停掉子代理 |
| P7 | 记忆条目 | 快照条目进入模型请求，但不出现在字幕、TTS 和界面记录中 |
| P8 | 打包 | Electron 打包后 `node:sqlite` 与 pi-durable 正常加载 |

### 4.3 原型之后

- P1 到 P8 全部通过：在本文补充实测结果，按 `architecture.md` §8 进入 A1 运行时切换。`long-term-memory.md` v5 与 `pi-tool-constraints.md` v2 已按 durable 编写，只需根据实测修正（例如 `edits` 的语义）。
- P2 或 P3 不通过：先查是否能通过 `settings.progress` 等配置解决；解决不了就按 `architecture.md` §10 的退路继续使用 `pi-coding-agent`，两份设计文档退回上一版的实现方式。

---

## 5. 需要主人拍板

已汇总到 `architecture.md` §11（第 1~3 项）：是否接受实验性依赖、历史会话的处理方式、记忆注入方式。原型优先级已定：P0 排在所有里程碑之前。

---

## 附录 A：依据

| 结论 | 来源 |
| :--- | :--- |
| 实验性、概念、示例清单 | `README.md` |
| 1.1.0 新增 `api.models`、首条 system 位置修复、`contextRetentionMs` | `CHANGELOG.md` |
| 依赖 pi-ai 与 chord，不依赖 pi-coding-agent | `package.json` |
| SQLite 后端使用 `node:sqlite` | `dist/storage/sqlite/node.js` |
| `EntryRecord` 的 `model` / `data` / `edits` 字段 | `dist/types.d.ts` |
| `write` 提交携带 `EntryDraft` | `dist/harness/types.d.ts` |
| `beforeRequest` 可以替换单次请求的消息 | `dist/harness/types.d.ts` |
| Harness 的 `models` 类型为 pi-ai `Models`；`ModelRuntime implements Models` | `dist/harness/types.d.ts`；`pi-coding-agent/dist/core/model-runtime.d.ts` |
| 后台子代理模式 | `test/examples/23-subagent-background.ts`（GitHub main 分支） |
