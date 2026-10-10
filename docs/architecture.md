# Amadeus Next 架构 v2

> 综合 `long-term-memory.md` v5（记忆）、`pi-tool-constraints.md` v2（工具与委托）、`pi-durable-evaluation.md`（运行时）三份文档后的整体架构。三份文档已与本文同步；本文定分工与边界，细节以各自文档为准。
> 前提：pi-durable 原型（评估文档 §4）通过。若不通过，见 §10 的退路。

---

## 0. 一句话

**红莉栖是前台，durable 是账本，子代理是后台。** 主进程负责“谁在说话”；`pi-worker` 里的 pi-durable Harness 是对话、任务、记忆注入的唯一事实来源；红莉栖只聊天、记事、委托，真正干活的是子代理。

### 设计原则

| # | 原则 | 来源 |
| :--- | :--- | :--- |
| 1 | **语音优先**：主对话的每个设计都以首包延迟为约束，重活一律移出主回合 | 工具约束 §0 |
| 2 | **委托为主**：红莉栖不带内置工具，读文件、跑命令、查资料都交给子代理 | 工具约束 §0、主人要求 |
| 3 | **单一事实来源**：对话记录、任务状态、注入记录只存在 durable 存储里；核心记忆只存在 Markdown 里；其余都是派生数据 | 记忆 §2、评估 §2 |
| 4 | **人确认为主干**：只有人确认过的记忆才自动注入；自动系统只负责提议 | 记忆 §0 |
| 5 | **只追加**：会话内 system、tools 不变，上下文只追加，保证缓存前缀稳定 | 记忆 §4 |
| 6 | **外来文本是数据**：记忆、子代理结果、网页内容进入上下文时都带围栏和系统注，不当作指令 | 记忆 §3.1、工具约束 §3.3 |
| 7 | **主进程掌握话筒**：只有主进程知道主人是否在说话、语音是否在播放；agent 层不决定何时开口 | 新增，见 §4 |

---

## 1. 进程与模块

```text
┌──────────────────────── 渲染进程 ────────────────────────┐
│ NextApp：对话界面、任务卡片、设置页（含长期记忆、待确认）   │
│ Scene：E-mote 角色、口型、表情                             │
└───────────────▲──────────────────────────────┬───────────┘
                │ IPC（chat.* / voice.* / task.* / memory.*）
┌───────────────┴──────────────────────────────▼───────────┐
│ 主进程 AppRuntime                                          │
│  ├─ 话筒仲裁 Floor（§4）：用户回合 / 汇报回合 / 监听 / 播放 │
│  ├─ 呈现管线：PresentationText → 字幕 + FishTts + 表情     │
│  ├─ SpeechBridge（ASR）、Jev 表情本能层                     │
│  └─ PiHost：pi-worker 的命令与事件通道                     │
└───────────────▲──────────────────────────────┬───────────┘
                │ utilityProcess 端口消息                     
┌───────────────┴──────────────────────────────▼───────────┐
│ pi-worker（唯一持有存储的进程）                            │
│  Harness（pi-durable）                                     │
│   ├─ 存储：<userData>/pi-durable.sqlite                    │
│   ├─ models：现有 ModelRuntime                             │
│   ├─ registry：amadeus-role / memory / handoff / 子代理扩展 │
│   └─ env：按对话 cwd 构造的 NodeExecutionEnv               │
│  MemoryStore：<userData>/memory/core/*.md + index.sqlite3  │
│  事件桥：watchEvents → 端口消息（清洗记忆与结果标签）       │
└───────────────────────────────────────────────────────────┘
```

| 模块 | 职责 | 现状 → 目标 |
| :--- | :--- | :--- |
| `AppRuntime` | 回合生命周期、话筒仲裁、设置 | 增加“汇报回合”与 Floor；不再维护对话文本 |
| `SessionStore` | 会话列表与消息 | **退役**。会话列表与记录改由 durable 视图派生；标题存在 conversation 级文档里 |
| `PiHost` | worker 通道 | 保留；新增长连接事件订阅（不只在 `prompt` 期间） |
| `pi-worker` | Pi 运行时 | `createAgentSession` → `Harness`；新增扩展与事件桥 |
| `piSessions.ts` | Pi jsonl 会话 | 旧会话只读（待拍板，见 §11） |
| `role.ts` | 角色 prompt | `composePrompt` 不变，挂到 `amadeus-role` 扩展的 section 上 |
| `jev.ts` | Jev 客户端 | 主进程用于表情本能层；worker 用于记忆门控与召回（M2/M3） |

---

## 2. 存储

| 存储 | 位置 | 内容 | 谁写 | 性质 |
| :--- | :--- | :--- | :--- | :--- |
| durable 存储 | `<userData>/pi-durable.sqlite` | 所有对话（主会话与子代理）、条目、任务、收件箱、用量；应用文档（会话标题、汇报信箱、记忆基线、子代理登记表） | 仅 pi-worker | **事实来源** |
| 核心记忆 | `<userData>/memory/core/*.md` | 一条记忆一个文件（记忆文档 §2.2） | pi-worker 的 MemoryStore；主人也可以直接用编辑器改 | **事实来源** |
| 记忆索引 | `<userData>/memory/index.sqlite3` | FTS、拒绝列表、审计 | MemoryStore | 派生，可重建 |
| 情景日记 | `<userData>/memory/journal/*.md` | M3 | 后台任务 | 事实来源 |
| 子代理工作目录 | `<userData>/handoff/<task_id>/` | 子代理的文件产出 | 子代理 | 临时 |
| 设置 | 现有 settings 文件 | 配置与加密密钥 | 主进程 | 不变 |

相比三份文档的原设计，删掉的东西：
- 记忆文档的 `injections` 表和 `session_baseline` 表：注入内容作为 durable 条目持久化，基线改为 conversation 级文档。
- 工具约束文档的任务表与调度器：由 durable 的任务和任务树代替。
- `SessionStore` 与 Pi jsonl 两份对话记录并存的情况。

为什么核心记忆不放进 durable：记忆要求主人能直接编辑、能看懂、能备份，Markdown 更合适；它也是跨会话的全局数据，不属于某个对话。

---

## 3. Agent 层

### 3.1 扩展清单

| 扩展 | 内容 | 主对话 | 子代理 |
| :--- | :--- | :--- | :--- |
| `amadeus-role` | section：ROLE + PRESENTATION + protocol | ✓ | ✗ |
| `amadeus-memory` | 工具 `remember` / `forget`；任务定义 `amadeus.memory-extract`（M2） | ✓ | ✗ |
| `amadeus-handoff` | 工具 `handoff`（可选 `handoff_cancel`）；任务定义 Anchor、Reporter | ✓ | ✗（禁止递归） |
| `amadeus-research` | 只读 web 搜索 / 抓取工具 | ✗ | `research` |
| `amadeus-files` | 受限的 `read`（只允许主人授权的路径） | ✗ | `files` |
| `amadeus-task` | `CodingTools`（read / bash / edit / write），经 `wrapTool` 包装为逐次确认 | ✗ | `task` |

- Harness 的 `settings.extensions` 默认选择为空；每个对话通过 `configure()` 显式选择扩展，不依赖“默认全选”。
- 主对话固定为 `[amadeus-role, amadeus-memory, amadeus-handoff]`，会话内不变。
- 工具用法写在工具的 `description` 里，静态 prompt 不点名任何工具（工具约束 §2.2）。
- **hook 不能提交事务**（`HookApi` 没有 `commit`）。所以凡是要写入的逻辑都不放在 hook 里：
  - 记忆条目由 worker 宿主代码在提交输入前写入（记忆 §4.1）；
  - 回合后抽取任务由宿主代码在 run 结束后提交（记忆 §5.2）；
  - 写操作确认放在 `wrapTool` 包装后的 `execute` 里（工具约束 §4.3）。

### 3.2 主对话

```text
system   amadeus-role section                                 全局不变
tools    remember / forget / handoff                          会话内不变
entry    amadeus.memory-snapshot（model: 快照）                 会话首轮写入
entry    pi.user / pi.assistant ...
entry    amadeus.memory-update（model: 增量）                   核心记忆变化时写入
entry    pi.user（汇报回合：<amadeus_handoff_result>）          子代理结果
...
```

- 模型、thinking 级别沿用现在的全局选择，通过 `configure({ model, thinkingLevel })` 下发。
- 记忆注入使用自定义条目（评估文档 §2.2，待拍板）；重新冻结时用 `edits` 覆盖旧快照、隐藏旧增量。
- 压缩使用 durable 内置的自动压缩；压缩完成后的下一轮重新写入快照。

### 3.3 子代理

| 项 | 约束 |
| :--- | :--- |
| 创建 | `handoff` 在一个 commit 内创建后台 Anchor 任务和归属它的子对话，再创建 Reporter |
| 配置 | `configure({ extensions: [<kind 扩展>, ...], instructions: <kind 说明>, cwd: <任务目录>, model })` |
| 上下文 | 只看到 `brief`；不注入核心记忆，不继承主对话历史 |
| 生命周期 | 后台任务：主人按停止不影响它；`handoff_cancel` 或任务卡片上取消时，对子对话调用 `abort()` |
| 资源 | 超时默认 5 分钟；全局并发默认 2；工具调用中途崩溃时，只有声明 `replay: "safe"` 的工具会重跑 |
| 结果 | Reporter 不直接提交给主对话，而是写入**汇报信箱**，由主进程决定何时投递（§4.3） |

---

## 4. 回合与话筒

### 4.1 为什么需要话筒仲裁

现在只有用户能发起回合，语音是半双工：回合进行中停止 ASR，播放完 1 秒后恢复监听。引入委托后多了一个回合来源，也就是子代理的结果汇报。durable 的 followUp 只知道对话忙不忙，不知道主人正在说话、语音还在播放。所以**何时开口必须由主进程决定**。

### 4.2 状态

```text
            ┌──────────── 用户说完 / 发送文本 ────────────┐
            ▼                                             │
 idle ──► listening ──► user-speaking ──► (user turn) ────┤
  ▲          ▲                                            │
  │          └──── 播放结束 + 1s ◄── speaking ◄── thinking ◄┘
  │                                       ▲
  └── 有待投递汇报，且话筒空闲 ──► (report turn) ──┘
```

| 回合类型 | 触发 | 写入 durable | 打断规则 |
| :--- | :--- | :--- | :--- |
| 用户回合 | ASR 最终结果、文本发送 | `submit({ type: "input" })` | 打断进行中的任何回合（沿用现有 `cancelTurn`） |
| 汇报回合 | 汇报信箱非空且话筒空闲 | `submit({ type: "input", requestId: 汇报 id })` | 可以被用户回合打断；被打断的汇报不重投，红莉栖在下一个回合里自然提及 |

“话筒空闲”：没有 `activeTurn`，ASR 不在识别中，没有待恢复的监听延迟，也没有在重载。

### 4.3 汇报信箱

```text
子代理完成
 └─ Reporter（durable 后台任务）在一个 commit 内：
     ├─ 把结果写进主对话的 app.outbox 文档（id、task_id、摘要、状态）
     └─ 结束任务
pi-worker 事件桥
 └─ outbox 变化 → 通知主进程 task.report-ready
主进程 Floor
 └─ 话筒空闲时 → worker 命令 report.deliver { id }
     └─ worker：submit 汇报输入（requestId = id，幂等）并从 outbox 移除
         └─ 流式事件走与用户回合相同的呈现管线
```

- durable 保证汇报不丢、不重复（requestId 幂等）；主进程只负责时机。
- 应用重启后，outbox 里的汇报仍在，话筒空闲时照常投递。
- 是否主动开口（还是等主人下次说话时一起说）是一个设置项，见 §11。

### 4.4 呈现管线

用户回合和汇报回合共用同一条管线：

```text
watchEvents（worker） ─ text_delta ─► 清洗器（scrub 记忆和结果标签）─► 端口消息
主进程 ─► PresentationText ─► 字幕（chat.token）+ FishTts + 表情
```

- 事件桥在 worker 内长期订阅主对话，按 durable 的 run 对应到主进程的 `TurnKey`，不再只在 `prompt` 命令期间订阅。
- 界面的对话记录来自 durable 视图，只显示 `pi.user` / `pi.assistant` 的文本；`amadeus.*` 条目和汇报输入按 kind 过滤，或者渲染成卡片。

---

## 5. 记忆

在记忆文档的基础上，按新架构调整如下：

| 项 | 决定 |
| :--- | :--- |
| 默认开关 | **默认开启**（已定） |
| 注入范围 | **只注入 `reviewed`**（已定） |
| 快照预算 | **3KB**（已定） |
| 明确指示（“记住 / 忘掉”） | **运行时工具** `remember` / `forget`，写成 `reviewed`；`source_quote` 必填；工具做成幂等，声明 `replay: "safe"` |
| 自动提议（M2） | durable 后台任务，回合结束后触发，写成 `unreviewed`；通过 `api.models` 使用当前对话模型 |
| 注入方式 | 自定义条目 + `edits` 重新冻结（待原型验证） |
| 重放、基线 | 由 durable 条目和 conversation 级文档承担，删除 `injections` / `session_baseline` 表 |
| 设置页编辑 | 主进程 → worker 的 `memory.*` 命令 → MemoryStore；进行中的会话下一轮写入增量条目 |
| 读取 | 只靠注入，不提供读取类工具 |

记忆文档 §3.1 的“回合中不调用任何记忆工具”改为：**回合中只允许调用写入类工具 `remember` / `forget`，不提供读取类工具。**

---

## 6. 安全边界

| 层 | 措施 |
| :--- | :--- |
| 主对话 | 没有内置工具；只有三个自定义工具，都在执行端校验 |
| 子代理 | 显式选择扩展；`cwd` 指向任务私有目录；`task` 类型的写入与执行逐次确认（`wrapTool` + `app.approvals`） |
| 外部配置 | Registry 是进程内对象，不读取 `~/.pi/agent` 下的扩展、MCP、AGENTS.md |
| 注入内容 | 记忆、子代理结果、网页内容都带围栏和系统注；写入记忆前做投毒和敏感信息扫描 |
| 输出 | 事件桥的清洗器拦截所有 `amadeus_*` 标签，不让它们进入字幕和 TTS |
| 存储 | durable 存储只由 pi-worker 打开；主进程只通过命令访问 |

---

## 7. 主进程与 worker 的接口

| 方向 | 消息 | 用途 |
| :--- | :--- | :--- |
| 主 → worker | `chat.submit { sessionId, text, turnId }` | 用户回合 |
| 主 → worker | `chat.abort { sessionId }` | 打断（不影响后台子代理） |
| 主 → worker | `report.deliver { id }` | 投递一条汇报 |
| 主 → worker | `task.cancel { taskId }` | 取消子代理 |
| 主 → worker | `task.approve { callId, allow }` | `task` 类型的写入 / 执行确认 |
| 主 → worker | `session.list / create / load / rename / delete` | 会话管理（取代 SessionStore） |
| 主 → worker | `memory.list / write / delete / accept / reject / clear / status` | 记忆管理 |
| 主 → worker | `model.list / set`、`reload`、`checkpoint` | 沿用 |
| worker → 主 | `turn.text / turn.tool / turn.done / turn.error` | 流式回合事件（用户与汇报回合共用） |
| worker → 主 | `task.graph` | 任务卡片数据 |
| worker → 主 | `task.report-ready { id }` | 汇报信箱有新内容 |
| worker → 主 | `task.approval-request { callId, summary }` | 请求主人确认 |
| worker → 主 | `memory.changed` | 记忆变化，刷新设置页 |

---

## 8. 里程碑

| 阶段 | 内容 | 依赖 | 对应原文档 |
| :--- | :--- | :--- | :--- |
| **P0 原型** | durable + 现有 ModelRuntime + `amadeus-role` + 最小 handoff + 最小快照条目，跑评估文档的 P1~P8 | 无 | 评估 §4 |
| **A1 运行时切换** | `pi-worker` 改用 Harness；事件桥；会话管理迁到 worker，`SessionStore` 退役；旧会话只读 | P0 | 评估 §3 |
| **A2 话筒与委托** | Floor 状态机、汇报信箱、汇报回合、任务卡片；`research` 子代理 | A1 | 工具约束 §3、§4；本文 §4 |
| **A3 记忆 M1** | MemoryStore、快照与增量条目、`remember` / `forget`、设置页核心记忆 | A1 | 记忆 M1 |
| **A4 记忆 M2** | 后台抽取任务、待确认列表、拒绝记忆 | A3 | 记忆 M2 |
| **A5 动手类子代理** | `files`、`task` 类型；确认界面与 `wrapTool` 确认 | A2 | 工具约束 §4.2、§4.3 |
| **A6 记忆 M3** | 情景日记与保守召回 | A4 | 记忆 M3 |

A2 和 A3 可以并行。

### 关键验收（贯穿各阶段）

1. 主对话请求的 tools 只有 `remember` / `forget` / `handoff`，会话内逐字节不变。
2. 真实 Anthropic 模型连续 20 轮，第 2 轮起 `cacheRead / input ≥ 80%`。
3. 首包延迟相比现状的中位数差距 ≤ 100ms。
4. 委托后主人继续聊天不受阻塞；子代理完成后，红莉栖在主人没说话、语音也没在播放时才开口汇报。
5. worker 在子代理运行中被杀掉，重启后汇报仍然送达且只送达一次。
6. 字幕、TTS、界面记录中搜不到任何 `amadeus_*` 标签。

---

## 9. 文档地图

| 文档 | 版本 | 负责 | 与本文的关系 |
| :--- | :--- | :--- | :--- |
| `architecture.md` | v2 | 进程分工、存储、话筒仲裁、接口、里程碑、待拍板汇总 | — |
| `long-term-memory.md` | v5 | 记忆分层、证据契约、注入与缓存契约、记忆工具、抽取、召回 | 实现本文 §5 |
| `pi-tool-constraints.md` | v2 | 主对话与子代理的工具集、工具定义规则、handoff 生命周期、写操作确认 | 实现本文 §3、§4.3 |
| `pi-durable-evaluation.md` | — | 运行时评估、迁移代价、P0 原型验收 | 本文的前提 |

- 两份设计文档的上一版（v4 / v1，基于 `pi-coding-agent`）保留在 git 历史中，作为 §10 退路的实现参考。
- 原型结束后：评估文档补实测结果；设计文档按实测修正（重点是 `edits` 语义、首包延迟、缓存命中率）。

---

## 10. 退路

如果 P0 原型的首包延迟或缓存指标不达标，并且无法通过配置解决：
- 继续使用 `pi-coding-agent`，按 `pi-tool-constraints.md` 和 `long-term-memory.md` 的原设计实现；
- 本文 §4 的话筒仲裁与汇报信箱照样适用，只是把汇报信箱换成 worker 内自建的 SQLite 表，投递改用 `sendCustomMessage`；
- §1、§3.1、§5、§6 的分工不变。

也就是说，**话筒仲裁、委托分工、记忆策略与运行时选型无关**，只有存储与任务的实现方式取决于原型结论。

---

## 11. 需要主人拍板（汇总）

已拍板：记忆默认开启；只注入 `reviewed`；快照 3KB；委托为主要工作方式。

| # | 问题 | 推荐 | 来源 |
| :--- | :--- | :--- | :--- |
| 1 | 是否接受 pi-durable 的实验性依赖（锁定精确版本） | 接受 | 评估 §5 |
| 2 | 历史会话：迁移，还是只读保留 | 只读保留 | 评估 §5 |
| 3 | 记忆注入：自定义条目，还是 `beforeRequest` | 自定义条目 | 评估 §5 |
| 4 | 子代理完成后：话筒空闲时主动汇报，还是等主人下次开口 | 主动汇报，可在设置中关闭 | 工具约束 §6、本文 §4.3 |
| 5 | 子代理模型：沿用对话模型，还是按类型配置 | 沿用 | 工具约束 §6 |
| 6 | 第一版子代理类型 | 只做 `research` | 工具约束 §6 |
| 7 | 是否加 `handoff_cancel` 工具 | 加，语音取消更自然 | 工具约束 §6 |
| 8 | 是否开启 `cacheRetention: "long"` | 开启，陪伴对话常有超过 5 分钟的停顿 | 记忆 §10 |
| 9 | 被用户打断的汇报：不重投、由红莉栖自然提及，还是重新排队 | 不重投 | 本文 §4.2 |
