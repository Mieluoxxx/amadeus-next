# pi-durable 评估（2026-10-11 核实版）

> **已归档（2026-10-11）**：迁移已完成，pi-durable 是唯一运行时。本文保留为评估依据与源码核实记录；P2 / P3（首包延迟、缓存命中率）仍待用 `scripts/durable-bench.mjs` 实测。

> 评估 `@earendil-works/pi-durable` 能否替代当前 `pi-worker` 中基于 `pi-coding-agent` 的运行时，作为委托（handoff）与长期记忆的底座。
> 调研日期 2026-10-10。2026-10-11 用 npm 包 1.1.0 的解包内容（`dist/*.d.ts`、`dist/harness`、`dist/session`、`dist/storage/sqlite` 的实现、README、CHANGELOG）、GitHub main 上的 `test/examples/23-subagent-background.ts`（当日重新拉取，363 行），以及本机 Electron 44 内的脚本实测重新核对。本文不再有"未验证"的 API 结论；需要真实模型才能得到的指标（首包、缓存命中率）放在 §4 原型里。实测数据与环境见附录 B。
> 基于本评估的整体架构见 `../architecture.md` v3；记忆与工具的具体设计见 `../long-term-memory.md` v6、`../pi-tool-constraints.md` v3。
> 实现同步：原型计划（§4）里的 P0 与后续 A1~A6、handoff v2 已经实现；下文"原型范围"的描述（占位工具、只开 `research`、每个会话一个 `lock`）是当时的计划，现状以 `../architecture.md` 为准：主对话有六个工具（`remember`、`forget`、`handoff`、`handoff_send`、`handoff_status`、`handoff_cancel`），子代理有 `research` / `files` / `task` 三类，进程锁是 `sessions/.lock`（§3.1 第 3 条已按实现改写）。实现后补充的安全验收见 S10~S12。

---

## 0. 结论

**值得采用，先做原型，不直接迁移。** 核实之后的变化：

- 上一版标"未验证"的四项全部成立：`edits` 的语义（`ContextEdit` 有 `omit` / `replace`）、`ModelRuntime` 可直接作为 `models`、`node:sqlite` 在 Electron 44 内可用（Node 24.18.1、SQLite 3.53.1，2026-10-11 重测）、示例 23 的 Anchor / Reporter 模式。
- 新发现的事实，其中第 1 条改变存储布局：
  1. durable **没有任何删除 API**。条目、对话不可变；任务、提交记录只能推进状态；四者都不能删除。`Tx` 与 `Storage` 接口里没有 delete / purge。唯一的物理删除是 `history: "latest"` 文档在写完整 base 或 `retireDoc` 时清掉旧修订，记录行仍在。要做"删除会话"，只能删掉整个存储文件。
  2. 流式输出的**第一个 partial 也要等满 `progress.partialIntervalMs`**（默认 100ms）才提交；`watchEvents` 是从提交派生的，宿主在提交之前看不到任何文本。实测首个非空文本事件 = 模型首个文本 + `partialIntervalMs` + 约 2~3ms。首个文本可能出现在 `message_start.message`、`text_start.block` 或 `text_delta` 中，事件桥三处都要取。
  3. 存储**单进程独占，但没有任何锁**。第二个进程打开同一个库不会报错，会接管并重跑第一个进程正在执行的任务，第一个进程的下一次提交因 ID 冲突失败并使其 Harness 中毒（实测，§3.1）。现有 `PiHost.restart()` 先拉起替换进程、就绪后再杀旧进程，所以旧 worker 必须先关库；应用层保障方案见 §3.1 末。
  4. 输入提交生成的条目永远是 `pi.user`，**汇报回合不能按 kind 与用户输入区分**，要靠 `requestId` 找到对应条目。只有提交时对话空闲且 inbox 为空，`SubmissionRecord.entry` 才立即可读。
  5. **角色热更新的语义随模型而变**：只有 `compat.supportsMidConvoSystemMessages` 为 true 的模型才"追加"新 section；其余模型把全部 system 消息折叠进开头的系统提示，等于整体重写并使缓存前缀失效（§2.4）。
  6. `Harness.open` **不调度任务**。`resume()`（或 submit / wait / abort）之后，被中断的主回合会重新向模型发请求，与现有"崩溃不重放 prompt"的契约冲突（`test/pi-reload.test.mjs:49`）。重启后必须先 `abort` 再恢复调度（§3.1、S1）。
  7. worker 仍然依赖 `pi-coding-agent`（`ModelRuntime` 只从它的根入口导出），durable 只新增约 4MB RSS，而不是 README 所说的 23MB（§3）。
- 包仍标注 Experimental：2026-09-19 到 10-07 发布 14 个版本（`npm view` 时间线，含 0.x），1.1.0 含两处破坏性变更（存储扫描的 `order` 字段、`TaskRuntime.context()` 的签名）。必须锁定精确版本，升级前读 CHANGELOG。SQLite 库的 schema 版本比代码新时拒绝打开（`migrations.js` 的 `applySqliteMigrations`），应用降级后读不了新库。

---

## 1. 它是什么

| 项 | 内容 |
| :--- | :--- |
| 包 | `@earendil-works/pi-durable` 1.1.0（2026-10-07），与当前 Pi 同一 monorepo、同一版本线；`engines.node >=22.19.0`，Electron 44 的 Node 24.18.1 满足 |
| 依赖 | `@earendil-works/pi-ai ^1.1.0`、`@earendil-works/chord ^1.1.0`、`typebox 1.3.27`、`diff 8.0.4`；**不依赖** `pi-coding-agent`。仓库里已有的 pi-ai 1.1.0、chord 1.1.0、typebox 1.3.27 与之完全一致且只有一份，不会出现双实例 |
| 定位 | 持久化 agent 运行时：对话、模型调用、工具调用、应用状态都先原子提交到存储，再对外可见；进程崩溃后重开存储即可从断点继续 |
| 稳定性 | README 开头标注 Experimental，API 在版本间随时变化 |
| 包内容 | 只有 `dist/`、README、CHANGELOG。`test/examples` 不随 npm 发布，示例只能从 GitHub 读 |
| 存储后端 | 内存、SQLite（`node:sqlite`，单文件）、JSONL（目录，可选 `fsync`）、Cloudflare DO。本项目用 SQLite：删除会话 = 删一个目录，且 `close()` 会 `wal_checkpoint(TRUNCATE)`，不留 `-wal` / `-shm` |

### 1.1 核心概念

| 概念 | 含义 | 对我们的意义 |
| :--- | :--- | :--- |
| Harness | 一个打开的存储加上运行 agent 的机制，所有修改走同一条原子提交线 | 取代 `ModelRuntime` + `AgentSession` 的组合；一个进程可以同时打开多个 Harness，每个对应一个存储文件（空闲开销见 §3.1） |
| Conversation | 一份由不可变条目组成的对话记录；可以创建多个、可以分叉 | 主会话和每个子代理各是一个 Conversation |
| Entry | 一条记录。`model` 字段进入模型上下文，`data` 字段只给界面和扩展；`edits` 可以 `omit` 或 `replace` 更早条目的模型消息，但只对当前活动范围（最新 head 标记起）内的条目生效 | 记忆快照、增量、重新冻结都可以是自定义条目 |
| Document | 与对话记录同事务提交的类型化 JSON 状态；分 session、conversation、task 三种作用域；`history: "latest"` 只保留当前值 | 会话元数据、子代理登记表、汇报信箱、记忆基线 |
| Task | 每一步都存检查点的持久状态机，有明确的归属者；`background: true` 的任务不受对话 abort 与空闲等待影响 | handoff 的投递与汇报、回合后抽取 |
| Submission | 交给对话的输入（`input`）或写入（`write`），可以等待其完成；`requestId` 在**对话内**幂等 | 用户输入、汇报投递都不会重复 |
| Extension | 一组 tools、sections、hooks、wraps、tasks；Registry 是进程内对象 | 红莉栖角色、记忆、handoff 各自一个扩展 |

---

## 2. 与现有设计的对应

### 2.1 委托（对应 `../pi-tool-constraints.md` §3）

官方示例 `23-subagent-background.ts`（GitHub main，2026-10-11 重新核对）实现了我们要的模式：

```text
subagent 工具（spawn / send / stop / status，replay: "unsafe"）
 └─ 一个 api.commit 内：
     ├─ 创建后台 Anchor 任务（background: true，首个 phase 就结束）
     ├─ tx.createConversation({ ownership: { kind: "task", taskId: anchor } })
     ├─ configure(tx, child.id, { extensions: { remove: [...] }, instructions })
     └─ 创建后台 Reporter 任务
Reporter
 ├─ deliver：向子对话 submit（requestId = `subagent:<reporter id>`），等待回答，在同一 commit 中记录已汇报
 └─ report：把回答作为 followUp 输入提交给主对话（requestId = `subagent-report:<reporter id>`）
```

| 我们的需求 | pi-durable 的机制 | 核实 |
| :--- | :--- | :--- |
| handoff 立即返回，主回合照常结束 | 工具只在 `api.commit()` 中创建任务；后台任务不让主对话保持忙碌 | README、示例 23 |
| 主人按停止不影响已委托的任务 | `background: true` 是边界；`Conversation.abort()` 只到此为止，`abort({ background: true })` 才连带停止 | `ConversationAbortOptions` |
| 子代理不能递归委托 | 子对话 `configure({ extensions: [...] })` 显式选择扩展；任务归属的子对话创建时复制归属者对话的 agent | `AgentChange.extensions`、`agent.js` 的 `createAgent` |
| 子代理用不同模型、工具、目录 | 每个对话可单独 `configure` model、thinkingLevel、extensions、tools、instructions、cwd | 同上 |
| 重启不丢、不重复 | 任务按检查点恢复；`requestId` 去重（对话内，重启后仍有效，实测） | `SubmissionRecordBase.requestId`、`Tx.submissionByRequest` |
| 取消任务 | `api.conversation(id).abort()`；子对话本身保留 | `ConversationHandle.abort` |
| 写操作需要确认 | `wrapTool` 替换 `execute`；`ToolExecutionApi` 继承 `DocumentObserver`，可以 `watchDoc` 等待确认文档变化（等待不持久，崩溃后工具返回 `interrupted`） | `dist/harness/types.d.ts:113` |
| 子代理在独立目录里运行 | `env: ({ cwd }) => new NodeExecutionEnv({ cwd })`，按对话 `cwd` 构造 | README Environment |
| 任务卡片 UI | `harness.taskGraph()` / `watchTaskGraph()`（只列活任务） | `Harness` 接口 |
| 超时 | 任务里 `Promise.race([submission.wait(), runtime.sleep(until)])`，超时后 abort 子对话。`until` 是 Harness 时钟的绝对毫秒；`sleep` 在 invocation 结束时以 reason 拒绝，输家必须用可取消的 context 或 `.catch` 收尾，否则产生未处理拒绝 | `TaskRuntime.sleep`、`scheduler.js:1159` |
| 并发上限 | durable 没有（`HarnessSettings` 无并发字段，调度器对所有可运行任务一并启动）；用主对话的 `app.handoffs` 文档计数，Reporter 在 `wait-slot` 阶段轮询 | 需自建 |

**需要我们补的部分：**

1. **投递时机。** durable 的 followUp 只知道对话忙不忙，不知道主人正在说话、语音是否在播放。`TaskRuntime` 继承 `DocumentObserver`，一次 invocation 内可以 `watchDoc`，但这种等待不是检查点（进程重启后 phase 重跑）；`waiting` 状态的 `on` 只能是任务。话筒状态在主进程，durable 看不到。已定方案（`../architecture.md` §4.3）：Reporter 把结果写进主对话的 `app.outbox` 文档，主进程话筒仲裁在话筒空闲时发 `report.deliver`，worker 再以 `requestId` 幂等地提交汇报输入。
2. **汇报回合的识别。** 汇报以 `input` 提交，生成的条目 kind 是 `pi.user`，与用户输入无法按 kind 区分。`admitSubmission` 只在"对话空闲且 inbox 为空"时直接返回 `placed` 并带 `entry`；inbox 里有残留项（失败的回合会留下排队项）时提交会排在它们后面，状态为 `queued`，`entry` 要等 `placed`。所以 worker 用 `submission` 事件（`events.js:219`，携带完整 `SubmissionRecord`）或 `Submission.status()` 取得 `entry`，把 `{ outboxId → submissionId, entryId }` 记入 `app.outbox.delivered`；界面按条目 id 决定渲染成卡片还是隐藏。事件桥给 `turn.*` 消息带 `kind: "user" | "report"`，依据是 `requestId` 前缀。
3. **投递时的忙闲校验。** 汇报输入用 `whenBusy: "reject"`：若 durable 认为对话忙（与主进程判断不一致），抛 `ConversationBusy`（不写任何记录），worker 回报 `busy`，汇报留在 outbox，主进程下一次空闲再投。已知 `requestId` 的重试会先于忙闲判断返回原提交（`submissions.js:117-124`），且同一 `requestId` 对应的提交若已 `unanswered`，重试拿到的仍是那条失败记录（实测），所以用户输入的 `requestId` 用 `turn_id`，重新发送要换新 id。

### 2.2 长期记忆注入（对应 `../long-term-memory.md` §4）

| 原设计 | pi-durable 下的做法 | 核实 |
| :--- | :--- | :--- |
| 快照钉在第一条 user 消息上，存 `injections` 表，`context` 事件重放 | 首轮写入自定义条目 `amadeus.memory-snapshot`，`model` 放快照文本。条目本身持久化，不需要重放表 | `EntryRecord.model` |
| 快照写在首个输入之前，system 会不会跑到快照后面 | 不会，**前提是快照的 `model` 消息 role 为 `user`**。`leadWithSystem` 只把"前面全是 user 消息"的 system 消息挪到最前（1.1.0 修复） | `dist/harness/context.js:113-123` |
| 增量块挂在本轮 user 消息上 | 有变化时先写一个 `amadeus.memory-update` 条目，再提交用户输入 | — |
| 重新冻结：改写快照、删除增量 | 写一个 `amadeus.memory-refreeze` 条目，`edits` 对原快照条目 `replace`、对所有增量条目 `omit`；条目自身不带 `model`。`edits` 只对当前活动范围内的条目生效，同一目标取范围内最新的一条。原快照已在压缩头之前时，改为追加新的 `amadeus.memory-snapshot` | `context.js:81-90`、`ContextEdit`、`Tx.latestHeadMarker` |
| 快照与输入"同一个 commit" | **做不到**。`Conversation.submit()` 一次只收一个 draft；`tx.createSubmission` 绕过准入，`dist/types.d.ts:716-720` 的注释明确要求用 `Conversation.submit()`。实际是两次提交：`conversation.commit(appendEntry + 基线文档)`，然后 `submit({ type: "input" })`。原子性不需要：worker 死在中间只丢一次输入 | `Tx` 接口 |
| 记忆条目只在对话空闲时写 | 记忆条目只在 `pi.live.run` 为空时用 `conversation.commit` 追加：`generation.js:28` 的注释假设忙碌的对话只有 Harness 在写。**忙时一律不写**，也不退到 `submit({ type: "write" })`：写提交在下一个边界才落位，位置不确定，基线文档无法与它同一 commit（`../long-term-memory.md` §4.1）。`write` 提交本身可用（排队、可带 `edits`、`abort()` 不撤回），只是记忆用不上 | `generation.js:28`、`admitSubmission`、`inbox.js` |
| 会话压缩后重新冻结 | 压缩后 durable 生成 `pi.compaction` 头；下一次提交输入前追加新快照。摘要里会含旧快照内容，与新快照重复；可用 `beforeCompact`（拿到已应用 edits 的 `messages`）自带摘要去重，非必需。压缩默认开启，仅当模型 `contextWindow > 0` 且超过 `contextWindow - 16384` 才触发 | `CompactionHooks`、`generation.js:214` |
| "不落会话记录"契约 | 改为"不出现在用户可见的记录里"：界面与事件桥按 kind 过滤 `amadeus.*` 条目。带 `model` 的自定义条目会产生 `message_start` + `message_end` 事件，`message_start` 不带 kind，要在同一批次的 `message_end.entry.kind` 上过滤 | `events.js:170-181` |
| `session_baseline` 表 | conversation 级 Document `app.memory-baseline` | `defineDoc` |

另一种方式是 `hook(GenerationTask, { beforeRequest })` 只改写单次请求的消息、不写入对话记录。它要自己保证每次请求结果相同，缓存前缀也更难控制。**优先用条目方式。**

**条目由谁写。** `HookApi` 有 `taskId`、`conversationId`、`models`、`memo`、`snapshot`、`snapshotAsOf`，**不能 `commit`**。记忆条目由 pi-worker 宿主代码写入。

### 2.3 回合后抽取（对应 `../long-term-memory.md` §5.2）

- `onYield`、`afterTools` 不能提交事务。worker 事件桥观察到 `run_end`（`run.inputs[0]` 变化时发出，`events.js:216`）后，宿主用 `conversation.commit(tx => tx.createTask(MemoryExtract, input, { ownership: { kind: "conversation" }, background: true }))` 创建后台任务：持久、重启后继续、不阻塞主对话。
- `watchEvents` 的监听器串行执行，且**监听器抛错会终止整条流**（`observation.js:247`）。事件桥监听器自己 try/catch，创建任务这类异步操作不 await，否则后续批次排队。
- 任务通过 `TaskRuntime.models`（`dist/types.d.ts:146`）用同一份模型配置发请求。1.1.0 新增的是 `ToolExecutionApi.models` 与 `HookApi.models`，`TaskRuntime.models` 早已存在。

### 2.4 system prompt 与缓存

- system prompt 由所选扩展的 sections 按顺序拼成，`instructions` 排在最后。变化的部分作为**位置化的 `pi.system` 条目**追加，内容是按 section 名的补丁（`prompt.js` 的 `planSystemEntries`）。
- **旧 section 文本是否留在上下文里取决于模型。** pi-ai 对 `compat.supportsMidConvoSystemMessages` 为 true 的模型原样发送后续 system 消息（缓存前缀保留，模型看到"开头的旧角色文本 + 后面一条新角色文本"）；其余模型走 `collapseSystemMessages`，把所有 system 补丁折叠进开头的系统提示，旧文本消失、前缀整体失效（`pi-ai/dist/utils/transcript.js:96-102`，pi-ai README:1601）。默认值为 false，只有生成的模型目录为"已验证"的型号置 true。Anthropic 目录里置 true 的有 claude-fable-5、fable-5-1、haiku-5-5、opus-4-8、opus-5、opus-5-5、sonnet-5-5；haiku-4-5、opus-4-5 / 4-6 / 4-7、sonnet-4-5 / 4-6 / 5 为 false（`pi-ai/dist/providers/data/anthropic.json`）。用户自定义 `models.json` 里的模型要自己写 `compat`。所以**会话中途改 ROLE.md 对前一类是"追加更新"，对后一类是"整体重写"**。角色需要彻底重来时开新会话。
- 每个对话有持久的 UUIDv7 作为 pi-ai 的 `sessionId`，重启、重试、压缩后不变；子对话和分叉拿新 id。
- pi-ai 的 Anthropic provider 把 `cache_control` 打在 system、最后一个 tool、最后一条 user / system 消息上；`cacheRetention` 透传，默认 `short`（5 分钟），`long` 为 1 小时（`supportsLongCacheRetention` 默认 true）；`sessionId` 只在 `compat.sendSessionAffinityHeaders` 的端点才作为头发送。OpenAI 系 API 的亲和头见 `compat.sessionAffinityFormat`（pi-ai README:1408）。
- section 不能返回随时间变化的内容。`composePrompt` 只读 ROLE / PRESENTATION 文件，满足。
- 缓存命中率的算法：`usage.input` 不含缓存部分，命中率 = `cacheRead / (input + cacheRead + cacheWrite)`。

### 2.5 流式输出

`generation.js` 的 `streamResponse`：收到第一个有内容的 partial 后 `setTimeout(flush, interval)`，到期才 `commit` 到 `pi.live`；之后每次提交完成再隔 `interval` 提交下一次，同一时刻最多一个提交在途。所以：

- 宿主看到第一个文本的时间 = 模型首个文本 + `partialIntervalMs` + 一次本地 SQLite 提交 + watch 派发 + 端口消息。实测（faux provider，provider 侧首个非空文本到事件桥收到）：`partialIntervalMs` 为 100 时中位数 101.8ms，为 30 时 32.7ms。
- 文本按批到达，不是逐 token。`PresentationText` 对分片大小没有假设。
- 首个文本可能出现在三处：`message_start.message.content`、`message_update` 里的 `text_start.block.text`、`text_delta`；30ms 下第一批常常是空文本块，文本随后以 `text_delta` 到达。部分提交失败后重试或整条替换时会收到 `{ type: "block" }` 或 `{ type: "message" }`（整块 / 整条消息）。事件桥按 contentIndex 记已转发长度，只转发增量，TTS 才不会重复。`text_delta` 由 Chord 的 append 操作生成（`events.js:242-278`）。
- 提交很便宜：partial 以 `assignJson` 逐叶写入，字符串增长只存追加量；实测每次提交平均 0.5ms（最大 2.9ms），200 字回答每回合约 16 次提交，30 回合的库 168KB。把 `settings.progress.partialIntervalMs` 设为 30ms 可接受。

---

## 3. 迁移代价

对照 `src/main` 的真实代码。工作量为估算（人日，含测试）。

| 项 | 现状 | 迁移后 | 工作量 |
| :--- | :--- | :--- | :--- |
| 运行时 | `pi-worker.ts` 200 行：`createAgentSession` + `DefaultResourceLoader`，进程内 `Map<sessionId, AgentSession>`，所有命令（prompt / models / set-model / checkpoint / reload）串行排队，abort 旁路 | `Harness.open(storage, { models, registry, settings, env }, context)`，一会话一个 Harness；SessionHost 管理打开 / 关闭；命令集见 `../architecture.md` | 重写 `pi-worker.ts` 主体，约 5~7 |
| 模型配置 | `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })` | `ModelRuntime implements Models`，直接作为 `models` 传入；pi-ai、typebox、chord 版本一致。`pi-coding-agent` 仍保留为依赖（`ModelRuntime`、`getAgentDir` 只从它的根入口导出） | 小 |
| 模型与思考档位 | `followSelection` 每次 prompt 前读 `settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`，`session.setModel(.., { persist: true })` 经 SettingsManager 回写 | durable 没有宿主默认模型：每个对话必须 `configure({ model, thinkingLevel })`（`thinkingLevel` 缺省 `"off"`，没有 model 时回合以 `no_model` 失败）。读写 `settings.json` 由 worker 自己做；档位列表用 `getSupportedThinkingLevels(model)`（`pi-ai` 根导出，`AgentSession.getAvailableThinkingLevels` 的底层）。子对话创建时复制主对话的 agent | 约 1 |
| 角色 prompt | `systemPromptOverride` → `composePrompt` | `amadeus-role` 扩展的 section，每次请求时读文件；热更新语义随模型变化（§2.4） | 小 |
| 流式输出 | `session.subscribe` 的 `message_update` / `text_delta`，立即到达 | `watchEvents(harness, id)`；首包多一个 `partialIntervalMs`；首个文本可能在 `message_start` / `text_start`（§2.5）；监听器自带异常隔离与溢出重同步（§3.1） | 中：事件桥约 3~4，要测首包 |
| 中断 | `session.abort()` + `epochs` 丢弃排队的 prompt | `conversation.abort()`：撤回排队输入，中止非后台任务，等到空闲；半截回答落成 `stopReason: "aborted"` 的助手条目，不进模型上下文 | 小 |
| 会话存储 | Pi jsonl（`piSessions.ts` 15 行）+ `SessionStore` JSON（30 行，`appRuntime` 里 `session.list/create/load`、`runChat` 写消息） | 每个会话一个 `durable.sqlite`（`openNodeSqliteStorage`，底层 `node:sqlite`）；会话列表与历史来自 durable。界面历史用分页的 `Conversation.entries()`（一次性读取、fork 感知、不订阅），不用 `viewState()` / `watch()`：它们的值含整条活动记录和全部内置文档，并订阅之后的每次提交，只适合需要持续跟随的场景。按 kind 过滤 `amadeus.*`，带 `aborted` 的半截回答不显示；`SessionStore` 退役为只读 | 中：`appRuntime.ts`（763 行）的会话与回合部分改为经 worker，约 4~6 |
| 删除会话 | **现状没有该功能**（`appRuntime` 无 `session.delete`） | 新功能：关闭 Harness + 删目录（durable 没有删除 API）；运行中的后台任务先 `abort({ background: true })` | 中，约 2 |
| 旧会话 | `amadeus-next-sessions.json` 有全部文本 | 只读保留：列表里单独一组，不可继续；Pi jsonl 不再打开 | 小 |
| worker 重启 | `PiHost.restart()`：checkpoint → 拉起新进程 → 杀旧进程；`test/pi-reload.test.mjs` 约定"崩溃不重放 prompt"（:49）、"替换失败旧进程仍可用"（:53） | `checkpoint` **只在重启或退出时发**：旧 worker 关闭全部库（空闲 1ms，流式中约 73ms，会中止在途请求）并进入 closed 状态，只接受 `checkpoint`（幂等）和 `resume`；替换失败时主进程对旧 worker 发 `resume`，会话懒重开，保住"替换失败旧进程仍可用"；重启期间由主进程 `reloading` 状态阻止新命令；新进程开库后先 `abort` 被中断的主回合再恢复调度（S1）。现状 `appRuntime.ts:314` 对**所有** reload 目标都先发 `checkpoint`，durable 下这会让 `scene` / `speech` / 单独 `pi` 的重载也关库，要改成只有 `pi-worker`、`main`、worker 已挂的 `pi` 才发（`pi` 单独重载走 `reload`） | 小~中，约 1~2 |
| `PiHost` | 只有逐请求回调（`onText` / `onTool`），无长连接事件 | 增加通用事件订阅（`task.*`、`report-ready`、`approval-request`）和 `report.deliver` 等命令 | 约 1~2 |
| 内置工具 | 默认 read / bash / edit / write | 默认没有工具；`@earendil-works/pi-durable/tools` 需要时显式安装 | 无 |
| 扩展 | 不使用外部扩展 | `defineExtension`；Registry 进程内，不读 `~/.pi/agent`；任务定义随扩展安装，版本升级需 `migrate`，否则旧任务被阻塞（§3.1） | 无 |
| 依赖与打包 | `package.json` 只有 `pi-coding-agent` 1.1.0；`vite/main.config.mjs` 显式 external 只有 `pi-coding-agent`、electron、`node:*`、`ws`、`@msgpack/msgpack` | `dependencies` 增加 `@earendil-works/pi-durable` 1.1.0（精确）；worker 直接 import 的 `pi-ai` 也声明为直接依赖。Vite SSR 对 `node_modules` 内的依赖默认外置（实测 pi-durable、pi-ai 均保持 import），所以不需要改 external，但 electron-builder 要把它们带进包（P12）。`node:sqlite` 是内置模块，没有原生模块重编译问题 | 小 |
| 测试 | `pi-reload.test.mjs` 3 个用例，`turn-lifecycle.test.mjs`（647 行）用 fake `PiHost`，`electron-acceptance.cjs` 带固定的 OpenAI 兼容 fixture 服务器 | `openPiSession` 用例删除，PiHost 用例保留；fake PiHost 补事件；acceptance 加 `AMADEUS_NEXT_RUNTIME=durable` 分支（该变量目前未被代码使用）；新增首包 / 重启 / 故障注入脚本 | 约 3~4 |
| 内存 | 当前 worker 已加载 `pi-coding-agent` | 实测 Electron 44 内仅 import：`pi-coding-agent` +76MB，durable 根入口单独 +29MB，两者同进程时 durable 只多 +4MB（TypeBox 已被加载）。README 的 23MB 不适用于本项目 | 可接受 |

合计估算约 20~28 人日（不含 A2 以后的委托 / 记忆功能本身）。

### 3.1 约束

| 约束 | 事实与依据 | 对设计的影响 |
| :--- | :--- | :--- |
| **没有删除** | `Tx`、`Storage` 无 delete；条目、对话不可变，任务、提交只推进状态。例外：`history: "latest"` 文档写完整 base 或 `retireDoc` 时删旧修订（`storage.js:649-663`），记录行保留 | 设计里所有"删除"都落到"删除存储文件"或"文档里打标记"；敏感内容别写进条目 |
| **单进程独占存储，没有锁** | 第二个进程打开不报错；写事务 `BEGIN IMMEDIATE`，仅写锁竞争时等 `busy_timeout`（默认 5000ms）；ID 由各进程内存中的 `nextId` 铸造（`storage.js:123`）。实测两个进程开同一个库：B 接管并重跑 A 的在途生成，A 的下一次提交报 `ID 10 already belongs to submission`，A 的 Harness 中毒 | 只能由 `pi-worker` 打开，主进程只通过命令访问；重启必须先关库再拉起（§3）。durable 不保证这一点，应用层保障方案见本节末 |
| **提交失败会使 Harness 中毒** | 非 `StorageRejected` 的存储错误（`SQLITE_BUSY`、磁盘满、ID 冲突）设置 `#poison`，之后所有操作抛 "Session is poisoned … reopen it"（`session.js:276,285,376`） | worker 对 Harness 调用的错误要识别中毒并关闭重开；`onReport` 要接日志 |
| **`open` 不调度** | `Harness.open` 只把 `running` 任务改回 `pending`；`resume()`、submit、wait、abort、compact 才启动调度（`scheduler.js:88-118`）。实测重开后 300ms 无任何动作，`resume()` 后被中断的生成**重新向模型发请求**，记录里留下一条 `aborted` 的半截回答和一条完整回答 | 与"崩溃不重放 prompt"冲突：开库后对 `live.run` 存在的对话先 `abort()`（实测 4ms，不发模型请求，提交落为 `unanswered / aborted`），再 `resume()` 恢复后台任务（S1） |
| **后台任务只在库打开时推进** | 一会话一库，Reporter / 抽取任务属于各自的库 | 切换会话不能关掉有活任务的库；启动时打开索引里标记"有未完成任务"的会话（`../architecture.md` §2.2） |
| **关闭即中止在途工作** | `close()` 给所有 invocation 发 abort 并 join（`scheduler.js:620-632`）；重开后任务从检查点恢复，生成重新请求，`replay: "unsafe"` 的工具返回 `interrupted`（`tool.js:83`） | 热重载 worker 时在途的子代理请求会重发，产生重复 token 费用 |
| **SQLite 的持久性与阻塞** | WAL + `synchronous = NORMAL`（`node.js:160-162`），进程崩溃不丢提交，断电可能丢最新一次提交；`node:sqlite` 是同步 API，提交期间 worker 事件循环被占用 | 10,000 条目（约 8MB）一次提交 108ms，日常提交 0.5ms，可接受 |
| **库的 schema 版本** | 库比代码新时拒绝打开（`migrations.js`） | 应用降级后读不了新库；升级 durable 前备份 |
| **工具重放语义** | 只有 `replay: "safe"` 的工具在崩溃后重跑，其余返回 `interrupted` | 见 `../pi-tool-constraints.md` §2.2 |
| **hook 不能 commit** | `HookApi` 无 `commit`；`beforeTool` 内等待既不持久也阻塞 | 写入逻辑放在宿主或工具里 |
| **`watchEvents` 本身标注 Experimental** | 是最不稳定的接口。事件桥隔离在一个适配模块里；结构化的 `viewState()` / `watch()` 是退路 | — |
| **`watchEvents` 背压** | 每条流最多缓存 100 个未投递批次（`observation.js:3,209`）；溢出时丢弃积压，改发**一个 `snapshot` 事件**，其中含当前活动记录的全部 `entries`；监听器是串行 `await` 的；监听器抛错会终止整条流（`listener_error`）；Harness 关闭时流以 `session_closed` 结束 | 30ms 间隔下约 3 秒缓冲。桥要能在流中途处理 `snapshot`（对比已转发长度补发缺失文本，不重复），监听器内部 try/catch，关闭后重新附加；只在会话打开时附加一次，别每回合附加（附加时的 `snapshot` 含全部条目） |
| **事务大小** | 没有大小上限；partial 提交只写追加量；工具输出默认保留 2000 行 / 50KB（`truncate.js:10-11`） | 实测见附录 B；记忆快照几 KB 无影响 |
| **多个 Harness 的开销** | 每个库 3 个 fd（db、wal、shm），一条提交线，一份文档缓存，一份上下文缓存。实测 30 个空闲且已 `resume()` / 附加事件流的库：+9MB RSS、+90 fd、每个打开约 2ms、关闭约 1ms，关闭后无 `-wal` / `-shm` 残留 | 空会话开销可忽略；fd 上限（utility process 的 `ulimit -n`）未测，SessionHost 的空闲关闭策略要限制并存数（S2） |
| **子对话与 compaction** | 每个对话独立压缩，策略在 Harness 级（`settings.compaction`）；子对话有自己的 `sessionId`；摘要费用记入该对话的 `pi.usage`；`contextWindow <= 0` 的模型不触发阈值压缩 | 长时间运行的子代理会自动压缩，不需要宿主介入；主对话的记忆快照会进摘要（§2.2） |
| **abort 语义** | `Conversation.abort()`：一个提交内撤回排队的输入（排队的 write 保留）、给范围内非后台任务打 abort 标记，然后等到对话空闲才返回；半截回答落成 `aborted` 助手条目，提交 `unanswered / aborted`；没有超时，不响应 signal 的工具会让它一直挂着；已空闲时是空操作 | worker 的 `abort` 命令保持旁路；主进程 `pi.abort` 为 fire-and-forget，60s 命令超时不会误伤 |
| **`requestId` 幂等的作用域** | 限定在**对话内**（`Tx.submissionByRequest(conversationId, requestId)`），不比较内容，类型不同则抛错；已知 id 先于忙闲判断返回原提交；已 `unanswered` 的提交也原样返回；SQLite 索引不是唯一约束，靠单进程的提交线保证 | 用户输入用 `turn_id`；汇报用 `report:<outboxId>`；重发要换新 id；记录永不过期 |
| **`contextRetentionMs`** | 默认 10 分钟：空闲对话把上次读取的上下文留在内存里；关闭 Harness 时全部清空。实测 10,000 条目的对话，缓存命中时提交到 provider 调用约 1ms，冷读（重开后首次或保留期为 0）约 32ms，200 条目约 4ms；RSS 随缓存条目增长（200 条 89MB → 10,000 条 129MB） | 与 SessionHost 的关闭时限一致即可；典型会话不会感知冷读 |
| **任务定义的版本** | 缺失定义的任务进入 `blocked`（`missing_task`），版本过旧且无 `migrate` 的进入 `task_too_old`（`scheduler.js:742-747`、`canReserve`），不会失败也不会推进 | `amadeus-handoff` 的 Anchor / Reporter 升级版本号必须提供 `migrate`；`resume()` 前先安装扩展 |
| **模型必须逐对话配置** | `Agent.model` 缺省时回合以 `no_model` 失败；`thinkingLevel` 缺省 `"off"` | 见 §3 模型与思考档位 |
| **`NodeExecutionEnv` 的 cwd 不是沙箱** | `resolvePath` 对绝对路径、`~`、`file://` 直接放行（`env/node.js:30-46`），read / write / edit 和 `exec` 的 `cwd` 选项都走它（`:575,588,824`）；bash 默认 `inheritEnv: true`，子进程环境 = worker 的整个 `process.env`（`env/node.js:197-203`、`tools/bash.js:30`），其中有 `AMADEUS_JEV_API_KEY`（`appRuntime.ts:430` 经 `piEnv()` 传入）和代理变量 | 路径约束要自己做：`wrapTool` 在 `execute` 前校验根集合，或自定义 `ExecutionEnv`；`createBashTool({ prepare })` 里设 `execution.inheritEnv = false`，只给白名单变量（`tools/bash.js:23-33`）。bash 能读到用户权限内的任何文件，这一层关不死，靠 `task` 类型的逐次确认兜底；`research` / `files` 类型不装 bash（S5） |
| **API 不稳定** | `package.json` 锁定精确版本，升级前读 CHANGELOG | — |

**单进程独占的应用层保障**（供 `../architecture.md` §2.2 引用）。durable 不拒绝第二个打开者，所以要自己保证同一时刻只有一个 worker 持有某个库，分四层：

1. **应用级**：主进程 `app.requestSingleInstanceLock()`（`src/main` 目前没有使用），第二个实例直接退出并聚焦第一个窗口，避免两个应用实例各起一个 worker 指向同一 `userData`。
2. **进程级时序**：任何拉起新 worker 的路径都以旧进程已 `exit` 为前提，或旧 worker 已 `checkpoint` 完成。`restart()`：旧 worker `checkpoint`（关全部库，进入 closed）→ 拉起替换进程并等 `ready`（新进程此时才开库）→ 杀旧进程。`checkpoint` 超时或失败：**先 `kill` 旧进程并等到 `exit`，再拉起新进程**，不能并行（旧 worker 可能还在写）。替换失败：对旧 worker 发 `resume`。worker 崩溃后的自动重拉发生在 `exit` 之后，天然满足。
3. **文件级锁**（已实现，`durable/processLock.ts`）：**整个 `sessions/` 目录一个 `.lock`**，不是每个会话一个；先取锁、再开任何库。`fs.writeFile(path, …, { flag: 'wx' })` 原子创建，内容 `{ pid, startedAt }`；`checkpoint` 完成后删除，`resume` 重新取，进程退出时尽力删除。遇到已有锁：持有者 pid 是自己则放行；`process.kill(pid, 0)` 抛 `ESRCH`（崩溃遗留）则删除后用 `wx` 重新抢一次；pid 存活但**核对启动时间**发现它是锁写下之后才启动的进程（`utilityProcess` 被 `kill()` 时不跑退出钩子，残锁里的 pid 可能被无关进程复用）也按遗留处理：用 `ps -o lstart=` 取该 pid 的启动时间，晚于 `startedAt` 超过 30 秒（`lstart` 只有秒级精度）就接管，取不到（没有 `ps`、Windows）按存活处理；确认存活的持有者每秒重试一次，最多等 10 秒，仍被占用就在 `ready` 里报错、不开库，不覆盖。Node 没有 `flock`，所以用 pid 加启动时间判活。旧格式只写了 pid 的锁兼容。删除会话不涉及这个锁（锁不属于会话）。应用启动时清空遗留锁、先 `SIGTERM` 存活持有者的做法没有采用：启动时间核对已经覆盖"残锁被复用 pid 占住"的情形。
4. **兜底**：`onReport` 与提交错误中出现 `already belongs to`、`database is locked` 视为保障失效，记录告警并关闭、重开该会话（Harness 此时已中毒，§3.1）。

主进程被强杀后 Electron 是否带走 utility process 未验证（P10 补充项）；未验证期间，由第 3 层的启动清理兜底。

---

## 4. 原型计划

目标：用最少的代码回答"能不能迁移"，并把 §0 的新问题一并验证。原型与现有 `pi-worker` 并存，用 `AMADEUS_NEXT_RUNTIME=durable` 切换，不改动渲染进程。

### 4.1 范围

- 一会话一个 Harness：`openNodeSqliteStorage(<userData>/sessions/<id>/durable.sqlite)` + 现有 `ModelRuntime`。
- `settings`：`extensions: []`、`progress: { partialIntervalMs: 30 }`、`stream: { cacheRetention: "long" }`、`contextRetentionMs` 与 SessionHost 关闭时限一致。
- 每个对话显式 `configure({ model, thinkingLevel, extensions })`。
- 扩展 `amadeus-role`：一个 section 输出 `composePrompt()` 的结果。
- 扩展 `amadeus-handoff`：照示例 23 改写的 `handoff` 工具 + Anchor / Reporter；Reporter 写 `app.outbox` 而不是直接提交；子代理只开 `research` 类型，带一个占位工具（原型范围；已实现的主对话工具集与子代理类型见本文开头的实现同步）。
- 扩展 `amadeus-memory`（最小注入）：首轮写入固定内容的快照条目（user 消息）；第 10 轮用 `replace` 重新冻结一次。
- 事件桥：`watchEvents` 转成现有的 `text` / `tool` / `done` 端口消息，带 `kind`；复用当前字幕与 TTS 链路；处理 `message_start` / `text_start` / `text_delta` / `block` / `message` / `snapshot`。
- worker 的 `checkpoint` 命令关闭全部 Harness 并进入 closed 状态，只在重启或退出时发；新增 `resume` 命令（替换失败时让旧 worker 离开 closed 状态，会话懒重开）；`pi` 单独重载走 `reload`，不关库。
- 开库后对有未完成主回合的对话先 `abort` 再 `resume()`。
- 单进程独占的应用层保障：单实例锁、拉起新 worker 前旧进程已 `exit`、会话目录 `lock` 文件（§3.1 末）。
- 子代理执行边界：`task` 类型的最小 bash（`inheritEnv = false` + 路径根集合）用于验证 S5。

### 4.2 验收

测量工具：`test/electron-acceptance.cjs` 已有一个按脚本回包的 OpenAI 兼容 fixture 服务器（`requests[]` 记录每个请求体，`hold-for-reload` 可挂起），首包、请求体、重启类验收都在它上面扩展；真实模型只用于 P3、P8 的缓存指标。耗时用 `performance.now()` 在 worker 内打点；`kill -9` 用 `process.kill(pid, 'SIGKILL')`（pid 来自 `Pi runtime ready: <pid>` 日志）。

| # | 项目 | 通过标准 | 测量方法 |
| :--- | :--- | :--- | :--- |
| P1 | 模型配置复用 | 现有 `auth.json` / `models.json` 下能正常对话，无需改配置 | 用 acceptance 的 `AMADEUS_PI_CREDENTIALS_DIR` 固定凭据，分别以两种运行时跑一轮对话，比较 fixture 收到的请求体（`model`、`Authorization`、`stream`）；再执行 `pi.models` / `pi.model.set`（含 thinkingLevel），对比返回的 `models`、`current`、`thinkingLevels` 与旧 worker 逐项一致，`settings.json` 里的 `default*` 被正确回写 |
| P2 | 首包延迟 | 分别在 `partialIntervalMs` 为 100 与 30 时，与现有 `pi-worker` 对比首个文本到达时间；30ms 下中位数差距 ≤ 100ms | fixture 服务器在收到请求后固定延迟发首块并记录发送时刻 `t_srv`；worker 记录首个非空 `text` 端口消息的发出时刻 `t_port`；每种配置 ≥ 30 次，报中位数与 P95 的 `t_port − t_srv`，旧运行时同法测基线。本机预估：额外开销约等于 `partialIntervalMs` + 2~3ms（100 / 30 时实测 102 / 33ms），所以默认值 100 会踩线，30 有余量 |
| P3 | 缓存 | 真实 Anthropic 模型连续 20 轮，第 2 轮起命中率 ≥ 80% | 选 `supportsMidConvoSystemMessages` 为 true 的型号（如 claude-sonnet-5-5），轮间隔小于 `cacheRetention` 的 TTL（short 5 分钟 / long 1 小时）；每轮读助手条目 `usage`，命中率 = `cacheRead / (input + cacheRead + cacheWrite)`；`message_end.entry.model[0].usage` 或库中 `entries.record` 均可取 |
| P4 | 委托 | handoff 后主回合立即结束；outbox 收到结果后，`report.deliver` 投递成功；期间主人可以继续聊天 | 脚本化模型返回 `handoff` 工具调用，子代理 fixture 延迟 3 秒回答；断言时间序：主回合 `run_end` 早于子代理完成；`app.outbox.pending` 出现；期间再发一条用户输入得到回答；`report.deliver` 后 `submission` 事件的 `requestId = report:<id>` 且状态 `placed`。辅助函数可参照示例 23 的 `settle()` / `until()` |
| P5 | 重启恢复 | 子代理运行中杀掉 worker 再重启，outbox 仍收到结果且只收到一次 | fixture 挂起子代理请求，`kill -9` worker，重启后按索引打开会话；SQL 断言：`SELECT count(*) FROM submissions WHERE request_id = 'report:<id>'` 为 1，子对话里 brief 条目只有 1 条（`requestId = handoff:<task_id>`），`app.outbox.delivered` 该 id 只出现一次；允许 fixture 看到 2 次子代理请求（重试） |
| P6 | 中断边界 | 主对话 abort 不影响后台子代理；`handoff_cancel` 能停掉子代理 | 子代理运行中发 `chat.abort`，断言 `harness.taskGraph()` 里 Reporter 仍是 `pending / running`，子对话 `pi.live.run` 仍在；再调 `handoff_cancel`，断言子对话提交为 `unanswered / aborted`、`app.handoffs` 条目置 `cancelled`、`app.outbox` 没有新增汇报（取消不生成汇报，`../architecture.md` §3.2） |
| P7 | 记忆条目 | 快照条目进入模型请求且位于首条 system 之后、首条用户输入之前；不出现在字幕、TTS 和界面记录中 | 在 fixture 的 `requests[0].messages` 断言顺序：`[system, 快照, user]`；快照 role 为 user；收集 `chat.token`、`voice.event`、`session.load` 的消息，断言不含快照文本，也没有 `amadeus.*` kind 的气泡（`message_start` 不带 kind 的情形要覆盖） |
| P8 | 重新冻结 | `replace` 后请求里只剩新快照文本；增量条目不再出现；仅一次缓存失效 | 第 10 轮后对 fixture 相邻两次请求体做 diff：快照文本替换、增量消失、其余前缀逐字节一致；真实 Anthropic 上看 `usage`：仅第 11 轮 `cacheRead` 下降、`cacheWrite` 升高，第 12 轮恢复 |
| P9 | 汇报识别 | 汇报回合的 `pi.user` 条目能通过 `app.outbox.delivered` 定位，界面渲染为卡片 | 对比 `delivered[*].entryId` 与 `Conversation.entries` 中的 `pi.user` 条目集合；覆盖 inbox 里有残留排队项、提交先 `queued` 后 `placed` 的情形（`submission` 事件取 entry）；用 acceptance 的 DOM 断言汇报显示为任务卡片而非用户气泡 |
| P10 | 重启时序 | `runtime.reload` 的 pi-worker 路径下，旧 worker 关库后新 worker 才打开；无 `SQLITE_BUSY` | 在 `openNodeSqliteStorage` / `harness.close` 周围打点（时间戳 + pid），断言 close(旧) < open(新)；日志无 `database is locked`、`SQLITE_BUSY`、`poisoned`；反例对照：让两个进程同时开同一个库，应复现中毒，且第二个进程在 `lock` 文件存在时被拒绝；替换进程启动失败时旧 worker 经 `resume` 恢复可用（保留 `test/pi-reload.test.mjs` 的对应用例）；`scene` / `speech` / 单独 `pi` 重载不发 `checkpoint`、库保持打开；`checkpoint` 超时时先杀旧进程再拉起新进程；`kill -9` 主进程后检查 worker 是否随之退出，未退出则启动清理能回收 `lock` |
| P11 | 删除会话 | 后台子代理运行中删除会话：任务被中止，目录被删除，重启后不复活 | 同 P5 场景下调用删除；断言 `abort({ background: true })` 与 `close()` 返回、目录不存在、无 `-wal` / `-shm`、`readdirSync('/dev/fd')` 数量回落、`index.json` 无该会话；重启后 fixture 不再收到该会话的请求 |
| P12 | 打包 | Electron 打包后 `node:sqlite` 与 pi-durable 正常加载 | `npm run package:mac` 后运行打包产物，日志有 `Pi runtime ready`，跑一轮对话和一次会话重开；`npx asar list` 确认包内含 `node_modules/@earendil-works/pi-durable` 与 `pi-ai`；`package.json` 已声明精确版本依赖 |

**补充项**（核实中新发现的限制，以及 `../architecture.md` §12 的待验证项 V1~V6；不改变 P1~P12 的编号）：

| # | 项目 | 通过标准 | 测量方法 |
| :--- | :--- | :--- | :--- |
| S1（V1） | 崩溃后不重放主回合 | 主回合流式中杀掉 worker，重启后不会自动产生未被请求的回答；`abort()` 与 `resume()` 紧接时也不会在标记生效前发出模型请求 | fixture 记录请求计数：`kill -9` 后重启、开库（先不 `resume()`）、`abort`、`resume()`，计数不增加；对应提交为 `unanswered / aborted`；下一轮用户输入正常；后台 Reporter 仍被恢复。V1 的竞态：`Conversation.abort()` 先 `resume()` 再同步入队 abort 提交（`harness.js:65-70`），调度的首次 reserve 排在其后，一次实测零请求；原型里对 abort 与 resume 紧接的情形重复 ≥ 50 次，计数始终不增加 |
| S2（V5） | 多库常驻与启动并行打开 | 并存 N 个会话库、启动时并行打开 N 个 `hasActive` 会话的耗时与 RSS 在预算内 | 脚本打开 N = 1 / 10 / 30 个库（含 `watchEvents`、`resume()`），分别串行和 `Promise.all`，读 `process.memoryUsage().rss`、`readdirSync('/dev/fd').length`、打开 / 关闭耗时；用带真实记录（如 2,000 条目）的库测首次 run 的冷读；在 utility process 内记录 `ulimit -n`；预算：30 个空闲库 < +30MB（本机实测 +9MB / +90 fd，空库串行约 2ms 一个） |
| S3（V2） | 事件桥背压、差量补发与故障隔离 | 慢消费者溢出后字幕不重复不丢失；短回答（没有 partial，事件里只有 `message_start` / `message_end`）补发完整不重复；监听器异常不终止流；库中毒后可恢复 | 监听器故意阻塞 3 秒以上（30ms 间隔下超过 100 批），断言收到 `snapshot` 后累计文本等于最终助手条目文本；用 fixture 返回一次性整条短回答，断言端口消息的文本等于原文且只发一次（`events.js:173-181` 在没有 partial 时由 `message_start` 带整条消息）；监听器内抛错被捕获，流继续；注入存储错误后 worker 关闭并重开该会话 |
| S4 | 角色热更新随模型变化 | `supportsMidConvoSystemMessages` 为 true / false 的两类模型，改 ROLE.md 后行为与 §2.4 一致 | 同一会话中途改 ROLE.md，对比 fixture 请求体：true 型号保留旧 system 并追加补丁，false 型号开头系统提示整体替换；真实模型上看 `cacheRead` 是否在 false 型号上归零 |
| S5 | 子代理执行边界 | `task` 类型子代理读不到 `AMADEUS_JEV_API_KEY` 等 worker 环境变量，读 / 写 cwd 根集合外的路径被拒；bash 仍可读用户权限内的文件，记录为已知限制 | 脚本化子代理依次调用：`bash printenv`（不得出现 `AMADEUS_JEV_API_KEY`，只有白名单变量）、`read` 绝对路径（如 `~/.pi/agent/auth.json`）、`read ~/…`、`read file:///…`、`read ../x`、`write` 根外路径，断言 `tool_result` 为拒绝；`bash cat /abs/path` 作为对照，确认确认机制在其前面拦截 |
| S6（V3） | 流式中途失败后重试不重复播报 | 首次尝试已转发的前半句，重试后不再播第二遍 | fixture 在首次请求发出部分文本后断开连接；失败的助手消息作为条目追加并发出 `message_end`，随后 `auto_retry_start`，新一次尝试从头开始（`generation.js:373`、`events.js:128-134`）。断言 `auto_retry_start` 到达时主进程重置字幕与 TTS，最终播报文本不含重复前半句；对比降 `retry.maxRetries` 为 0 的方案（改为 `turn.error`），选一种 |
| S7（V4 + 记忆） | 连续 user 消息 | 快照条目（user）紧邻用户输入（user），以及 `report_proactive` 关闭时用 `type: "write"` 提交的自定义 kind 汇报条目，在 Anthropic 请求中被接受，缓存前缀不受影响 | pi-ai 不合并相邻 user 消息，只合并连续 toolResult（`anthropic-messages.js:1160`），所以原样发送。用真实 Anthropic 调用（经记录请求体的网关，或把 `models.json` 的 baseUrl 指到本地转发），断言 HTTP 200、回答正常、`cache_control` 落在最后一条 user、相邻两次请求前缀逐字节一致；openai-completions 型号同测一次；记录实际 `messages` 形态 |
| S8（记忆） | 压缩后重新注入新快照 | 压缩后的下一轮请求中恰好出现一份新快照，旧快照只存在于摘要里；仅压缩后第一轮缓存失效 | 用 faux 型号设小 `contextWindow`（或手动 `conversation.compact()`）触发压缩；事件桥看到 `pi.compaction` 条目，宿主在下一次提交输入前追加新的 `amadeus.memory-snapshot`；对 fixture 请求体断言快照出现次数为 1；摘要里重复的旧快照内容记录体积，决定是否需要 `beforeCompact` 自带摘要 |
| S9（V6） | 汇报两次提交之间被杀的对账；`close()` 耗时上界 | 在 `submit` 与"记录 `delivered`"两次提交之间 SIGKILL，重启对账后 `delivered` 与遗留 run 一致且汇报只投一次；`checkpoint` 超时取值有依据 | worker 内用环境变量注入的断点在两次提交之间自杀；重启后按 `../architecture.md` §2.2 打开时序第 5 步对账：`submissionByRequest(report:<id>)` 已存在则补第二次提交；SQL 断言 `request_id = 'report:<id>'` 恰好 1 条；另测 `Harness.close()` 在真实 HTTP 请求在途（fixture 挂起）时的耗时 P95 与最大值（faux 流式中实测 73ms），据此定 `checkpoint` 的 30 秒超时是否合适 |
| S10 | `web_fetch` 防 DNS 重绑定 | 域名在校验之后改答案，请求仍只发往校验过的 IP；回环、内网、映射到这些段的 IPv6 被拒 | 拨号层只连登记过的地址并保留 `Host`；没登记的主机失败即关闭（不查 DNS）；经代理时代理拿到的是校验过的 IP 而不是域名，域名不会被解析两次；每一跳重定向各自固定到自己校验过的地址；没有代理变量时也先校验再连接（`test/durable-handoff-fetch.test.mjs`） |
| S11 | `pathGuard` 显式 deny 与悬空符号链接 | userData、`sessions`、记忆目录、agent 目录由宿主显式传入并优先于授权根；名字存在而目标不存在的符号链接，`read` / `write` / `edit` 都被拒绝，不会穿过链接创建真实目标 | 授权根内放一个指向授权根外尚不存在文件的符号链接，断言 `write` 被拒绝且目标未被创建；环境变量不设时显式 deny 仍生效（`test/durable-handoff-hands.test.mjs`） |
| S12 | 进程锁防 pid 复用 | 残锁里的 pid 已被无关进程复用时，新 worker 接管而不是等满 10 秒报错；真正存活的持有者仍然被尊重 | 用一个存活进程（父进程）的 pid 写一把 `startedAt` 远早于它启动时间的 `.lock`（模拟 pid 被复用），断言新 worker 接管；`startedAt` 晚于它的启动时间（真正的持有者）则等待，超时报 `held by process`（`test/durable-runtime.test.mjs`） |

### 4.3 原型之后

- 全部通过：在本文补充实测结果，按 `../architecture.md` §8 进入 A1 运行时切换。
- P2 或 P3 不通过：先调 `settings.progress`、`cacheRetention`；解决不了就按 `../architecture.md` §11 的退路继续使用 `pi-coding-agent`，存储与任务的实现方式按该节替换，话筒仲裁、委托分工、记忆策略不变。

---

## 5. 决定

全部汇总到 `../architecture.md` §12。本文相关：接受实验性依赖并锁版本（已定）；历史会话只读保留（已定）；记忆注入用自定义条目（已定）；一会话一个存储文件（已定，依据 §3.1 第一条）。待拍板：开库后对被中断的主回合先 `abort` 再恢复调度（建议采用，依据 §3.1 "`open` 不调度" 与 S1）。

---

## 附录 A：依据

行号对应 `@earendil-works/pi-durable` 1.1.0 的 `dist/`（2026-10-11 逐条复核）。

| 结论 | 来源 |
| :--- | :--- |
| 实验性、概念、示例清单、一个进程拥有一个存储、慢 watch 最多缓存 100 帧 | `README.md` |
| 14 个版本、1.1.0 的两处破坏性变更、`ToolExecutionApi.models` / `HookApi.models`、首条 system 位置修复、`contextRetentionMs` | `CHANGELOG.md`、`npm view @earendil-works/pi-durable time` |
| 依赖 pi-ai、chord、typebox、diff，不依赖 pi-coding-agent；`engines.node >=22.19.0`；npm 包不含示例 | `package.json`（`files: ["dist", "README.md", ...]`） |
| SQLite 后端：`node:sqlite`、WAL、`synchronous = NORMAL`、`busy_timeout` 5000、`close()` 时 `wal_checkpoint(TRUNCATE)`、`BEGIN IMMEDIATE` | `dist/storage/sqlite/node.js:6,113,140,154-162` |
| schema 版本比代码新则拒绝打开 | `dist/storage/sqlite/migrations.js`（`applySqliteMigrations`） |
| ID 由进程内 `nextId` 铸造，冲突在 `checkGlobalIds` 抛错 | `dist/storage/sqlite/storage.js:103-127,457-479` |
| `history: "latest"` 文档写 base / 退役时删旧修订 | `dist/storage/sqlite/storage.js:649-663` |
| 非 `StorageRejected` 的提交失败使 Session 中毒 | `dist/session/session.js:276,285,376-380` |
| `ContextEdit`：`omit` / `replace`；`EntryRecord` 的 `model` / `data` / `edits` 可同时缺省；`requestId` 对话内去重 | `dist/types.d.ts:262-289,313-318` |
| `Tx.appendEntry`、`Tx.createTask`、`Tx.latestHeadMarker`、`Tx.retireDoc`、`Tx.createSubmission`（裸接口，注释要求用 `Conversation.submit`）；**没有 delete** | `dist/types.d.ts:686-744`（`createSubmission` 在 716-720）、`Storage` 810-858 |
| `TaskRuntime` 继承 `DocumentObserver` / `DocumentReader`，有 `models`、`sleep(until)`、`signal` | `dist/types.d.ts:132-187`（`models` 146，`sleep` 186） |
| `TaskOptions.ownership` 必填，`background` 仅对话归属任务有效 | `dist/types.d.ts:229-239` |
| `SubmissionDraft` 一次一个；`write` 没有 `whenBusy` | `dist/harness/types.d.ts:15-27` |
| `ToolExecutionApi` 继承 `DocumentObserver`（`watchDoc`）与 `DocumentReader`；`HookApi` 只有 `taskId`、`conversationId`、`models`、`memo`、`snapshot`、`snapshotAsOf` | `dist/harness/types.d.ts:113,545-552` |
| `Conversation.abort()` 撤回排队输入、保留排队写入、后台子树存活 | `dist/harness/types.d.ts:59-66,490-494`、`scheduler.js:186-210`、`inbox.js`（`withdrawQueuedInputs`） |
| 空闲且 inbox 为空时输入直接 `placed` 带 `entry`；已知 `requestId` 先返回原提交；`reject` 抛 `ConversationBusy` | `dist/harness/submissions.js:117-170` |
| `open` 不调度，`resume()` 才启动；`close()` 给所有 invocation 发 abort 并 join | `dist/harness/scheduler.js:88-120,620-632`、`harness.js:210` |
| 缺失定义 / 版本过旧的任务阻塞 | `dist/harness/scheduler.js:742-747,1239`、`dist/harness/types.d.ts:431-435` |
| `leadWithSystem` | `dist/harness/context.js:113-123` |
| 范围内 edits 生效、同目标取最新 | `dist/harness/context.js:81-90` |
| 系统提示按 section 补丁追加 | `dist/harness/prompt.js`（`planSystemEntries`、`replaySections`） |
| 忙碌对话只有 Harness 在写（裸 commit 的前提） | `dist/harness/generation.js:28` |
| 第一个 partial 等满 `partialIntervalMs` 才提交；同时只有一个提交在途 | `dist/harness/generation.js:260-302` |
| partial 逐叶写入，只存追加量 | `dist/harness/json.js` |
| `watchEvents` 从提交派生；首个 partial 产生 `message_start`，后续产生 `message_update`；`text_delta` 来自 Chord 的 append 操作 | `dist/harness/events.js:111-116,242-278` |
| `run_end`、`submission` 事件；带 model 的自定义条目产生 `message_start` + `message_end` | `dist/harness/events.js:170-181,216,219` |
| 未投递批次上限 100，溢出替换为 `snapshot`；监听器抛错终止流 | `dist/session/observation.js:3,209,247`、`events.js:46` |
| 默认 `contextRetentionMs` 600000；`thinkingLevel` 缺省 `off`；任务归属的子对话复制归属者的 agent | `dist/harness/agent.js:32,49,114-121,178` |
| 阈值压缩仅在 `contextWindow > 0` 时 | `dist/harness/generation.js:214` |
| 工具输出默认 2000 行 / 50KB；工具中断消息 | `dist/truncate.js:10-11`、`dist/harness/tool.js:63,83` |
| Anthropic `cache_control` 位置、`cacheRetention`、`sessionId` 头 | `pi-ai/dist/api/anthropic-messages.js:22-40,422-423,787-789,859-908,1176-1196,1282` |
| 后续 system 消息原样发送 / 折叠的分支，默认 false | `pi-ai/dist/utils/transcript.js:96-102`、`anthropic-messages.js:147,378`、pi-ai README:1405,1601 |
| 各型号 `supportsMidConvoSystemMessages` | `pi-ai/dist/providers/data/anthropic.json` |
| `Usage` 字段含义 | `pi-ai/dist/types.d.ts:291-312` |
| `getSupportedThinkingLevels`、`Models.completeSimple` | `pi-ai/dist/models.d.ts:262,181` |
| `ModelRuntime implements Models` | `pi-coding-agent/dist/core/model-runtime.d.ts:36` |
| `pi-coding-agent` 的包导出只有根入口 | `pi-coding-agent/package.json` 的 `exports` |
| 后台子代理模式 | `test/examples/23-subagent-background.ts`（GitHub main，363 行） |
| Electron 44：Node 24.18.1、SQLite 3.53.1、WAL、FTS5 trigram | 附录 B 的命令 |
| Vite SSR 构建的显式 external 与默认外置 | `vite/main.config.mjs`；附录 B 的构建实测 |
| 现状：无 `session.delete`；崩溃不重放、替换失败旧进程可用 | `src/main/appRuntime.ts`、`test/pi-reload.test.mjs:49,53` |
| 现状：reload 对所有目标先发 `checkpoint`；没有 `requestSingleInstanceLock` | `src/main/appRuntime.ts:314`；`src/main` 全文无命中 |
| `NodeExecutionEnv` 对绝对路径放行、bash 继承 `process.env`、`prepare` 可改 `inheritEnv` | `dist/env/node.js:30-46,197-203,575,588`、`dist/tools/bash.js:23-33` |
| `Conversation.abort()` 先 `resume()` 再入队 abort 提交 | `dist/harness/harness.js:65-70` |
| 失败的助手消息作为条目追加后重试，发 `auto_retry_start` | `dist/harness/generation.js:373`、`dist/harness/events.js:128-134` |
| 没有 partial 的整条消息经 `message_start` + `message_end` 到达 | `dist/harness/events.js:173-181` |
| Anthropic 转换只合并连续 toolResult，不合并相邻 user 消息 | `pi-ai/dist/api/anthropic-messages.js:1160` |

## 附录 B：核实方法与实测记录

```bash
# 解包 npm 包
cd /tmp/pidurable && npm pack @earendil-works/pi-durable@1.1.0 && tar xzf earendil-works-pi-durable-1.1.0.tgz
# Electron 内检查 node:sqlite
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "const s=require('node:sqlite'); const db=new s.DatabaseSync(':memory:'); db.exec('PRAGMA journal_mode=WAL'); db.exec(\"CREATE VIRTUAL TABLE t USING fts5(b, tokenize='trigram')\"); console.log(process.versions.node, db.prepare('select sqlite_version() v').get().v)"
# 其余实测：在解包目录里放脚本，用同一个 electron 以 ELECTRON_RUN_AS_NODE=1 运行；
# 包内 import 自身（self-reference），依赖通过软链接指向仓库的 node_modules；模型用 pi-ai 的 faux provider
```

环境：macOS（Apple 芯片、本地 SSD），Electron 44.0.0（Node 24.18.1），脚本为一次性，原型阶段应改写成 `test/` 下的基准。数据为本机单次采样，用于量级判断，不是验收结果。

| 项目 | 结果 |
| :--- | :--- |
| 首个非空文本事件 − provider 侧首个非空文本（10 次，去掉预热） | `partialIntervalMs` = 100：中位数 101.8ms；= 30：32.7ms（最大 32.9ms） |
| 提交开销（30 回合，200 字回答） | 100ms 间隔 309 次提交，30ms 间隔 489 次；平均 0.5ms，最大 2.9ms；库 168KB |
| 大事务 | 10,000 条目（约 8MB）一次提交 108ms；2,000 条目 21ms |
| 提交到 provider 调用的本地开销 | 200 / 2,000 / 10,000 条目：冷读 4 / 10 / 32ms，热读约 1ms；`contextRetentionMs: 0` 时每次都是冷读 |
| 30 个空闲库（`resume()` + 事件流） | +9MB RSS，+90 fd，每个打开约 2ms、关闭约 1ms，无 `-wal` / `-shm` 残留 |
| 流式中 `close()` | 73ms；重开后调度处于 paused；`resume()` 后记录为 `pi.user, pi.assistant(aborted), pi.assistant(stop)` |
| 重开后 `abort()` | 4ms，零模型请求，提交 `unanswered / aborted`，下一轮正常 |
| `requestId` | 忙时重复提交返回同一提交；重开后仍去重；`unanswered` 后重复提交仍返回原失败提交；忙 + `reject` 抛 `ConversationBusy` |
| 双进程开同一个库 | 第二个进程打开成功并接管在途任务；第一个进程在约 2 秒后报 `ID 10 already belongs to submission`，Harness 中毒 |
| RSS（仅 import） | 基线 55MB；`pi-coding-agent` +76MB；durable 根入口单独 +29MB；两者同进程 durable 只多 +4MB |
| Vite 8 SSR 构建 | 包在 `node_modules` 内时 pi-durable、pi-ai 保持 import 外置；用软链接放置则被打进包（275KB），所以打包前要用真实安装验证 |
