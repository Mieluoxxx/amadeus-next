# Amadeus Next 架构 v3

> 综合 `long-term-memory.md` v6（记忆）、`pi-tool-constraints.md` v3（工具与委托）、`archive/pi-durable-evaluation.md` 2026-10-11 核实版（运行时）三份文档后的整体架构。三份文档已与本文同步；本文定分工与边界，细节以各自文档为准。
> v3 变更：依据对 pi-durable 1.1.0 真实包与 Electron 44 的核实，改为**一会话一个存储文件**（durable 没有删除 API）；汇报回合按 `requestId` 识别；流式节流参数与首包预算；worker 重启时序；角色热更新的语义变化；原型验收从 8 条扩到 12 条；记录与现状的行为差异。
> 定稿补全：话筒仲裁重写（区分 `armed` / `hearing`，转移表，worker 重启时序）；§7 补全封包、载荷、错误码、命令分道；§2.2 补全 SessionHost 的打开 / 回收 / 删除 / 崩溃恢复；§1 模块表按真实代码校正；§11 退路改为自包含（git 历史里没有 pi-coding-agent 版设计）。
> 跨文档同步：`app.approvals` 挂子对话、确认按 `taskId` + `approvalId`、`task.approval-request`（带 `approvalId`、`detail`、`expiresAt`）/ `task.approval-resolved` 两条事件；汇报只有 `speak` 一种投递，取消不生成汇报、只更新卡片；`delivered` 带 `taskId`，`entryId` 可先为空再由对账补齐；`report.deliver` 遇 `busy` 重试 1 秒 × 5 次再等 `pump()`；并发按会话计；执行环境不是沙箱（路径守卫、环境清理）；记忆开关走命令；`rejections` / `audit` 不可重建；角色热更新的追加语义随模型而变；崩溃后先 `abort` 再 `resume`；单进程独占靠应用层锁，不靠 `busy_timeout`；第一版已定默认值见 §12。
> 实现同步：P0 与 A1~A6 已实现，pi-durable 是唯一运行时，旧运行时代码已删，旧会话只读。**本文与代码不一致处以代码为准**，已按 `src/main/{floor,appRuntime,piHost,index}.ts` 与 `src/main/durable/*` 校正：打开时序先对账、再中止遗留 run、再 `resume`；`hasActive` 在 `chat.submit` 受理前预置；`checkpoint` 的 5 秒宽限与 `turn.error{code:"closed"}`；`report.deliver` 先判 `already` / `missing` 再判 `busy`；Floor 的 pump 顺序、`busy` 重试后搁置；设置项（`report_proactive`、`web_search_*`、`memory_*`）。首包延迟与缓存命中率（验收 2、3）仍待真实模型实测。
> 实现同步（handoff v2 与审查修复）：主对话工具集是六个（`remember`、`forget`、`handoff`、`handoff_send`、`handoff_status`、`handoff_cancel`），任务可续接（轮次）、可查询、可提问（`needs_input`），子代理有 `report_progress`，另有委托专用模型（设置项 `delegation_model`，环境变量 `AMADEUS_DELEGATION_MODEL`）；`task.graph`、`task.report-ready`、`session.load` 的卡片都带 `round`、`progress`、`question`（§7）；打开会话时为每个被作废的确认补发 `task.approval-resolved { state: "expired" }`；Floor 对 `deferred` 的汇报做退避，回合有 120 秒看门狗（§4.2）；安全边界补了确认卡完整展示、`web_fetch` 固定 IP、`pathGuard` 显式 deny 与悬空链接、进程锁防 pid 复用、`remember` 的引用下限与汇报回合禁用（§6）。
> 前提（原型阶段）：pi-durable 原型（评估 §4）通过。若不通过，见 §11 的退路。

---

## 0. 一句话

**红莉栖是前台，durable 是账本，子代理是后台。** 主进程负责"谁在说话"；`pi-worker` 里每个会话一个 pi-durable Harness，是该会话的对话、任务、记忆注入的唯一事实来源；红莉栖只聊天、记事、委托，真正干活的是子代理。

### 设计原则

| # | 原则 | 来源 |
| :--- | :--- | :--- |
| 1 | **语音优先**：主对话的每个设计都以首包延迟为约束，重活一律移出主回合 | 工具约束 §0 |
| 2 | **委托为主**：红莉栖不带内置工具，读文件、跑命令、查资料都交给子代理 | 工具约束 §0、主人要求 |
| 3 | **单一事实来源**：对话记录、任务状态、注入记录只存在该会话的 durable 存储里；核心记忆只存在 Markdown 里；索引与全文检索是派生数据，可重建。**例外**：记忆库里的 `rejections`、`audit` 是账本，不可重建，要随 `memory/` 一起备份 | 记忆 §2、评估 §2 |
| 4 | **人确认为主干**：只有人确认过的记忆才自动注入；自动系统只负责提议 | 记忆 §0 |
| 5 | **只追加**：会话内 system、tools 不变，上下文只追加，保证缓存前缀稳定 | 记忆 §4 |
| 6 | **外来文本是数据**：记忆、子代理结果、网页内容进入上下文时都带围栏和系统注，不当作指令 | 记忆 §3.1、工具约束 §3.3 |
| 7 | **主进程掌握话筒**：只有主进程知道主人是否在说话、语音是否在播放；agent 层不决定何时开口 | 本文 §4 |
| 8 | **一会话一库**：durable 的记录不可删除，所以每个会话一个存储文件，删除会话就是删文件 | 评估 §0、§3.1 |
| 9 | **重启靠对账**：跨两次提交的动作（先提交输入、再标记已投递；先置索引标记、再建任务）都必须能在重启后重复执行而不出错 | 本文 §2.2、§4.3 |

---

## 1. 进程与模块

```text
┌──────────────────────── 渲染进程 ────────────────────────┐
│ NextApp / ScenePage：对话界面、任务卡片、设置页（含长期记忆、待确认）│
│ Scene：E-mote 角色、口型、表情、音频播放                     │
└───────────────▲──────────────────────────────┬───────────┘
                │ next.request（invoke）/ next.event（push）
                │ 方法名即命名空间：chat.* session.* asr.* voice.* pi.* task.* memory.* runtime.*
┌───────────────┴──────────────────────────────▼───────────┐
│ 主进程 AppRuntime                                          │
│  ├─ Floor 话筒仲裁（§4）：由回合 / ASR / 重载标志推导状态      │
│  ├─ 呈现管线：PresentationText → 字幕 + FishTts + 表情     │
│  ├─ SpeechBridge（Apple Speech helper）                    │
│  ├─ LegacySessions：只读旧会话（amadeus-next-sessions.json）│
│  └─ PiHost：worker 命令通道 + 事件订阅 + 自动重拉           │
└───────────────▲──────────────────────────────┬───────────┘
                │ utilityProcess 端口消息（§7）                
┌───────────────┴──────────────────────────────▼───────────┐
│ pi-worker（唯一打开 durable 存储的进程）                   │
│  命令分道（§7.1）                                          │
│  SessionHost：按会话打开 / 关闭 Harness，维护 sessions/index.json │
│   └─ Harness × N（每个打开的会话一个）                      │
│       ├─ 存储：<userData>/sessions/<id>/durable.sqlite       │
│       ├─ models：进程内共享的 ModelRuntime                   │
│       ├─ registry：进程内共享，amadeus-role / memory / handoff / 子代理扩展 │
│       └─ env：按对话 cwd 构造的 NodeExecutionEnv             │
│  MemoryStore：<userData>/memory/core/*.md + index.sqlite3  │
│  事件桥：watchEvents + watchDoc → 端口消息（清洗标签、标 kind）│
└───────────────────────────────────────────────────────────┘
```

下表"迁移前"是 `45ffaa3` 时的状态，"已实现"是当前代码。

| 模块 | 迁移前 | 已实现 |
| :--- | :--- | :--- |
| `AppRuntime`（`appRuntime.ts`） | 单个 `activeTurn`（`piDone` / `drained` / `speech`）；`listeningEnabled`、`listeningResumeAt`；`runChat` 调 `PiHost.prompt`；会话来自 `SessionStore`；渲染方法 `session.list / create / load`、`chat.send / abort`、`asr.start / stop`、`voice.playback`、`pi.models / pi.model.set`、`runtime.reload` | `activeTurn` 带 `kind`（`user` / `report`）、`parser`（`PresentationText`）；回合经 `chat.submit` 加 `turn.*` 事件（`onPiEvent` → `onTurnEvent`）；会话操作转发给 worker，并缓存 `workerSessions`、待确认数；汇报回合（`deliverReport`）；设置项 `report_proactive`、`delegation_model`、`web_search_*`、`memory_*`；回合看门狗（120 秒，§4.2）；`worker.ready` / `worker.down` 时作废缓存里的未决确认并发 `expired`（§7.3）；渲染方法映射见 §7.5 |
| `Floor`（`floor.ts`） | 无 | **纯决策器**：不碰呈现、TTS 与 worker 通信，宿主通过 `FloorHost`（`gates()`、`turn()`、`speechStart/Stop/Finish`、`deliver`、`flushReload`）注入；时钟走 `deps.clock`，状态由 `turn()` 与自己的 `asrOn` / `hearing` 推导，不另存一份。`test/floor.test.mjs` 用假时钟覆盖 |
| `SessionStore`（`sessionStore.ts`） | `StoredSession { id, title, messages[] }` 加 `currentId`；经 `RuntimeDeps.store` 注入 | **只读**：没有任何消息的旧会话不列出，其余在列表里以 `readonly: true` 单独成组，可看不可续；`currentId` 不再写入 |
| `PiHost`（`piHost.ts`） | `prompt()` / `abort()` / `request()` / `restart()`；文本与工具事件只在 `prompt` 的回调里；worker 意外退出后不会自己重拉，要等下一条命令触发 `ensureStarted()` | 只有 `request(command, params)`（`prompt` / `abort` 并入；`abort` 在没有进程时不拉起 worker）、`restart()`、`dispose()`；构造函数多一个 `onEvent`；命令封包 `{ id, command, params }`；`PiError` 保留 `code`；合成 `worker.ready` / `worker.down` 与 `turn.error(worker_exit)`；自动重拉（§2.2）。`restart()`：`checkpoint` → 拉起 → 杀旧；替换失败对旧 worker 发 `resume`；`checkpoint` 失败则杀旧进程并等它 `exit`（最多 10 秒）再拉起 |
| `pi-worker`（`pi-worker.ts`） | `createAgentSession` 按会话缓存；`stopping` / `epochs` 旁路 abort；命令 `prompt` / `abort` / `checkpoint` / `reload` / `models` / `set-model` | 入口 `pi-worker.ts` 只有 11 行，转给 `durable/worker.ts`（建 `ModelRuntime`、`DurableRuntime`，先取进程锁再发 `ready`，`ready` 之后后台 `warm()`）。命令、分道、`stopping` / `epochs` 在 `durable/runtime.ts`；`checkpoint` 关闭全部 Harness 并拒绝后续命令（`resume` 除外） |
| `piSessions.ts`、旧 worker（`piLegacyWorker.ts`） | Pi jsonl 会话；`createAgentSession` 运行时 | **已删除**；退路见 §11 |
| `role.ts`（`composePrompt`、`ensurePromptFiles`） | 每次 `systemPromptOverride` 读 `ROLE.md`、`PRESENTATION.md` | `composePrompt` 不变，由 `durable/role.ts` 的 `amadeus-role` 扩展挂成 section，每次请求渲染 |
| `jev.ts` | `jevConfig(env)`、`systemOne()`；`piEnv()` 已把 Jev 三项下发给 worker；**没有调用方** | M3 召回在 worker 内调用。表情本能层（`jev-emote-integration.md`）仍是设计，尚无实现 |
| `SpeechBridge`、`FishTts`、`SceneHost` | — | 不变 |

worker 侧的实际模块划分（Vite 把这些本地模块打进 `pi-worker.js`）：

```text
src/main/
├── pi-worker.ts            # 入口（11 行）：取 parentPort，转给 durable/worker.ts
├── floor.ts                # 主进程侧：话筒仲裁（纯决策器）
└── durable/
    ├── worker.ts           # ModelRuntime、DurableRuntime 的装配；先取进程锁再发 ready；ready 之后 warm()
    ├── runtime.ts          # DurableRuntime：命令入口 handle()、分道、epoch / stopping、全部命令、checkpoint / resume
    ├── lanes.ts            # Lane / KeyedLanes / CommandError
    ├── sessionHost.ts      # 一会话一 Harness 的打开 / 关闭 / 删除 / 回收 / 中毒恢复 / 扫描重建
    ├── sessionIndex.ts     # sessions/index.json 的原子读写；SessionDoc（app.session）
    ├── processLock.ts      # sessions/.lock
    ├── eventBridge.ts      # watchEvents → turn.* 事件；requestId → turn 映射
    ├── scrub.ts            # TagScrubber：流式剔除 <amadeus_*> 标签
    ├── history.ts          # entries() → 界面消息（PresentationText 取 display）；cardOf
    ├── modelSelection.ts   # ~/.amadeus/pi/settings.json 三键的读写；thinkingLevels
    ├── role.ts             # amadeus-role 扩展
    ├── handoff/            # amadeus-handoff（extension.ts：handoff / handoff_send / handoff_status / handoff_cancel）与 research / files / task 三类子代理扩展；docs.ts（文档类型）；reporter.ts + rounds.ts + settle.ts（Reporter、轮次、终态写入）；deliver.ts（deliverReport、reconcileHandoffs）；control.ts（cancel / approve / watchApprovals、expireApprovalsOnOpen、summaryOf）；status.ts、progress.ts（handoff_status 与 report_progress）；delegation.ts（委托模型）；pathGuard.ts、fetchGuard.ts（路径守卫、web_fetch 固定 IP）；fence.ts（汇报围栏）
    ├── memory/             # MemoryStore、service、extract、recall 等（见 long-term-memory.md §8）
    └── search/             # web_search 后端：brave.ts、tavily.ts
```

构建与依赖（评估 §3 实测）：
- Vite 的 SSR 构建默认把 `node_modules` 里的依赖外置，pi-durable、pi-ai 均保持 `import`，所以**没有改** `vite/main.config.mjs` 的 `external`；但 electron-builder 要把它们带进包（P12）。
- `package.json` 已增加 `@earendil-works/pi-durable` `1.1.0`（精确版本），`pi-ai`、`chord` 同为 `1.1.0` 的直接依赖。`pi-coding-agent` 仍保留：`ModelRuntime`、`getAgentDir` 只从它的根入口导出。

---

## 2. 存储

```text
<userData>/                                 # app.getPath('userData')
├── sessions/
│   ├── index.json                          # 派生缓存，见下；缺失或损坏时重建
│   ├── .lock                               # worker 进程锁（pid + 启动时间），见 §2.2
│   ├── .trash/<id>-<时间戳>/               # 删除中的会话目录；启动时清空
│   └── <session_id>/                       # id 须匹配 ^[A-Za-z0-9_-]{1,128}$
│       ├── durable.sqlite（+ -wal / -shm） # 该会话的 Harness 存储：主对话、子代理对话、任务、提交、文档、用量
│       └── handoff/<task_id>/              # 子代理工作目录（临时）
├── memory/
│   ├── core/*.md                           # 核心记忆与待确认提议（事实来源，主人可直接编辑）
│   ├── journal/*.md                        # 情景日记（M3，事实来源）
│   ├── .trash/                             # 删除与清空的去处，保留 7 天
│   └── index.sqlite3                       # meta、FTS 可重建；rejections、audit 是账本，不可重建
├── amadeus-next-sessions.json              # 旧 SessionStore：只读历史
└── pi-sessions/*.jsonl                     # 旧 Pi 会话：不再打开，保留

~/.amadeus/                                 # amadeusHome()，可由 AMADEUS_HOME 覆盖
├── settings.yaml                           # 主进程设置（含 report_proactive）
├── pi/ROLE.md、pi/PRESENTATION.md          # 角色 prompt，section 每次请求读取
├── pi/settings.json                        # 默认模型三键：defaultProvider / defaultModel / defaultThinkingLevel
└── workspace/                              # 现 worker 的 cwd；迁移后主对话不设 cwd
```

| 存储 | 谁写 | 性质 |
| :--- | :--- | :--- |
| `sessions/<id>/durable.sqlite` | 仅 pi-worker | **事实来源** |
| `sessions/index.json` | 仅 pi-worker 的 SessionHost | 派生，可从各库的 `app.session` 文档重建 |
| `memory/core`、`memory/journal` | pi-worker 的 MemoryStore；主人也可直接改 | **事实来源** |
| `memory/index.sqlite3` | MemoryStore | `meta`、`memory_fts` 派生，可重建；`rejections`、`audit` 是账本，**不可重建**，随 `memory/` 一起备份 |
| `~/.amadeus/pi/ROLE.md`、`PRESENTATION.md` | 主人 | **事实来源**；不进 durable，改完下一次请求生效（§9） |
| `~/.amadeus/pi/settings.json` 的默认模型三键 | pi-worker（`model.set`） | 全局默认；沿用现有读取方式，不再经 `SettingsManager` |
| `~/.amadeus/settings.yaml` | 主进程 | 不变。设置项含 `report_proactive`、`delegation_model`、`web_search_provider` / `web_search_api_key`、`memory_enabled` / `memory_recall` 等；设置页的"委托"分组放 `report_proactive` 与 `delegation_model` |

`index.json` 结构：`{ version: 1, currentId, sessions: [{ id, title, createdAt, updatedAt, hasActive, pendingReports, empty? }] }`（`empty` 只在为真时出现；命令载荷与 `session.updated` 里的摘要不含它）。
- `hasActive`：该会话有未终止的任务或未结提交。**先置标记、后提交**：`chat.submit` 在 `submit` 之前就把它置位（`handoff` 工具同理），之后用 `harness.inspect()` 校正——每次回合落定、任务图变化、每分钟的空闲巡检、关闭前都会校正（`hasActive = inspect().tasks 或 submissions 非空`）。标记只会多、不会少，所以重启后不会漏掉要续跑的会话。
- `pendingReports`：`app.outbox.pending` 的条数；主进程用它给会话列表打徽标。
- `empty`：只登记过、从未发过消息，没有目录；首次打开建库时清除。
- 写入一律临时文件加 `rename`；观察字段（标题、更新时间、`hasActive`、`pendingReports`）变化合并到 200ms 内最多落一次，登记 / 删除 / 切换当前会话立即落盘。观察字段真的变了才发 `session.updated`。

### 2.1 会话内的文档

| 文档 | 作用域 | 内容 |
| :--- | :--- | :--- |
| `app.session` | session | 标题、创建时间；用于重建 `index.json` |
| `app.handoffs` | 主对话 conversation | 子代理登记表（任务卡片的数据源）：taskId、kind、title、子对话 id、状态（含 `needs_input`）、`round`（轮次，从 1 开始）、`messages`（`handoff_send` 的幂等记录与 steer 正文）、`progress`（`report_progress` 的最近一条）、`question`、`result` 摘要、`failure`；排队顺序即数组顺序。字段见工具约束 §3.6、§3.7 |
| `app.outbox` | 主对话 conversation | `pending[]`：`{ id, taskId, round, status, text, at }`（`status` 含 `needs_input`）；`delivered{}`：`id → { submissionId, entryId \| null, taskId, round?, at }`（`entryId` 为空表示提交还在排队，事件桥看到 `placed` 后补上；第 1 轮的记录没有 `round`）。每一轮各有一份汇报：第 1 轮的 `id` 与 `taskId` 同值，之后是 `<taskId>.<n>` |
| `app.approvals` | 每个子对话 conversation（由 `handoff` 的 commit 建好） | `task` 类型子代理的待确认写操作；键是 `approvalId`（= 工具任务的 TaskId，会话内唯一；`callId` 在不同对话里可能重复，不能当键），值含 `tool`、`summary`、`detail`、`state`、`expiresAt`。放子对话是为了工具直接 `api.watchDoc` 本对话、Reporter 按子对话计数；代价是事件桥要为每个未终态任务的子对话挂监视（工具约束 §4.3） |
| `app.memory-baseline` | 主对话 conversation | 当前快照条目 id、`effective`（快照叠加已发增量后的实际渲染内容）、增量条目 id 列表、累计字节（字段见记忆 §2.4） |
| `app.memory-extract`（M2） | 主对话 conversation | 抽取游标、限流记录、最近一次结果（字段见记忆 §2.4） |

`watchDoc` 对不存在的文档返回 `undefined`，不会创建它。所以这些 `app.*` 文档要在 `root()` 的 `init` 里用 `tx.doc(...)` 建出来；打开既有会话时 SessionHost 先做一次 `harness.commit(tx => tx.doc(...))` 补建（`tx.doc` 对已存在的文档是读取），再启动事件桥。

### 2.2 SessionHost 策略

**状态**：`closed → opening → open → closing → closed`。同一会话并发的打开共用一个 promise；`closing` 期间到达的命令排队，关闭完成后重新打开。

| 项 | 规则 |
| :--- | :--- |
| 打开触发 | `session.load`、`chat.submit`、`report.deliver`、`task.*`；worker `ready` 之后在后台打开：当前会话，加上索引里 `hasActive` 的会话 |
| 保持打开 | 是当前会话；或 `hasActive`；或有 run 在进行，或有已登记未落定的回合（`bridge.runActive` / `bridge.unsettled`） |
| 空闲回收 | 不满足任一保持条件，距上次使用满 10 分钟（每分钟巡检一次，巡检时顺带校正索引）→ 关闭 |
| 关闭顺序 | 校正一次索引（关闭后 `inspect()` 不可用）→ 停所有 watch 与事件桥 → 给还没落定的回合发 `turn.error{code:"closed"}` → `harness.close()`（会中止在途调用，不写任务结果，任务保持 pending） |
| 懒创建 | `session.create` 只在索引登记（`empty: true`），不建目录、不开库；首次 `chat.submit` 才建目录、开库、`root()`。启动时清掉除当前会话外的 `empty` 条目 |
| 多库并存 | durable 的限制是"一个存储同一时间只能一个进程打开"，一个进程打开多个存储没有问题；registry、models、settings、env 在进程内共享。实测 30 个空闲库约 +9MB RSS、+90 个 fd（评估 §3.1）；并存上限默认 16，超出时先关最久没用的空闲会话，全都不空闲则不关；fd 上限与取值待 S2 |
| 中毒恢复 | 非 `StorageRejected` 的存储错误（`SQLITE_BUSY`、磁盘满、ID 冲突）会使 Harness 中毒，之后所有操作抛 "Session is poisoned"。SessionHost 识别后停桥、关闭、重开该会话（走打开时序）；`HarnessOptions.onReport` 接日志 |

**打开时序**：

| 步 | 动作 |
| :--- | :--- |
| 1 | 校验 id，确认已在索引登记 |
| 2 | `mkdir`（0o700）；`openNodeSqliteStorage`；`Harness.open`（共享 models / registry / settings / env） |
| 3 | `root(ctx, { agent, init })`：agent 为 `[amadeus-role, amadeus-memory, amadeus-handoff]` 加当前模型；`init` 建文档并写 `app.session`；既有会话补建缺失的 `app.*` 文档（§2.1）。`root()` 对已有根对话不会重新套用 agent，所以模型要另走 `configure`（§3.2） |
| 4 | **先不 `resume()`**：`Harness.open` 只把 `running` 任务改回 `pending`，不调度；`resume()`（或 submit、wait、abort）才开始。实测重开后直接 `resume()`，被中断的生成会**重新向模型发请求**，与现有"崩溃不重放 prompt"（`test/pi-reload.test.mjs`）冲突。先附上事件桥（`watchEvents`，不调度），从 snapshot 里读出有没有遗留的根对话 run（`hasRun`） |
| 5 | **对账**（`reconcileHandoffs` + `expireApprovalsOnOpen`，此时没有任何任务在跑）：① `outbox.pending` 里的每个 id，用 `tx.submissionByRequest(root, "report:<id>")` 查，已有提交就补做第二次提交（`pending` 移除、写 `delivered`）；② `delivered` 里 `entryId` 为空的项，用 `harness.submission(submissionId).status()` 补齐；③ `app.handoffs` 里未终态条目的子对话，把 `app.approvals` 中所有 `pending` 置 `expired`、`by: "restart"`（被打断的工具随后返回 `interrupted`，子代理自行决定是否重新请求；工具约束 §4.3）。**对账前先记下这些 `pending` 项，对账后为每一项补发 `task.approval-resolved { state: "expired" }`**：作废发生在第 7 步挂 `app.approvals` 监视之前，监视看不到这次状态变化，渲染进程里旧的确认卡片只能靠这个事件收起；④ 清理器：queued / running 的委托若 Reporter 已终止或不存在，置 `failed`（原因 `lost`）并补写 outbox（工具约束 §3.4） |
| 6 | 有遗留 run（`hasRun`）→ `root.abort()`，随后 `harness.resume()`。**abort 排在对账之后**：`Conversation.abort()` 内部会先 `tasks.resume()` 启动调度器（`pi-durable/dist/harness/harness.js`），而对账第 ③ 项要求此刻没有工具任务在跑，否则会误伤正在等待确认的任务。abort 实测约 4ms，不发模型请求，提交落为 `unanswered / aborted`：半截回答成为 `aborted` 的 assistant 条目，不进模型上下文；后台任务不受影响。原因：没人在听的回答没有意义，也不该在后台白烧 token（评估 §3.1、S1） |
| 7 | 数一遍主人发言次数（记忆重新冻结按它触发）；挂 watch：`app.outbox`（现存 `pending` 逐条发 `task.report-ready`，重放——`watchDoc` 的 `value` 只给打开时的现值，不会回放历史变化）、`app.handoffs`（`task.graph`，状态 / 轮次 / 问题的变化立即发，只有 `progress` 变了按 15 秒节流，§7.3）、各未终态委托子对话的 `app.approvals`（§4.4）；校正索引（`hasActive`、`pendingReports`） |

**删除时序**（`session.delete`）：

| 步 | 动作 |
| :--- | :--- |
| 0 | 主进程：若是当前会话或有活动回合，先 `cancelTurn()`；拒绝该会话的新 `chat.send`；选下一个当前会话（没有就懒创建一个） |
| 1 | 先等进行中的打开落定。会话已打开：`root.abort(ctx, { background: true })`，最多等 10 秒；超时直接进入下一步（`close()` 本身会中止所有在途调用） |
| 2 | 停桥，`harness.close()` |
| 3 | 目录 `rename` 到 `sessions/.trash/<id>-<时间戳>`（同分区内原子） |
| 4 | 从索引移除（原子写）；删的是当前会话则 `currentId` 先落到最近更新的会话 |
| 5 | 递归删除 `.trash` 里的该目录；失败不影响结果，下次启动清空 `.trash` |
| 6 | 发 `session.updated { deleted: true }`，主进程据此丢弃该会话的缓存、汇报与待确认 |

任一步被杀：3 之前被杀，会话仍在，可重新删；3 与 4 之间被杀，启动时索引里指向的目录不存在，条目被丢弃；4 之后被杀，只剩 `.trash`，启动时清掉。**不会复活**。
会话未打开时只做 3 到 6（没有任务在跑）。`task` 类型子代理写在 `handoff/` 下的文件随目录一起删除。

**崩溃恢复**（worker 意外退出）：

| 步 | 谁 | 动作 |
| :--- | :--- | :--- |
| 1 | PiHost | `exit` 事件：在途命令全部以 `worker_exit` 失败；先发 `worker.down`（Floor 的闸门先关；AppRuntime 同时作废缓存里的未决确认，见第 5 步），再为每个**已受理**的回合（`chat.submit` / `report.deliver` 已拿到应答）合成 `turn.error(worker_exit)`；命令还在途的回合由该命令的 `worker_exit` 拒绝处理 |
| 2 | PiHost | 自动重拉：第 1~5 次失败后分别退避 1、2、4、8、16 秒再拉，第 6 次失败（即连败超过 5 次）停止，保留 `error`，等下一条命令触发（沿用惰性重拉，且重置计数）；稳定运行 60 秒后计数清零。计划内的 `restart()` 期间旧进程退出不计入 |
| 3 | worker | `initialize()`：取进程锁（上一个进程已死，接管）、ModelRuntime、索引校验（丢弃目录缺失的条目、清空 `.trash`、索引缺失或损坏则扫描目录重建）。然后发 `ready` |
| 4 | worker | `ready` 之后在后台打开当前会话和 `hasActive` 的会话（走上面的打开时序）：遗留 run 被中止，Reporter 与抽取任务续跑，`pending` 汇报重放 |
| 5 | AppRuntime | 收到 `worker.ready`：`floor.workerUp()` 清空待投递缓存（由重放重建）并 `wake()`；**对缓存里每个未决的确认向渲染进程发 `task.approval-resolved { state: "expired" }`，再清空待确认缓存**（未决项已被作废；`worker.down` 时做同样的事，因为 worker 倒下后不会再有人等这些确认），并刷新会话列表的红点；补发一次 `memory.configure`；若 `init` 时 worker 没起来、尚无当前会话，补一次 `ensureCurrent` + `session.load` 并发 `session.changed` |

应用退出等于杀 worker（`dispose()` 不等待），走同一条恢复路径。

**checkpoint / resume**（计划内重启）：
- `checkpoint`：**一到达就进入 `checkpointing`**，此后除 `chat.abort`、`checkpoint`、`resume` 外的命令一律回 `closed`。然后：等所有会话道排空、记忆任务落定 → 给每个会话的在途回合最多 **5 秒宽限**（`checkpointGraceMs`）自然结束 → 仍在流式的，`close()` 会中止它们，事件桥给它们发 `turn.error{code:"closed"}`（主进程按"被打断"处理：`chat.interrupted`，不弹错误）→ 关闭全部 Harness（空闲约 1ms，流式中约 73ms）→ 关记忆服务、落索引、释放进程锁 → `closed`。此后只接受 `checkpoint`（幂等）和 `resume`。不"按需重开"：重开会让旧进程和正在启动的新进程同时持有同一个库，见下。
- `PiHost.restart()` 顺序：对旧 worker `checkpoint` → 拉起替换进程并等 `ready`（新进程此时才取锁、开库）→ 杀旧进程。
- 替换进程启动失败：对旧 worker 发 `resume`（重新取锁、起记忆服务、以磁盘为准重校索引，会话懒重开，`hasActive` 的会话后台重开），行为恢复；`restart()` 抛错给上层。
- `checkpoint` 超时或失败：杀旧进程，**等它的 `exit` 事件到了**（最多 10 秒，之后靠新 worker 的进程锁兜底）再拉起新进程（冷启动，等同崩溃恢复）。
- `AppRuntime.flushReload` 只在两处发 `checkpoint`：目标含 `main`（退出前落盘，之后 `exit(75)`），以及 `restart()` 内部；目标含 `pi-worker`（或 `pi` 且 worker 已挂）走 `restart()`，`pi` 单独重载走 `reload`；`scene`、`speech` 不碰 worker。

**单进程独占**（评估 §3.1 实测）：durable 没有跨进程锁，第二个进程打开同一个库**不会报错**。`busy_timeout`（默认 5 秒）只管写锁竞争时的等待，不是互斥。实测两个进程开同一个库：后开的接管并重跑前者在途的生成，前者下一次提交报 ID 冲突并中毒。所以必须在应用层保证同一时刻只有一个 worker 持有存储：

| 层 | 措施 |
| :--- | :--- |
| 时序 | `restart()` 先 `checkpoint`（关库、释放锁）再拉新进程；`checkpoint` 失败则等旧进程 `exit` 之后再拉；崩溃自动重拉也只在收到 `exit` 之后 |
| 锁文件 | worker 启动时用 `wx` 创建 `sessions/.lock`，内容 `{ pid, startedAt }`，**先取锁再开任何库**。已存在：pid 存活**且确认它就是写锁的那个进程**则每秒重试，最多 10 秒，仍被占用就在 `ready` 里报错、不开库；pid 已死、或已被别的进程复用则接管。`utilityProcess` 被 `kill()` 时不跑退出钩子，锁会残留，而 pid 可能已被复用，所以判活还要核对进程启动时间：用 `ps -o lstart=` 取该 pid 的启动时间，晚于锁里 `startedAt`（留 30 秒误差，`lstart` 只有秒级精度）说明它是后来的进程；取不到（没有 `ps`、Windows）按存活处理。旧格式只写了 pid 的锁同样兼容。`checkpoint` 后删除，`resume` 重新取，进程退出时尽力删除 |
| 开发热重载 | `main` 目标退出码 75 重启主进程时，旧 worker 可能还没死：靠锁文件挡住（待 V3 验证） |

相比 v2 删掉的东西：
- `SessionStore` 作为事实来源；Pi jsonl 会话；
- 记忆文档的 `injections` / `session_baseline` 表；
- 工具约束文档的任务表与调度器。

为什么核心记忆不放进 durable：记忆要求主人能直接编辑、能看懂、能备份，Markdown 更合适；它是跨会话的全局数据；而且 durable 的记录改不掉、删不掉。

---

## 3. Agent 层

### 3.1 扩展清单

| 扩展 | 内容 | 主对话 | 子代理 |
| :--- | :--- | :--- | :--- |
| `amadeus-role` | section：ROLE + PRESENTATION + protocol，`tag: false`（渲染结果与现状 system prompt 同形，不套 `<role>` 标签） | ✓ | ✗ |
| `amadeus-memory` | 工具 `remember` / `forget`；任务定义 `MemoryExtract`（M2）；条目 kind `amadeus.memory-*`、`amadeus.episode`；`beforeCompact` 钩子（A4 起）：摘要源里剔除记忆块，并自带陪伴向的压缩提示词（默认提示词面向编码任务）；文档 `app.memory-baseline`、`app.memory-extract` | ✓ | ✗ |
| `amadeus-handoff` | 工具 `handoff` / `handoff_send` / `handoff_status` / `handoff_cancel`（除只读的 `handoff_status` 外，成功时返回 `control: { terminate: true }`）；任务定义 Anchor、Reporter；文档 `app.handoffs`、`app.outbox` | ✓ | ✗（禁止递归） |
| `amadeus-research` | 只读 web 搜索 / 抓取工具（`web_search`、`web_fetch`）、`report_progress` | ✗ | `research` |
| `amadeus-files` | 受限的 `read` 与 `list_dir`（只允许主人授权的路径）、`report_progress` | ✗ | `files` |
| `amadeus-task` | `read`、`list_dir`、`bash` / `edit` / `write`（后三者经 `wrapTool` 包装为逐次确认，并受 `pathGuard` 与环境清理约束）、`report_progress`；写 `app.approvals`（挂子对话） | ✗ | `task` |

Harness 级设置（所有会话共享）：

| 设置 | 值 | 理由 |
| :--- | :--- | :--- |
| `extensions` | `[]` | 每个对话显式选择扩展，不依赖"默认全选" |
| `progress.partialIntervalMs` | 30 | 第一个 partial 也要等满这个间隔才提交，100ms 默认值会吃光首包预算（评估 §2.5） |
| `progress.outputIntervalMs` | 100 | 工具输出不进主对话，默认即可 |
| `stream.cacheRetention` | `"long"`，设置项可改 | 陪伴对话常有超过 5 分钟的停顿 |
| `compaction` | 默认（`reserveTokens` 16384、`keepRecentTokens` 20000、`backgroundTokens` 32768） | 压缩后记忆重新冻结（记忆 §4.3） |
| `retry` | 默认（3 次，基数 2s） | 流式中途失败后重试，会把前半句再播一遍，见 §12 V1 |
| `contextRetentionMs` | 默认 10 分钟 | 只是 durable 在内存里缓存"上次读到的上下文"，与 Harness 何时关闭无关，不用同步调整 |

- 主对话固定为 `[amadeus-role, amadeus-memory, amadeus-handoff]`，会话内不变。
- 工具用法写在工具的 `description` 里，静态 prompt 不点名任何工具（工具约束 §2.2）。
- **hook 不能提交事务**（`HookApi` 只有 models、memo、snapshot）。所以凡是要写入的逻辑都不放在 hook 里：
  - 记忆条目由 worker 宿主代码在提交输入前写入（记忆 §4.1）；
  - 回合后抽取任务由宿主代码在 `run_end` 后用 `conversation.commit` 创建（记忆 §5.2）；
  - 写操作确认放在 `wrapTool` 包装后的 `execute` 里，用 `api.watchDoc` 等待（工具约束 §4.3）。

### 3.2 主对话

```text
system   amadeus-role section                                 全局不变（durable 保证它领头）
tools    remember / forget / handoff / handoff_send / handoff_status / handoff_cancel   会话内不变
entry    amadeus.memory-snapshot（model: 快照）                 会话首轮写入
entry    pi.user / pi.assistant ...
entry    amadeus.memory-update（model: 增量）                   核心记忆变化时写入
entry    amadeus.memory-refreeze（edits: replace 快照 + omit 增量）  增量超预算时写入
entry    pi.user（汇报回合：<amadeus_handoff_result>）          子代理结果，requestId = report:<id>
...
```

- **模型与 thinking 级别**沿用现在的全局选择：读 `~/.amadeus/pi/settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`。durable 没有宿主默认模型，每个对话都必须 `configure`（缺省 `thinkingLevel` 为 `"off"`，没有 model 时回合以 `no_model` 失败）。所以每次 `chat.submit` / `report.deliver` 处理时，与根对话已解析的 agent 比较，不同就 `configure({ model, thinkingLevel })`（现有 `followSelection` 的同款逻辑）。`model.set` 写同一个文件。可选档位来自 `@earendil-works/pi-ai` 根导出的 `getSupportedThinkingLevels(model)`。子代理在 `handoff` 时复制根对话当前的 model；配置了委托专用模型（设置项 `delegation_model`）且可用时改用它（见 §3.3）。
- **`handoff` / `handoff_send` / `handoff_cancel` 成功即 `terminate`**：这一轮所有工具结果都带 `terminate` 时，durable 不再发起下一次模型请求，run 以 `done` 结束。红莉栖说完前置那句话就收口，不会在工具返回后再重复一遍，也省一次 LLM 往返。代价：模型若没有前置文本就直接调用，主人什么也听不到，比例待原型统计（工具约束 §6）。`handoff_status` 只读、不 `terminate`，红莉栖接着用自己的话转述状态。
- **委托是可续接、可查询、可提问的**（handoff v2，细节以工具约束 §3.7 为准，这里只定分工）：结果不满意或要追问，红莉栖用 `handoff_send` 对同一个子对话续接，开新一轮（`round + 1`，同一个 `task_id`，每轮各有自己的 Reporter 与汇报）；运行中补充则登记为 steer，由 Reporter 投递；主人问进展时用 `handoff_status`（只读 `app.handoffs`，不猜测）；子代理缺信息时以 `QUESTION:` 收尾，任务进入 `needs_input`（不占并发名额、没有 Reporter 在跑），汇报把问题带给红莉栖，由她问主人，再用 `handoff_send` 回传答案。
- **汇报只有一种投递**（工具约束 §3.5）：`input` 提交，红莉栖开口。**取消不生成汇报**：`done` / `failed` / `timeout` / `needs_input` 才写 outbox，`cancelled` 只更新 `app.handoffs` 与任务卡片；红莉栖经 `handoff_cancel` 取消时已从工具结果知道，从卡片取消她不会主动提起。主动汇报关闭时汇报留在 `pending`、只显示卡片；"下次说话时一起说"用静默 `write` 条目承载，是否可行待 §12 V4，在此之前不假定。
- 记忆条目写入与输入提交是两次提交：先 `conversation.commit(appendEntry + 基线文档)`，再 `submit(input)`；都只在对话空闲时做（记忆 §4.1）。
- 重新冻结用 `replace` 覆盖原快照、`omit` 隐藏增量，快照位置不变；原快照已被压缩掉时改为追加新快照（记忆 §4.3）。
- 压缩使用 durable 内置的自动压缩。

### 3.3 子代理

| 项 | 约束 |
| :--- | :--- |
| 创建 | `handoff` 在一个 `api.commit` 内创建后台 Anchor 任务、归属它的子对话、`app.handoffs` 登记、后台 Reporter |
| 配置 | `configure(tx, child.id, { extensions: [<kind 扩展>], instructions: <kind 说明>, cwd: <任务目录> })`，数组形式精确选择，不继承主对话扩展。model 与 thinkingLevel 缺省不写：任务归属的子对话创建时复制主对话的 agent。设置了**委托专用模型**（设置项 `delegation_model`，`provider/model`，空 = 与对话模型相同；经环境变量 `AMADEUS_DELEGATION_MODEL` 传给 worker，变化触发 `pi-worker` 重载）且模型在目录里、有凭据时才写 model（主对话的思考档位该模型不支持时改用 `medium` 或其第一个档位）；不可用就回退到对话模型，并在条目 `failure` 里留一条 `model_fallback` 备注（任务照常进行，备注只给卡片展开看）。续接的新一轮沿用同一个子对话，也就沿用同一个模型 |
| 上下文 | 只看到 `brief`；不注入核心记忆，不继承主对话历史 |
| 生命周期 | 后台任务：主人按停止不影响它；`handoff_cancel` 或任务卡片上取消时，置 `cancelRequested`，Reporter 对子对话调用 `abort()`；取消只更新 `app.handoffs` 与卡片，不写 outbox。`needs_input` 的任务没有 Reporter，取消当场置 `cancelled` 并撤回还没投递的提问汇报。结束后的任务可被 `handoff_send` 续接（`done` / `failed` / `timeout` / `needs_input`），`cancelled` 的不行 |
| 资源 | 超时默认 5 分钟（活跃时间，不含确认等待；Reporter 用 `runtime.sleep` 计时）；并发**按会话计**，每会话默认 2（`app.handoffs` 计数 + Reporter `wait-slot` 排队，一会话一库，各库互不可见）；崩溃时只有 `replay: "safe"` 的工具会重跑 |
| 进度 | 子代理对话的事件不经事件桥；任务卡片的数据来自 `app.handoffs`。子代理用 `report_progress`（三类都带）写一行进度备注，落在条目的 `progress`，只给任务卡片与 `handoff_status`，不打扰主人；推给界面的 `task.graph` 对只有 `progress` 变化的更新按 15 秒节流 |
| 结果 | Reporter 写入 `app.outbox.pending`，由主进程决定何时投递（§4.3） |

---

## 4. 回合与话筒

### 4.1 为什么需要话筒仲裁

现在只有用户能发起回合，语音是半双工：回合进行中不开麦，播放完 1 秒后恢复监听。引入委托后多了一个回合来源，也就是子代理的结果汇报。durable 的 followUp 只知道对话忙不忙，不知道主人正在说话、语音还在播放。所以**何时开口必须由主进程决定**。

现状里与仲裁有关的事实（代码为准）：
- 回合期间 ASR 不开：`asr.start` 在回合未结束时只记意图（`listeningEnabled`）；回合进行中到达的 ASR 最终结果会被丢弃。所以**语音无法打断回合**。能打断的只有文本发送、`chat.abort`、切换或新建会话、窗口关闭。全双工打断（需要回声消除）不在本文范围。
- 开麦后 30 秒没有任何转写，`SpeechBridge` 报错，`listeningEnabled` 被置为 false；Apple Speech 报 no-speech 同样如此。所以"开着麦但没人说话"最长持续 30 秒。
- 识别文本停顿 1.5 秒（`AMADEUS_SPEECH_PAUSE_MS`）后自动收尾，产生最终结果。
- `chat.abort`：渲染进程有停止按钮（`useSceneSession`），发 `{ session_id, turn_id }`；`abortChat` 只在它们对得上当前 `activeTurn` 时才取消，对不上就当没发生。

### 4.2 状态与转移

Floor 的状态**由现有标志推导**，不另存一份：

| 状态 | 含义 | 推导 |
| :--- | :--- | :--- |
| `idle` | 没有回合，ASR 没开 | 无 `activeTurn`，`speech` 未在识别 |
| `armed` | 麦开着，没人说话 | ASR 在识别，且自 `start` 以来没有非空 partial |
| `hearing` | 主人在说话 | 收到过非空 partial，或已请求收尾、在等最终结果 |
| `responding` | 红莉栖在回应 | 有 `activeTurn`（`kind` 为 `user` 或 `report`），直到 `piDone` 且 `drained` |
| `settling` | 播放正常结束后的 1 秒缓冲 | 回合已结束，`now < listeningResumeAt` |

```text
主链：idle ─开麦→ armed ─识别到文本→ hearing ─最终结果→ responding(user) ─播完→ settling ─1s→ armed 或 idle
旁路：idle / settling 到期 ─汇报→ responding(report)；armed ─汇报且 500ms 内无文本→ responding(report)
抢占：任何状态 ─文本发送→ responding(user)；responding ─打断 / 切会话→ idle
```

**闸门**（叠加在状态之上，任一不满足就不能起对应动作）：

| 动作 | 闸门 |
| :--- | :--- |
| 开麦（`speech.start`） | `listeningEnabled` ∧ `sceneReady`（`asr.start` 在场景未就绪时只记意图，握手后补开）∧ worker 就绪 ∧ 识别器没在跑 ∧ 无进行中回合 ∧ 非 blocked ∧ 缓冲期已过 |
| 起用户回合 | 非 blocked（`reloading`、`reloadTargets` 非空、`importingEmote`，由 `sendChat` 拒绝）∧ 会话不是旧会话（`legacy session is read-only`）∧ 不在删除中 |
| 起汇报回合 | 非 blocked ∧ 无进行中回合 ∧ worker 就绪 ∧ `sceneReady` ∧ `report_proactive` ∧ 当前会话不是旧会话 ∧ 当前会话有未搁置的 pending ∧ 没有投递在途、没有 `busy` 重试计时器 ∧ 输入框没有草稿（`composing` 为 false） ∧ 状态为 `idle` 或（`armed` 且防抖通过）∧ 缓冲期已过 |

- `composing` 由渲染进程用 `chat.composing { active }` 上报，语义是"草稿非空，且最近 30 秒内有键入"（超时由渲染进程自己置回 false，避免一份忘在框里的草稿让汇报永远发不出去）。主进程在切会话、`chat.send`、窗口关闭时把它清零。
- `report_proactive` 关闭时，主进程**不发** `report.deliver`，汇报留在 `pending`，界面只显示卡片。取消的任务不进 outbox，所以闸门里没有"取消"这一类。

**`pump()` 的顺序**：重载 > 汇报 > 开麦。先 `flushReload`（`hearing` 时不执行排队的重载，免得截断主人的话）；blocked 或有回合在进行就返回；缓冲期未到则设一个到期再来的计时器（仅当有监听意图或有可投的汇报）；然后 `tryReport`，投了汇报就不再开麦；最后 `tryMic`。`pump(false)` 跳过开麦：识别器自己结束（普通 `idle`）后只让汇报有机会开口，不重新开麦，免得识别器反复秒退时空转。

**唤醒**（`wake()` 清掉所有汇报的搁置标记和退避计时器再 `pump()`）：`scene.ready`、导入角色资源结束、重载结束、切换 / 新建 / 删除会话、`session.load` 的 pending 重放、打开 `report_proactive`、草稿清空、`worker.ready`。

**`deferred` 的退避**：`report.deliver` 回 `closed` / `worker_exit` / `timeout`（worker 在重启或没来得及应答，而主进程还没收到 `worker.down`）时，汇报原样保留，**整个信箱**按 1、2、4、8、16、30 秒退避（`DEFER_BACKOFF_MS`，逐次翻倍、封顶 30 秒，连续 `deferred` 的次数决定取哪一档）：worker 不可用时换哪条汇报都一样，不能逐条各试一轮，也不能立刻重投空转。退避期内 `pump()` 不再投汇报；`wake()` 会提前解除退避（形势变了值得再试一次，再失败则退避更久，次数不清零）。任何不是 `deferred` 的应答都说明 worker 在回话，次数清零；`worker.down` / `worker.ready` 也清零并取消计时器。

**回合看门狗**（`appRuntime.ts` 的 `TURN_WATCHDOG_MS`，120 秒）：每个回合（用户或汇报）起算时挂一个计时器，该回合每收到一个 `turn.*` 事件就刷新最近事件时刻（事件密集时不逐个重置计时器，到点发现沉默不够久就按剩余时间重新挂）。回合还没 `piDone` 却连续 120 秒没有任何 `turn.*` 事件，主进程先对 worker 发 `chat.abort`（失败忽略），再按被打断收尾（`interruptTurn`，同转移 14，发 `chat.interrupted`），Floor 才能回到空闲，不会因为 worker 那边的回合挂住而永远不开麦、不投汇报。回合结束、被取消或应用退出时撤掉计时器。

**转移表**：

| # | 状态 | 事件 | 动作 | → 状态 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | idle | `asr.start` | `listeningEnabled = true`；闸门通过则 `speech.start` | armed（闸门未过则留在 idle，解除后补开） |
| 2 | armed | ASR 非空 partial | 记 `hearing` | hearing |
| 3 | hearing | ASR 最终结果（自动） | 识别器已结束（`asrOn = false`）。判定（`recognized`）：blocked 或有回合在进行 → 丢弃；`listeningEnabled` 关、旧会话或空文本 → 丢弃；否则以新 `turnId` 起用户回合（`sendChat`） | responding(user) |
| 4 | hearing | ASR 最终结果（`manual`，主人点了停） | blocked 或有回合在进行时同样丢弃；否则文本进输入框（`asr.recognized` 照常转给界面），不起回合；`listeningEnabled = false` | idle |
| 5 | armed、hearing | ASR 报错、no-speech、30 秒无转写 | `status()`：`listeningEnabled = false`；清 `hearing`；识别结束即 `asrOn = false`，随后 `pump(false)` | idle |
| 6 | armed、hearing | `asr.stop` | `listeningEnabled = false`；`speech.finish(true)` | idle |
| 7 | idle、armed、hearing、settling | 文本 `chat.send` | `speech.stop`；起用户回合 | responding(user) |
| 8 | responding | 文本 `chat.send` | `cancelTurn()`（`tts.abort`、`chat.abort`、发 `chat.interrupted`）后起新用户回合 | responding(user) |
| 9 | responding | `chat.abort`、`session.load`、`session.create` | `cancelTurn()`；`listeningEnabled` 保留 | idle |
| 10 | responding | 窗口关闭 | `cancelTurn()`；`listeningEnabled = false`；`sceneReady = false` | idle |
| 11 | responding | `turn.done` | 发 `chat.complete`；`tts.finish()` | responding（等 `drained`） |
| 12 | responding | 播放 `ended` | 记 `listeningResumeAt = now + 1s`；`drained` | `piDone` 则 settling，否则 responding |
| 13 | responding | 播放 `error`、`tts.error`、场景丢失 | `tts.abort()`；`speech = false`；`drained` | `piDone` 则 idle，否则 responding（文本继续） |
| 14 | responding | `turn.error`（`code` 为 `closed`）、`turn.aborted`（worker 侧自己打断；本地取消的回合早已不是 `activeTurn`） | `interruptTurn`：`tts.abort()`；发 `chat.interrupted`（带已显示的文本）；`drained` | idle |
| 15 | responding | `turn.error`（其它 `code`）、`chat.submit` 受理失败 | `failTurn`：`tts.abort()`；发 `chat.error { code, error }`；`drained` | idle |
| 16 | responding | worker 退出 | PiHost 先发 `worker.down`（`workerReady = false`），再合成 `turn.error(worker_exit)`，同 15 | idle，blocked 直到 `worker.ready` |
| 17 | settling | 缓冲到期 | `pump()`：有可投递汇报则起汇报回合；否则 `listeningEnabled` 则开麦 | responding(report)、armed 或 idle |
| 18 | idle | `task.report-ready`、`wake()` 的各个来源（见上文"唤醒"） | `pump()` | responding(report) |
| 19 | armed | `task.report-ready` | 防抖 500ms，其间出现非空 partial 则取消；到期仍是 `armed` 才 `stopMic()` 后起汇报回合 | responding(report) |
| 20 | hearing | `task.report-ready` | 入队，不抢；也不执行排队的重载 | hearing |
| 21 | responding(report) | `report.deliver` 回 `busy`（`ConversationBusy`；其它未归类的错误同样按它处理） | 作废这个回合（不播报，`discardTurn`）；1 秒后重试，最多 5 次，之后**搁置**（`parked`），等下一次 `wake()` | idle |
| 22 | responding(report) | `report.deliver` 回 `already`、`missing`；或错误 `not_found` / `invalid` | 作废这个回合；汇报从缓存里移除（已处理或不存在），随即 `pump()` | idle |
| 23 | responding(report) | `report.deliver` 回 `aborted`（排队中被撤回）；或错误 `closed` / `worker_exit` / `timeout` | 作废这个回合；汇报**保留**。`aborted` 不立刻重投（违背打断者的意思），等下一次自然的 `pump()`；其余（`deferred`）进入信箱级退避（1、2、4、8、16、30 秒，见上），期间不重投，`wake()` 可提前解除；worker 没就绪时闸门本来就挡住 | idle |
| 24 | idle、armed、settling | 重载入队（`reloadTargets` 非空） | `pump()` 开头 `flushReload`：`stopMic()`，`reloading = true`；重载结束 `wake()` | blocked，解除后 `pump()` |
| 25 | 任意 | `scene.lost` | `tts.abort()`；当前回合 `speech = false`、`drained`；非重载时 `listeningEnabled = false`，重载中保留监听意图 | 当前回合继续（文本） |
| 26 | responding | 回合看门狗：连续 120 秒没有任何 `turn.*` 事件，且 `piDone` 仍为 false | `chat.abort`（失败忽略）后 `interruptTurn`（同 14） | idle |

**不变量**：
1. 同一时刻最多一个 `activeTurn`（跨会话）。
2. ASR 只在 `armed`、`hearing` 时开着；其余状态一律关闭。
3. worker 只在收到主进程命令时开始回合；agent 层从不自己开口。后台任务（抽取、Reporter）不产生语音。
4. 用户输入永远优先：任何状态下 `chat.send` 立即抢占，汇报永远让路。
5. 汇报只投递给**当前会话**。

回合类型：

| 回合类型 | 触发 | 写入 durable | 打断规则 |
| :--- | :--- | :--- | :--- |
| 用户回合（`kind: "user"`） | ASR 最终结果、文本发送 | `submit({ type: "input", requestId: "turn:<turnId>", whenBusy: "reject" })` | 打断进行中的任何回合（沿用 `cancelTurn`）；worker 在提交前先确认对话空闲，遗留的 run 先 `abort` |
| 汇报回合（`kind: "report"`） | 汇报信箱非空且话筒空闲 | `submit({ type: "input", requestId: "report:<id>", whenBusy: "reject" })` | 可以被用户回合打断；被打断的汇报不重投，红莉栖在下一个回合里自然提及。`report.deliver` 绝不去 abort 别人的 run，忙就回 `busy` |

### 4.3 汇报信箱

```text
子代理完成
 └─ Reporter（durable 后台任务）在一个 commit 内：
     ├─ 把结果写进主对话的 app.outbox.pending（id、taskId、status、text）
     └─ 结束任务
pi-worker 事件桥
 └─ watchDoc(app.outbox) 变化（只对新增的 pending id）→ 通知主进程 task.report-ready { sessionId, id, title, status, round }
主进程 Floor
 └─ 当前会话、闸门通过 → worker 命令 report.deliver { sessionId, id, turnId }
     └─ worker（会话道，`runtime.deliver`）：
         1. 会话必须已建库（`empty` 的回 not_found）；排队期间被 chat.abort 撤回 → aborted
         2. 已在 delivered[id] → 回 already；不在 pending → 回 missing        ← 先于 busy
         3. 对话忙（inspect：根对话有前台任务，或有已被 run 接手的输入）→ 回 busy，不去 abort 别人的 run
         4. 同步模型选择、写记忆条目（与 chat.submit 相同）
         5. 事件桥登记 requestId → turnId，再 deliverReport：
            tx.submissionByRequest(root, "report:<id>") 已有提交 → 只补记，回 already
            否则 submit({ type: "input", content: 围栏文本, requestId: "report:<id>", whenBusy: "reject" })
            抛 ConversationBusy → 什么都没写入，回 busy，汇报留在 pending
         6. 读 submission.status() 的 entry，一个 commit 内：pending 移除；
            delivered[id] = { submissionId, entryId 或 null, taskId, at }
         7. entryId 为 null 时后台补记（backfill）；回 started，带卡片数据（来自 app.handoffs）
```

`report.deliver` 的应答与主进程（Floor）处理：

| 应答 | 含义 | Floor 的结局 |
| :--- | :--- | :--- |
| `done { status: "started", card }` | 已受理，`turn.*` 随后到达 | `started`：汇报从缓存移除；保持 `responding(report)`；向渲染进程发 `task.report`（卡片） |
| `done { status: "already" }` | 该汇报已有 submission（上次崩在两次提交之间，或主进程重试）；worker 已补做第二次提交 | `already`：作废回合，不播报；红莉栖的回答若已生成，只留在记录里；移除 |
| `done { status: "missing" }` | pending 与 delivered 都没有这个 id（会话被删、重复事件） | `missing`：作废回合；移除 |
| `error busy` | `ConversationBusy`。拒绝时没有写入任何东西，同一个 `requestId` 可原样复用。出现 busy 说明 Floor 与 durable 对"忙"的判断不一致（例如上一个汇报回合的尾部仍在生成），属罕见情况 | `busy`：作废回合；1 秒后重试，最多 5 次，之后搁置，等下一次 `wake()`；汇报始终留在 pending。未归类的其它错误同样按 `busy` 处理 |
| `error not_found` / `invalid` | 会话不存在或参数不合法 | `dropped`：移除 |
| `error closed` / `worker_exit` / `timeout` | worker 在重启或没来得及应答 | `deferred`：保留，作废这个回合，信箱级退避 1、2、4、8、16、30 秒后再投（`wake()` 可提前解除，应答正常即清零，§4.2） |
| `aborted` | 排队期间被 `chat.abort` 旁路撤回，还没提交 | `aborted`：保留，作废回合，**不立刻重投**，等下一次自然的 `pump()` |

- durable 保证汇报不丢、不重复（`requestId` 幂等）；主进程只负责时机。
- **两次提交的间隙**：第 5 步的 `submit`（提交一）已把输入写进对话并启动 run，第 6 步（提交二）才写 `delivered`。两步之间崩溃：重启后打开会话时对账（§2.2 打开时序第 5 步）补做提交二；遗留 run 被中止。
- **`queued` 的特例**：`submit` 返回时记录可能还是 `queued`、没有 `entry`（对话空闲但 inbox 里有失败 run 遗留的项目，汇报排在它们后面）。此时 worker 记 `delivered[id] = { submissionId, entryId: null, taskId, at }`，`pending` 照常移除。事件桥收到该 `requestId` 的 `submission` 事件（记录变为 `placed`）时取 `entry`：**先**记入桥内存里的"汇报条目"集合再转发同批事件（避免界面把它闪成用户气泡），**再**用一个 commit 补写 `entryId`；`deliver` 之后的后台补记（`backfill`）与打开会话时的对账（§2.2 打开时序第 5 步）都会用 `harness.submission(submissionId).status()` 补齐。为空期间条目不在对话记录里，卡片仍显示"已送达"。出现概率待原型验证（§12 V2）。
- **abort 在提交前后的区别**：abort 赶在 `submit` 之前，汇报仍在 pending，之后重投；abort 在 `submit` 之后，汇报输入已经在上下文里，记为已投递，不重投。
- 汇报输入的条目 kind 是 `pi.user`，**界面靠 `delivered` 里的 `entryId` 识别**，渲染成任务卡片；`taskId` 用来从汇报找到子对话与卡片。卡片内容 = `app.handoffs` 里该任务的标题、状态、`round`、`progress`、`question` 与 `result` 摘要（`needs_input` 时摘要就是问题；`pending` 移除后卡片仍从这里读）。同一个任务每一轮各有一张汇报卡片（`taskId` 相同、`round` 不同）：只有最新一轮的卡片反映条目现在的状态，较早几轮从各自当时投递的汇报文本还原。取消的任务没有汇报，卡片只由 `task.graph` 更新。
- **多会话**：`task.report-ready` 的 `sessionId` 不是当前会话时，Floor 只记缓存（按 `sessionId` + `id` 去重），不投递；会话列表用 `pendingReports` 显示徽标；主人切到该会话（`session.load`，返回里带 `pendingReports: [{ id, title }]`，主进程据此补进缓存，缺的 `status` 记为 `done`）后再投。Floor 的缓存只在主进程里，`worker.ready` 时整体清空，由 worker 打开会话时的重放重建；会话被删（`session.updated { deleted }`）时丢弃该会话的条目。
- 多条 pending 一次一条，按完成时间；两条之间经过 `settling`，主人开口优先。
- **主动汇报**是设置项 `report_proactive`，默认开。关闭时，主进程不发 `report.deliver`，汇报留在 pending、界面照常显示卡片，红莉栖不主动开口。目标是"主人下一次开口时随回合带出"，用静默 `write` 条目承载（kind 待定，工具约束举例 `amadeus.handoff-result`），可行性待 §12 V4；V4 通过前不假定，通过后 `chat.submit` 增加 `reportProactive` 参数，worker 在提交输入之前、记忆条目之后写入。

### 4.4 呈现管线

用户回合和汇报回合共用同一条管线：

```text
watchEvents（worker） ─ 文本差量 ─► 清洗器（scrub 记忆和结果标签）─► 端口事件 turn.text
主进程 ─► PresentationText ─► 字幕（chat.token）+ FishTts + 表情
```

- 事件桥在 worker 内长期订阅已打开会话的主对话；用 `submission` 事件里的 `requestId`（`turn:` / `report:` 前缀）把 durable 的 run 对应到主进程的 `TurnKey`。
- 文本按 `partialIntervalMs` 的批次到达，不是逐 token；`PresentationText` 对分片大小没有假设。

**durable 事件 → 端口事件**（源码核实：`dist/harness/events.js`）。同一个批次里，`run_end` 排在 `submission` **之前**，`run_start` 排在 `submission` **之后**，所以按批处理：先扫一遍本批的 `submission` 记录，再处理其余事件。

| durable 事件 | 处理 |
| :--- | :--- |
| `submission` | `record.requestId` 带 `turn:` / `report:` 前缀的，登记 submissionId → { turnId, kind }（提交方也在调用 `submit` 之前预先登记，因为事件可能先于 `submit()` 的返回）；`report:` 的记录变为 `placed` 时，把 `entry` 记入"汇报条目"集合并补写 `delivered.entryId`（§4.3） |
| `run_start { inputs }` | 无输出，记 `runActive = true` |
| `message_start { message }`、`message_update` 的 `changes[]`（`text_start { block }`、`text_delta`、`block`、`message`）、`message_end { entry }` | **第一段文本不一定来自 `text_delta`**：它可能在 `message_start` 的整条消息或 `text_start` 的 `block` 里，答案太短时甚至一个 `text_delta` 也没有。事件桥对每条 assistant 消息的每个 text 块（按 `contentIndex`）记已转发字符数，每个事件都与该块当前全文做差，只补发尾部；`text_delta` 直接追加。`thinking_*`、`toolcall_*` 丢弃，绝不进字幕和 TTS。user、tool-result 消息忽略。清洗器放在做差**之后**、发 `turn.text` **之前**，所有路径都经过它 |
| `tool_execution_start / end` | `turn.tool`（只有主对话的工具；子代理对话不桥接） |
| `run_end` | 看本批该输入的 `submission` 记录：`done` → `turn.done`；`unanswered` 且 `reason: "aborted"` → `turn.aborted`；其它 reason（`model_error`、`no_model`、`faulted`、`reset`）→ `turn.error { code: reason }`。然后 `runActive = false`，再触发抽取门控（`kind: "report"` 跳过） |
| `snapshot`（消费者落后 100 批以上时重发；附加时的第一个事件也是它，含当前全部 `entries`） | 以快照里 `generation.message` 的文本与已转发字符数做差，继续；不要把 `entries` 当新增内容重放 |
| `auto_retry_start / end`、`task_failed` | 只写日志，不转发。`task_failed` 的 kind 为 `amadeus.handoff-reporter` 时是否覆盖后台任务，待原型验证；清理器（§2.2 打开时序第 5 步的 ④）是兜底 |
| `entry_appended`（`amadeus.*`）、`compaction_*`、`usage_changed`、`agent_changed` | 忽略 |

事件流的纪律（评估 §3.1）：每个会话**只在打开时附加一次**，不要每回合附加；监听器内部整体 try/catch——监听器抛错会以 `listener_error` 终止整条流；流以 `session_closed` 或 `listener_error` 结束时，会话仍开着就重新附加，并按快照做差补发。

找不到映射的 run（理论上只在恢复过程中出现）：不发 `turn.*`，`run_end` 时发 `session.updated`。

**子对话的文档**（不走 `watchEvents`）：事件桥另外监视两类 `watchDoc`：
- `app.handoffs` 与 `harness.watchTaskGraph()` 合并成 `task.graph`；`app.outbox` 新增的 pending → `task.report-ready`。
- 每个未终态委托的子对话的 `app.approvals`：新增 `pending` 项发 `task.approval-request`，`state` 离开 `pending` 发 `task.approval-resolved`。会话打开时对 queued / running 的委托挂上，运行中看到新条目也挂上，条目终态且确认都已收尾后卸载。这是 `app.approvals` 放子对话的代价（工具约束 §4.3）。

**界面历史**（`session.load` 的 `messages`）：
- 来源是根对话的 `entries({ order: "ascending" })` 分页读取，**不用 `viewState()`**：`viewState()` 只含压缩头之后的活动上下文，历史会缺。
- `pi.user` → 用户气泡；`entryId` 在 `delivered` 里的 → `card`（`{ taskId, title, status, summary, round, progress?, question? }`，较早轮次的卡片从当时的汇报文本还原）。`pi.assistant` → 取 text 块，同一个 run 内的多条合并为一个气泡，**经 `PresentationText` 取 `display` 通道**。原因：模型原文带 `<zh>` / `<jp>` 与 `[EMO ...]` 标签，现有 `SessionStore` 存的是 `display`，实时的 `chat.token` 也是 `display`，历史必须一致。
- `stopReason` 为 `aborted`、`error` 的 assistant 条目不显示：与现状一致（被打断的半截回答从来不进 `SessionStore`），也与 durable 一致（这类消息不进模型上下文，模型下一轮看不到它）。`pi.system`、`pi.tool-result`、`pi.compaction`、`amadeus.*` 不显示。
- `id` 取 `entryId`（权威 id）；`turnId` 只给进行中的回合，历史条目不带。渲染进程的 `reconcileLoadedMessages` 靠它避免重复。

---

## 5. 记忆

在记忆文档的基础上，按新架构调整如下：

| 项 | 决定 |
| :--- | :--- |
| 默认开关 | **默认开启**（已定） |
| 注入范围 | **只注入 `reviewed`**（已定） |
| 快照预算 | **3KB**（已定） |
| 明确指示（"记住 / 忘掉"） | **运行时工具** `remember` / `forget`，写成 `reviewed`；`source_quote` 必填，且要过三关：能在主人最近 8 条用户回合输入里找到（`quote_not_found`）、够长（CJK 字数 ÷ 4 + 其余词数 ÷ 3 ≥ 1，`quote_too_short`）、撑得起正文（正文与引用共有 ≥ 3 字窗口的覆盖率 ≥ 0.3，`quote_unrelated`）；**汇报回合里两个工具一律禁用**（触发输入是汇报围栏，不是主人说的话）；工具幂等，声明 `replay: "safe"` |
| 自动提议（M2） | durable 后台任务，`run_end` 后由宿主创建，写成 `unreviewed`；通过 `runtime.models` 使用当前对话模型 |
| 注入方式 | 自定义条目；重新冻结用 `replace` + `omit`（已核实） |
| 重放、基线 | 由 durable 条目和 `app.memory-baseline` 承担 |
| 设置页编辑 | 主进程 → worker 的 `memory.*` 命令 → MemoryStore；进行中的会话下一轮写入增量条目。`memory.open-folder` 由主进程自己处理（`shell.openPath`），不转发 |
| 开关与召回模式 | 命令 `memory.configure`，热生效；主进程持久化，worker 每次 `ready` 后由主进程补发一次。**不经 `piEnv()`**：环境变量只在 fork 时读，改一次就要重建 worker（`setConfig` 会按 `piEnv()` 的差异触发 `pi-worker` 重载） |
| 账本 | `rejections`、`audit` 不可重建（§0 原则 3），备份与"清空记忆"都要把它们算进去 |
| 读取 | 只靠注入，不提供读取类工具 |
| 删除会话 | 会话目录整体删除，注入记录随之消失；核心记忆 Markdown 不受影响 |

---

## 6. 安全边界

| 层 | 措施 |
| :--- | :--- |
| 主对话 | 没有内置工具、没有执行环境；只有六个自定义工具（`remember`、`forget`、`handoff`、`handoff_send`、`handoff_status`、`handoff_cancel`），都在执行端校验 |
| 子代理 | 数组形式显式选择扩展；`cwd` 指向任务私有目录；`task` 类型的写入与执行逐次确认（`wrapTool` + `app.approvals`） |
| 子代理的执行环境 | **`NodeExecutionEnv({ cwd })` 的 `cwd` 不是沙箱**：它只是相对路径的基准，绝对路径直接放行（`env/node.js` 的 `resolvePath`），`..` 照常解析；**`bash` 默认继承 worker 的全部环境变量**（`inheritEnv` 缺省为 true，`tools/bash.js`），其中有 `AMADEUS_JEV_API_KEY` 和代理设置。对策（**P0 即需要**，不等 A5）：① 路径守卫 `pathGuard`：`files` 与 `task` 的所有文件工具共用，限定在任务目录与主人授权的根内，拒绝列表（agentDir、userData、记忆目录、`~/.ssh` 等）优先；② `bash` 的 `prepare` 里设 `inheritEnv = false`，只给白名单变量（`PATH`、`HOME`、`LANG`、代理等）；③ 拒绝列表集中在 `pathGuard.ts`。细节与清单见工具约束 §4.1 |
| 路径守卫的拒绝范围 | 拒绝列表**以宿主显式传入的根为准**（`PathGuardOptions.deny`）：`DurableRuntime` 总是传入 userData（`sessions` 的父目录）、`sessions`、记忆目录和 agent 目录；环境变量里的同类目录只是兜底（变量改名时兜底会悄悄失效，没有测试能发现）。词法形式与 `realpath` 都要过拒绝列表，`~/notes` 指向 `~/.ssh` 的符号链接不能当入口。**悬空符号链接一律拒绝**：`realpath` 找不到时用 lstat 看名字本身在不在，名字在而目标不在，写入会穿过链接去创建真实目标，而链接自己的路径看上去在授权范围内 |
| 确认卡完整展示 | 卡片必须展示将要执行或写入的**完整**内容：`bash` 的完整命令（≤ 2000 字符）、`write` 的完整内容（≤ 20000 字符）、`edit` 展开成差异后的全部预览（≤ 20000 字符）。超限**不截断，直接拒绝**，不进确认并让模型拆小重来：只展示前一段，主人批准的就是看不全的内容 |
| `web_fetch` 防 DNS 重绑定 | 每一跳先解析域名并校验全部地址（回环、内网、链路本地、映射到这些段的 IPv6 都拒绝），通过的 IP 登记进本次抓取的固定表；连接用 undici 的 dns 拦截器，`lookup` 只读这张表、不再查 DNS，没登记的主机一律拒绝。校验与连接用同一份解析结果，攻击者的域名在两次解析之间改答案没有可乘之机；请求以 IP 发出，`Host` 与 TLS 的 SNI / 证书校验保留主机名（工具约束 §4.4） |
| 确认通道 | 写操作确认只能由界面点击（主进程 `task.approve`）；红莉栖没有批准工具，语音里说"允许"不会生效，确认不经过任何可被投毒的文本 |
| 外部配置 | Registry 是进程内对象，不读取 `~/.pi/agent` 下的扩展、MCP、AGENTS.md |
| 注入内容 | 记忆、子代理结果、网页内容都带围栏和系统注；写入记忆前做投毒和敏感信息扫描 |
| 记忆写入的来源 | `remember` 的 `source_quote` 要能在主人最近说的话里找到、够长、撑得起正文（引用下限，记忆 §3.3 第 5 步）；**汇报回合里 `remember` / `forget` 一律禁用**：汇报围栏里是子代理带回的网页 / 文件内容，被注入的指令最容易借这个回合改记忆，而该回合主人什么都没说（记忆 §3.2） |
| 输出 | 事件桥的清洗器拦截所有 `amadeus_*` 标签，不让它们进入字幕和 TTS |
| 存储 | durable 存储只由 pi-worker 打开；主进程只通过命令访问；worker 重启前先关库。单进程独占靠 `sessions/.lock`，锁文件记 pid 与启动时间，**判活时核对该 pid 的进程启动时间**，防止 `kill()` 留下的残锁被复用了同一 pid 的无关进程永远占住（§2.2） |
| 会话 id → 路径 | `sessionId` 会变成目录名。进入任何路径拼接前必须匹配 `^[A-Za-z0-9_-]{1,128}$`（沿用 `piSessions.ts` 的规则）；`session.delete` 只接受索引里登记过的 id；目录权限 0o700 |
| 渲染进程入口 | 只有应用主框架能调用 `next.request`（`index.ts` 已校验）；worker 事件不透传，由主进程转换后再发 |

---

## 7. 主进程与 worker 的接口

### 7.1 通道与封包

| 项 | 约定 |
| :--- | :--- |
| 渲染 ↔ 主进程 | 单一 invoke 通道 `next.request(method, params)`，单一推送通道 `next.event({ method, params })`（preload 暴露为 `window.amadeusNext`）。方法名带命名空间 |
| 主 → worker 命令 | `{ id, command, params }`；`id` 为 UUID，参数一律嵌套在 `params` 里。不平铺的原因：`report.deliver` 与 `memory.*` 的参数本身有 `id`，平铺会被封包的 `id` 覆盖 |
| worker → 主 应答 | 每条命令恰好一条终止应答：`{ type: "done", id, ...result }`、`{ type: "error", id, code, error }`、`{ type: "aborted", id }`。沿用现有三种，`error` 新增 `code`；`aborted` 只用于排队中的 `chat.submit` / `report.deliver` 被 `chat.abort` 撤回 |
| worker → 主 事件 | `{ type: "event", name, sessionId?, ...payload }`，**没有 `id`**。`PiHost` 现有逻辑按 `id` 查不到就忽略，新增 `type === "event"` 分支分发给 `onEvent` 订阅者；只接受当前 worker 进程发来的事件 |
| 就绪 | `{ type: "ready", error? }`（沿用）。会话的后台打开发生在 `ready` 之后 |
| 取消 | 原先 `prompt` 命令期间的 `text` / `tool` 流式消息取消，改为 `turn.*` 事件 |

**命令分道**（现在 worker 只有一条串行队列加 abort 旁路。多会话后，`model.list` 的最长 15 秒网络刷新不能挡住 `chat.submit`）：

| 分道 | 命令 | 规则 |
| :--- | :--- | :--- |
| 旁路 | `chat.abort` | 不排队，立即执行；递增该会话的 epoch，使已排队但未开始的 `chat.submit` / `report.deliver` 直接回 `aborted`；记录 `stopping`（沿用） |
| 会话道（按 `sessionId` 串行） | `chat.submit`、`report.deliver`、`session.load`、`session.rename`、`session.delete`、`task.cancel`、`task.approve` | 开头先 `await stopping`，即上一次 abort 已完成 |
| 全局道（串行） | `session.list`、`session.create`、`model.list`、`model.set`、`reload`、`checkpoint`、`resume` | `checkpoint` 先等所有会话道排空 |
| 记忆道（MemoryStore 的互斥队列） | `memory.*` | 不进会话道，也不占全局道（记忆 §8.1）。业务失败用 `done { ok: false, code, error }` 返回，`error` 应答只留给意外异常 |

### 7.2 命令（主 → worker）

| 命令 | 参数 | `done` 载荷 | 错误与说明 |
| :--- | :--- | :--- | :--- |
| `session.list` | — | `{ currentId, sessions: [{ id, title, createdAt, updatedAt, hasActive, pendingReports }] }` | 读索引，不打开会话 |
| `session.create` | `{ sessionId, title }` | `{ session }` | 只登记索引（`empty`）；`sessionId` 由主进程生成，重复调用幂等 |
| `session.load` | `{ sessionId }` | `{ session, messages, tasks, pendingReports }` | 打开并设为当前（写 `currentId`）。`messages[]` = `{ id, role: "user" \| "assistant" \| "card", text, turnId?, card? }`（规则见 §4.4）；`card`（仅 `role: "card"`）= `{ taskId, title, status, summary, round, progress?, question? }`，`status` 可为 `needs_input`（此时 `summary` 就是问题），`round` 从 1 开始，`progress` 只在任务进行中出现，`question` 只在 `needs_input` 时出现；`tasks` 来自 `app.handoffs`，形状同 `task.graph`（§7.3）；`pendingReports` = `[{ id, title }]`。`empty` 会话不开库，返回空。`not_found` |
| `session.rename` | `{ sessionId, title }` | `{}` | 写 `app.session` 与索引；未建库的只改索引 |
| `session.delete` | `{ sessionId }` | `{}` | 时序见 §2.2。`not_found` |
| `chat.submit` | `{ sessionId, turnId, text }` | `{ requestId }`（受理即返回，回合进度走事件） | 步骤：`await stopping` → 打开会话（`empty` 的此时建库）→ 遗留 run 先 `abort` → 同步模型选择 → 写记忆条目 → 事件桥登记 `turn:<turnId>` → `submit({ type: "input", requestId, whenBusy: "reject" })`。`busy`（abort 之后仍忙）、`not_found`、`closed`。（§12 V4 通过后在"写记忆条目"之后增加挂起汇报的静默写入，届时加 `reportProactive` 参数） |
| `chat.abort` | `{ sessionId }` | 应答 `aborted` | `conversation.abort()`；不影响后台子代理；幂等，会话未打开也成功 |
| `report.deliver` | `{ sessionId, id, turnId }` | `{ status: "started" \| "already" \| "missing", card? }` | 步骤与应答见 §4.3。`card` 同 `session.load` 的 `card`。`busy`、`not_found`、`closed` |
| `task.cancel` | `{ sessionId, taskId }` | `{ status: "cancelling" \| "terminal" }` | 置 `cancelRequested`，由 Reporter 对子对话 `abort()`；只更新 `app.handoffs` 与卡片，不写 outbox（工具约束 §3.4）。`needs_input` 的任务没有 Reporter，当场置 `cancelled` 并撤回还没投递的提问汇报。`not_found` |
| `task.approve` | `{ sessionId, taskId, approvalId, allow }` | `{}` | 按 `taskId` 在 `app.handoffs` 查到子对话，写该子对话的 `app.approvals[approvalId]`；写入前核对该项存在、`state === "pending"` 且未过期，重复点击、过期点击都按 `not_found`（已处理或已过期）应答。键用 `approvalId` 而不是 `callId`；单凭 `approvalId` 找不到子对话，所以必须带 `taskId` |
| `memory.list / write / delete / accept / reject / clear / status / configure` | 见记忆 §8.1 | 见记忆 §8.1 | 记忆道。`memory.configure { enabled?, recall? }` 热生效；`memory.open-folder` 由主进程处理，不转发 |
| `model.list` | `{ sessionId? }` | `{ models: [{ value, label }], current, thinkingLevel, thinkingLevels }` | 原 `models`。`sessionId` 缺省或未打开时取全局默认 |
| `model.set` | `{ sessionId?, model, thinkingLevel? }` | 同 `model.list` | 原 `set-model`。写 `~/.amadeus/pi/settings.json` 三键；已打开会话在下一次 `chat.submit` 时 `configure`。`invalid` |
| `reload` | — | `{}` | 等所有会话空闲 → `modelRuntime.refresh({ allowNetwork: false })` → 校验当前选择。**不重开存储**；ROLE.md 变化不需要 reload（section 每次请求重新渲染） |
| `checkpoint` | — | `{}` | 关闭全部 Harness，进入 closed 状态（§2.2）。幂等 |
| `resume` | — | `{}` | 离开 closed 状态；会话懒重开 |

原命令名映射：`prompt` → `chat.submit`，`abort` → `chat.abort`，`models` → `model.list`，`set-model` → `model.set`，`checkpoint`、`reload` 不变（语义见上）。

### 7.3 事件（worker → 主）

| 事件 | 载荷 | 说明 |
| :--- | :--- | :--- |
| `turn.text` | `{ sessionId, turnId, kind, delta }` | 清洗后的文本差量；一批 durable 事件合成一条 |
| `turn.tool` | `{ sessionId, turnId, kind, tool, done }` | 工具开始 / 结束。字段叫 `tool` 而不是 `name`：`name` 是事件封包的事件名，同名会被覆盖 |
| `turn.done` | `{ sessionId, turnId, kind, text }` | `text` 是整个 run 清洗后的全文，主进程只在从未收到 `turn.text` 时使用（现有 `receivedText` 的兜底） |
| `turn.error` | `{ sessionId, turnId, kind, code, error }` | `code` 为 durable 的 reason 或 `worker_exit`（由 PiHost 合成） |
| `turn.aborted` | `{ sessionId, turnId, kind }` | 终止事件三选一，每个回合恰好一条；本地已 `cancelTurn` 的回合，主进程忽略 |
| `task.graph` | `{ sessionId, tasks: [{ taskId, kind, title, status, round, progress?, question? }] }` | `status` ∈ queued / running / done / failed / timeout / cancelled / **needs_input**，来自 `app.handoffs`（与 `watchTaskGraph()` 合并）；任务卡片的数据源。`round` 从 1 开始、始终有；`progress` = `{ text, at }`，仅进行中且子代理写过 `report_progress`；`question` 仅 `needs_input`。状态、轮次、问题的变化立即推；**只有 `progress` 变了的更新按 15 秒节流**（间隔内合并，间隔结束时推最新一条）。`session.load` 的 `tasks` 同形 |
| `task.report-ready` | `{ sessionId, id, title, status, round }` | `status` ∈ done / failed / timeout / **needs_input**（取消不进 outbox）；`id` 第 1 轮与 `taskId` 同值，之后是 `<taskId>.<n>`；只对新增的 pending id 发，会话打开时对现存 pending 重放 |
| `task.approval-request` | `{ sessionId, taskId, approvalId, summary, detail, expiresAt }` | 子对话 `app.approvals` 新增 `pending` 项时发。主进程缓存各会话的待确认数：非当前会话在会话列表上标红点；窗口无焦点时发系统通知"有操作等待确认"（工具约束 §4.3） |
| `task.approval-resolved` | `{ sessionId, taskId, approvalId, state }` | 该项离开 `pending`（`allow` / `deny` / `expired`）时发，卡片据此收起按钮、主进程减红点。**重启时作废的项也会通知**，来源有两处：① worker 打开会话时，对账作废发生在事件桥挂 `app.approvals` 监视之前（§2.2 打开时序第 5、7 步），监视看不到这次变化，所以 SessionHost 在对账前记下 `pending` 项、对账后**为每一项补发 `state: "expired"`**；② 主进程在 `worker.ready` / `worker.down` 时，对缓存里未决的确认各发一条 `expired` 再清空缓存（worker 倒下后没人再等这些确认）。渲染进程据此收起旧卡片 |
| `session.updated` | `{ sessionId, title, updatedAt, hasActive, pendingReports }` | 索引变化。主进程据此刷新列表；标题变了就转成渲染进程的 `session.titled`。（不叫 `session.changed`：那是渲染进程"当前会话切换"的事件） |
| `memory.changed` | `{ reason, ids? }` | `reason` ∈ `manual` / `tool` / `extract` / `external` / `clear`；主进程转成 `next.event` 发给渲染进程，设置页据此刷新 |

`kind` ∈ `"user"` / `"report"`。事件保序；`postMessage` 无确认，丢失只发生在进程死亡时。

### 7.4 错误码与超时

| code | 含义 |
| :--- | :--- |
| `busy` | `ConversationBusy` |
| `not_found` | 会话、任务或汇报不存在 |
| `closed` | worker 已 `checkpoint`，或该会话正在关闭 |
| `invalid` | 参数不合法（含 `sessionId` 不符合 §6 的规则） |
| `model_error` / `no_model` / `faulted` / `reset` | durable 的 unanswered reason，用于 `turn.error` |
| `worker_exit` | PiHost 合成：命令在途时 worker 退出 |
| `failed` | 其它 |

| 命令 | 超时 |
| :--- | :--- |
| 默认 | 60 秒（沿用 `PiHost.command`） |
| `chat.submit`、`report.deliver` | 15 秒（只到受理；原 `prompt` 的 0 即不超时，取消） |
| `session.delete`、`checkpoint` | 30 秒 |
| `model.list`、`model.set` | 20 秒（内部网络刷新 15 秒） |
| worker 启动 | 20 秒（沿用） |

### 7.5 渲染进程接口映射

| 渲染进程方法 / 事件 | 现状 | 迁移后 |
| :--- | :--- | :--- |
| `session.list` | 读 `SessionStore`，返回 `messages` | worker `session.list` 加旧会话分组；条目 `{ id, title, readonly?, pendingReports?, pendingApprovals? }`（后者来自主进程缓存，用于红点）；`messages` 来自 `session.load` |
| `session.create` / `session.load` | 同步改 store | 转发；仍返回 `ok`、`client_request_id`、`source: "next"`，并发 `session.changed`（形状不变） |
| `session.rename`、`session.delete` | 无 | **新增**，界面待做；首次发消息后的时间戳标题仍由主进程 `session.rename` 产生，并发 `session.titled` |
| `chat.send` | `PiHost.prompt` | `chat.submit`；旧会话回 `{ ok: false, error: "legacy session is read-only" }` |
| `chat.abort` | 渲染进程无调用方 | A2 加停止按钮 |
| `pi.models` / `pi.model.set` | worker `models` / `set-model` | `model.list` / `model.set`；回合进行中与重载期间仍回 `Wait for the current reply or reload to finish` |
| `runtime.reload`、`runtime.status` | 沿用 | 沿用；`reloading` 期间所有转发给 worker 的方法回 `Runtime reload pending` |
| `chat.composing { active }` | 无 | **新增**，渲染进程在草稿状态变化时上报，供 Floor 闸门使用（§4.2）；主进程自己消化，不转发 worker |
| `task.cancel`、`task.approve` | 无 | **新增**，转发。`task.approve` 带 `taskId`、`approvalId`、`allow` |
| `memory.*` | 无 | **新增**，转发给记忆道；`memory.open-folder` 由主进程处理 |
| 事件 `chat.token / complete / error / interrupted` | 沿用 | 沿用；汇报回合带 `kind: "report"` |
| 事件 `session.changed`、`session.titled` | 沿用 | 沿用 |
| 事件 `task.graph`、`task.report`、`task.approval-request`、`task.approval-resolved`、`memory.changed` | 无 | **新增**。`task.report` = 汇报开始时的卡片数据 `{ sessionId, turnId, taskId, title, status, summary, round?, question? }`（`status` 可为 `needs_input`）；确认用请求 / 已处理两条事件（`task.approval-request` 带 `approvalId`、`detail`、`expiresAt`），`memory.changed` 带 `reason` |
| 事件 `voice.event` | 沿用 | 不变 |

worker 的环境变量（`index.ts` 的 `fork`）：沿用 `PI_CODING_AGENT_DIR`、`AMADEUS_NEXT_PI_CWD`、`AMADEUS_NEXT_PI_AUTH`、`AMADEUS_NEXT_PI_MODELS`、代理三项、`AMADEUS_JEV_*`；`AMADEUS_NEXT_PI_SESSIONS`（旧 jsonl 目录）不再使用；新增 `AMADEUS_NEXT_SESSIONS`（`<userData>/sessions`）、`AMADEUS_MEMORY_DIR`、`AMADEUS_SEARCH_PROVIDER` / `AMADEUS_SEARCH_API_KEY`（设置项 `web_search_provider` / `web_search_api_key`）、**`AMADEUS_DELEGATION_MODEL`**（设置项 `delegation_model`，`provider/model`，空 = 与对话模型相同）。这些在 `fork` 时读取，`piEnv()` 变化会触发 `pi-worker` 重载。`fork` 时 `AMADEUS_DELEGATION_MODEL` 总是被显式设置（设置页留空就是空串）：设置页是委托模型的唯一来源，继承来的同名环境变量不能悄悄生效。worker 里 `delegationModelFromEnv` 只在第一个斜杠处切（模型 id 里可以有斜杠），格式不对一律当作没设置。**记忆开关与召回模式不放环境变量**，走 `memory.configure`（§5）。

---

## 8. 里程碑

| 阶段 | 内容 | 依赖 | 对应原文档 |
| :--- | :--- | :--- | :--- |
| **P0 原型** | 一会话一 Harness + 现有 ModelRuntime + `amadeus-role` + 最小 handoff（写 outbox）+ 最小快照与一次 `replace` 重新冻结 + `checkpoint` 关库 + 最小 `pathGuard` 与 `bash` 环境清理（子代理的占位工具也不能碰绝对路径和 worker 的环境变量），跑评估文档的 P1~P12 与 S1~S4，并验证 §12 的 V1~V4 | 无 | 评估 §4 |
| **A1 运行时切换** | `pi-worker` 改用 SessionHost；事件桥；会话管理迁到 worker（索引、懒创建、删除、历史渲染）；进程锁；旧会话只读分组；`PiHost` 长连接事件、自动重拉、保留 `error.code`、`resume`；`flushReload` 只在重启时 `checkpoint`；`package.json` 依赖；`test/turn-lifecycle.test.mjs`、`test/pi-reload.test.mjs` 随接口迁移（fake `PiHost` 补事件，`openPiSession` 用例删除） | P0 | 评估 §3 |
| **A2 话筒与委托** | Floor 状态机（抽成 `floor.ts`）、汇报信箱（pending / delivered）、汇报回合、`report_proactive` 设置项与 `chat.composing`、任务卡片、停止按钮；`research` 子代理（`web_search` 后端见 §12 待决）；每会话并发与超时 | A1 | 工具约束 §3、§4；本文 §4 |
| **A3 记忆 M1** | MemoryStore、快照 / 增量 / 重新冻结条目、`remember` / `forget`、设置页核心记忆 | A1 | 记忆 M1 |
| **A4 记忆 M2** | 后台抽取任务（`app.memory-extract`）、待确认列表、拒绝记忆；`beforeCompact` 剔除记忆块并自带陪伴向压缩提示词（可选） | A3 | 记忆 M2 |
| **A5 动手类子代理** | `files`、`task` 类型；完整 `pathGuard` 与拒绝列表、`bash` 环境清理；确认界面（`task.approval-request` / `task.approval-resolved`）与 `wrapTool` 确认；`files` 的授权路径取自 `handoff.paths`，首次授权不弹确认（工具约束 §6） | A2 | 工具约束 §4.2、§4.3 |
| **A6 记忆 M3** | 情景日记与保守召回 | A4 | 记忆 M3 |
| **A7 handoff v2** | `handoff_send`（续接 / steer / 回答提问）、`handoff_status`、子代理 `report_progress`、轮次与 `needs_input`、委托专用模型 `delegation_model`；`task.graph` / `task.report-ready` / 卡片补 `round`、`progress`、`question` | A2、A5 | 工具约束 §3.7 |

A2 和 A3 可以并行。

### 关键验收（贯穿各阶段）

1. 主对话请求的 tools 只有 `remember` / `forget` / `handoff` / `handoff_send` / `handoff_status` / `handoff_cancel`，会话内逐字节不变。
2. 真实 Anthropic 模型连续 20 轮，第 2 轮起 `cacheRead / input ≥ 80%`。
3. `partialIntervalMs: 30` 下，首包延迟相比现状的中位数差距 ≤ 100ms。
4. 委托后主人继续聊天不受阻塞；子代理完成后，红莉栖在主人没说话、语音也没在播放时才开口汇报。
5. worker 在子代理运行中被杀掉，重启后汇报仍然送达且只送达一次。
6. 字幕、TTS、界面记录中搜不到任何 `amadeus_*` 标签；汇报回合显示为卡片而不是用户气泡。
7. `runtime.reload` 的 pi-worker 路径下，旧 worker 关库后新 worker 才打开，无 `SQLITE_BUSY`；替换进程启动失败时，旧 worker 经 `resume` 继续可用。
8. 后台子代理运行中删除会话：任务中止、目录删除，在删除的任一步被杀后重启都不复活，`.trash` 被清空。
9. 话筒：`hearing` 时汇报不开口；`armed`（开麦但没人说话）时，汇报经 500ms 防抖抢占，播完 1 秒后恢复监听；回合期间语音无法打断，文本发送可以。
10. 汇报只投递给当前会话；其它会话的汇报以徽标提示，切过去之后才开口。
11. worker 意外退出：30 秒内自动重拉，遗留 run 被中止而不是静默续跑，`pending` 汇报继续投递；连续失败 5 次后停止重拉。
12. 空闲 10 分钟的会话被关闭，重开后对话与任务状态完整；删除 `index.json` 后能从各库的 `app.session` 重建。
13. 重启后的界面历史与重启前一致：字幕文本（`display`）而不是带标签的原文，汇报显示为卡片；被打断的半截回答不在历史里。
14. 子代理环境：`bash` 里看不到 `AMADEUS_JEV_API_KEY` 与代理变量；`read` / `write` 对任务目录与授权根之外的绝对路径、对拒绝列表里的路径一律被 `pathGuard` 拒绝（P0 即验）。
15. 两个 worker 不会同时持有存储：`checkpoint` 失败后等旧进程 `exit` 才拉新进程；人为留一个存活 pid 的 `.lock`，新 worker 在 10 秒内不开库并报错。
16. 取消任务（`handoff_cancel` 或卡片）：子代理停止，卡片更新，outbox 里没有汇报，红莉栖不会再开口；主动汇报关闭时，汇报留在 pending、只显示卡片，红莉栖不开口（V4 通过后改为下一次开口时随回合带出）。
17. 输入框有草稿（最近 30 秒内有键入）时，汇报不开口；草稿清空或超时后才投递。
18. 委托可续接、可查询、可提问（工具约束 §5 验收 13~17）：任务完成后追问走 `handoff_send` 开新一轮，同一个 `task_id` 出现第二份汇报；子代理以 `QUESTION:` 收尾后任务进入 `needs_input`，红莉栖转问主人，答案经 `handoff_send` 回传；主人问进展时用 `handoff_status`，不猜测；`report_progress` 推到界面的更新 15 秒内至多一次；配置委托专用模型后子对话用它而主对话不变，模型不可用时回退并在卡片上留备注。
19. 重启时作废的确认不留僵尸卡片：任务等待确认时杀掉 worker 再打开会话，渲染进程收到该确认的 `task.approval-resolved { state: "expired" }`；`worker.down` / `worker.ready` 时缓存里的未决确认同样收到 `expired`。
20. 汇报 `deferred`（worker 在重启或没应答）时按 1、2、4、8、16、30 秒退避，不空转；回合连续 120 秒没有任何 `turn.*` 事件，看门狗中止并按被打断收尾，Floor 回到空闲。
21. 记忆写入的来源受控：`remember` 的引用一两个字、或与正文无关时被拒绝（`quote_too_short` / `quote_unrelated`）；汇报回合里 `remember` / `forget` 一律返回错误且不写入、不删除。
22. 确认卡完整展示：`bash` 命令 > 2000 字符、`write` 内容 > 20000 字符、`edit` 展开后的预览 > 20000 字符直接被拒，不进确认；`web_fetch` 对域名在校验后改答案（DNS 重绑定）的情形仍只连校验过的 IP；`pathGuard` 拒绝 userData、sessions、记忆目录、agent 目录与悬空符号链接。

原型期专项（评估 §4.2）：S1 崩溃后不重放主回合；S2 多库常驻开销；S3 事件桥背压与故障隔离（溢出后字幕不重复不丢失，监听器抛错不终止流）；S4 角色热更新随模型变化。

---

## 9. 与现状的行为差异

迁移后用户或开发者会感知到的变化，需要在验收或发布说明里交代：

| 项 | 现状 | 迁移后 |
| :--- | :--- | :--- |
| 流式粒度 | 逐 token | 每 30ms 一批 |
| 角色热更新 | 改 ROLE.md 后 `reload`，system prompt 整体重写 | 不需要 reload；section 每次请求重新渲染，变化作为位置化 system 条目写入。**行为随模型而变**：`compat.supportsMidConvoSystemMessages` 为 true 的模型原样追加，旧文本仍在上下文里，缓存前缀得以保留；其余模型把所有 system 补丁折叠进开头的系统提示，旧文本消失、缓存前缀整体失效，等于现状的"整体重写"。角色需要彻底重来时开新会话（S4 验证） |
| 会话存储 | 一个 JSON 加一堆 jsonl | 每个会话一个目录；删除会话是删目录 |
| 新建会话 | 立即写入列表 | 懒创建：发第一条消息时才建目录与库；从未使用的空会话在下次启动时清掉 |
| 旧会话 | 可继续 | 只读，单独一组 |
| 界面历史 | `SessionStore` 存的字幕文本 | 从 durable 条目重建，assistant 文本经 `PresentationText` 取字幕通道 |
| worker 内存 | — | 与 `pi-coding-agent` 同进程时仅多约 +4MB（TypeBox 已被加载；README 的 23MB 不适用于本项目）；每个空闲会话库另加约 0.3MB 与 3 个 fd |
| 打断 | `session.abort()`，被打断的半截回答不进历史 | `conversation.abort()`：撤回排队输入，半截回答落成 `stopReason: "aborted"` 的 assistant 条目；它不进模型上下文，界面历史也不显示（与现状一致） |
| worker 崩溃 | 当前回合报错；下一条命令才惰性重拉 | 主动重拉；遗留 run 被中止；子代理与汇报不丢 |
| 模型默认值 | `SettingsManager` 写 `settings.json` | worker 直接读写同一文件的三个键 |

---

## 10. 文档地图

| 文档 | 版本 | 负责 | 与本文的关系 |
| :--- | :--- | :--- | :--- |
| `architecture.md` | v3 | 进程分工、存储、话筒仲裁、接口、里程碑、决定汇总 | — |
| `long-term-memory.md` | v6 | 记忆分层、证据契约、注入与缓存契约、记忆工具、抽取、召回 | 实现本文 §5 |
| `pi-tool-constraints.md` | v3 | 主对话与子代理的工具集、工具定义规则、handoff 生命周期、写操作确认 | 实现本文 §3、§4.3 |
| `archive/pi-durable-evaluation.md` | 2026-10-11 核实版（已归档） | 运行时评估、迁移代价、P0 原型验收、源码依据 | 本文的前提；迁移已完成，仅作依据查阅 |

- git 历史里只有 `45ffaa3` 一个提交带这四份文档，且已是 pi-durable 版（记忆 v5、工具 v2、架构 v2）。**pi-coding-agent 版（记忆 v4、工具 v1）没有入库**，所以 §11 的退路不依赖历史文档，直接写在本文里。
- 原型结束后：评估文档补实测结果；设计文档按实测修正（重点是首包延迟、缓存命中率、§12 的待验证项）。

---

## 11. 退路

如果 P0 原型的首包延迟或缓存指标不达标，并且无法通过 `settings.progress`、`cacheRetention` 解决，继续使用 `pi-coding-agent`（1.1.0，已在依赖里）。本文 §4 的话筒仲裁与汇报信箱照样适用，§1、§3.1、§5、§6 的分工不变。只有存储与任务的实现方式换掉：

| 项 | pi-durable 方案 | 退路 |
| :--- | :--- | :--- |
| 运行时 | Harness | 沿用现有 `createAgentSession`（`noTools: "builtin"` 去掉内置工具，`customTools` 装 `remember` / `forget` / `handoff` / `handoff_send` / `handoff_status` / `handoff_cancel`；`systemPromptOverride` 渲染角色） |
| 会话存储 | `sessions/<id>/durable.sqlite` | 沿用 Pi jsonl（`piSessions.ts`）；界面历史仍由 `SessionStore` 之外的 jsonl 重建 |
| 汇报信箱 | `app.outbox` 文档 | worker 内自建的 SQLite 表（`node:sqlite`），`pending` / `delivered` 语义不变 |
| 汇报投递 | `submit` 加 `requestId` | `sendCustomMessage`（以 `role: "user"` 送给模型）；幂等靠 outbox 表自己的 `delivered` 记录 |
| 子代理与任务 | Anchor / Reporter 后台任务 | worker 内自建任务表与调度；崩溃后按表恢复 |
| 记忆注入 | 自定义条目、`replace` + `omit` | 快照钉在首条 user 消息上，`injections` 与 `session_baseline` 表，`context` 事件重放 |
| 回合后抽取 | 后台任务 | 事件订阅里的普通异步任务，以计划哈希防重 |

也就是说，**话筒仲裁、委托分工、记忆策略与运行时选型无关**，只有存储与任务的实现方式取决于原型结论。

---

## 12. 决定记录

### 已定

| # | 问题 | 决定 | 依据 |
| :--- | :--- | :--- | :--- |
| 1 | 是否接受 pi-durable 的实验性依赖 | 接受，`package.json` 锁定 `1.1.0` 精确版本，升级前读 CHANGELOG | 评估 §0 |
| 2 | 历史会话 | 只读保留，不迁移 | 评估 §3 |
| 3 | 记忆注入方式 | 自定义条目；重新冻结用 `replace` + `omit` | 评估 §2.2 |
| 4 | 存储布局 | 一会话一个存储文件 | durable 没有删除 API（评估 §3.1） |
| 5 | 汇报回合识别 | `requestId` → `SubmissionRecord.entry` → `app.outbox.delivered` | 输入条目一律是 `pi.user`（评估 §2.1） |
| 6 | 流式节流 | `partialIntervalMs: 30` | 第一个 partial 也等满间隔（评估 §2.5） |
| 7 | worker 重启 | `checkpoint` 关库后再拉起新进程；替换失败 `resume` 旧进程 | 单进程独占存储（评估 §3.1） |
| 8 | 角色热更新 | 保持每次请求渲染。"追加、保住缓存"只对 `supportsMidConvoSystemMessages` 为 true 的模型成立，其余模型整体折叠重写（缓存失效），接受 | 评估 §2.4、S4 |
| 9 | 子代理完成后 | 话筒空闲时主动汇报，设置可关闭 | 工具约束 §6 |
| 10 | 子代理模型 | 默认沿用对话模型；可选的委托专用模型见 #32 | 工具约束 §6 |
| 11 | 第一版子代理类型 | 只做 `research` | 工具约束 §6 |
| 12 | `handoff_cancel` | 加，语音取消更自然 | 工具约束 §6 |
| 13 | 被用户打断的汇报 | 不重投，由红莉栖自然提及 | 本文 §4.2 |
| 14 | 记忆默认开启、只注入 reviewed、快照 3KB、委托为主 | 已定 | 记忆 §10 |
| 15 | 汇报的投递对象 | 只投递给当前会话；其它会话用徽标提示 | 本文 §4.3 |
| 16 | 话筒仲裁的粒度 | 区分 `armed`（开麦没人说话）与 `hearing`；`armed` 时汇报可经 500ms 防抖抢占 | 本文 §4.2 |
| 17 | 崩溃后遗留的根对话 run | 打开会话时中止，不静默续跑 | 本文 §2.2 |
| 18 | 删除会话 | 先 `rename` 到 `.trash`，再改索引，最后清理 | 本文 §2.2 |
| 19 | 新建会话 | 懒创建，首条消息时才建目录与库 | 本文 §2.2 |
| 20 | `checkpoint` 与 `resume` | `checkpoint` 才关库，只在重启或退出时发；`pi` 单独重载走 `reload` | 本文 §2.2 |
| 21 | worker 崩溃 | PiHost 主动退避重拉，连续失败 5 次后回到惰性重拉 | 本文 §2.2 |
| 22 | 单进程独占存储 | 应用层保证：`checkpoint` 先于拉起、失败则等旧进程 `exit`、`sessions/.lock` 进程锁。不靠 `busy_timeout` | 评估 §3.1 |
| 23 | `handoff` / `handoff_send` / `handoff_cancel` 成功后 | 返回 `terminate`，红莉栖说完前置话就收口；`handoff_status` 只读，不 `terminate` | 工具约束 §2.3 |
| 24 | 子代理并发 | 每会话 2（一会话一库，没有跨库计数） | 工具约束 §3.2 |
| 25 | 执行环境 | `cwd` 不是沙箱：`pathGuard` + 拒绝列表 + `bash` 的 `inheritEnv = false`，P0 即做 | 工具约束 §4.1 |
| 26 | `files` 的首次授权 | 不弹确认。`handoff.paths` 来自模型，靠拒绝列表强制、卡片展示授权路径；`files` 只读且结果只回主对话。主人要更谨慎时改为首次弹一次 | 工具约束 §6 |
| 27 | 写操作确认 | 只能由界面点击；`app.approvals` 挂子对话，键为 `approvalId`，定位靠 `taskId`；事件为 `task.approval-request` / `task.approval-resolved` | 工具约束 §4.3 |
| 28 | 记忆开关 | 走 `memory.configure` 命令，不经 `piEnv()` | 记忆 §8.1 |
| 29 | 取消任务 | 不生成汇报，只更新 `app.handoffs` 与卡片 | 工具约束 §3.2、§3.4 |
| 30 | `report.deliver` 遇 `busy` | 汇报留在 pending，1 秒后重试，最多 5 次，之后等下一次 `pump()` | 工具约束 §3.5 |
| 31 | 委托的后续动作（handoff v2） | 主对话工具集增至六个：`handoff_send`（续接 / steer / 回答子代理的问题）、`handoff_status`（只读查看）。任务有轮次，每轮各有自己的 Reporter 与汇报；`needs_input` 不占并发名额。新增主对话工具的理由：续接与查询必须指向同一个子对话，重新 `handoff` 会让子代理从零开始、主人问进展时只能猜 | 工具约束 §3.7 |
| 32 | 委托专用模型 | 设置项 `delegation_model`（`provider/model`，空 = 与对话模型相同），经 `AMADEUS_DELEGATION_MODEL` 传给 worker；不可用时回退对话模型并留备注，不让任务失败。取代 #10 的"子代理沿用对话模型"成为可选项，缺省行为不变 | 工具约束 §3.7 |
| 33 | 重启时作废的确认 | 一律向渲染进程通知 `expired`：worker 打开会话时由 SessionHost 补发，主进程在 `worker.ready` / `worker.down` 时对缓存里的未决项补发。不靠"卡片靠 `session.load` 刷新" | 本文 §2.2、§7.3 |
| 34 | 汇报 `deferred` 与回合挂住 | 信箱级退避 1/2/4/8/16/30 秒；回合 120 秒无 `turn.*` 事件由看门狗收尾 | 本文 §4.2 |
| 35 | 记忆写入的来源控制 | `remember` 的引用过三关（找得到、够长、撑得起正文）；汇报回合里 `remember` / `forget` 禁用；两者都在工具层 / 闸门里做，不靠 prompt | 记忆 §3.2、§3.3 |
| 36 | 确认卡展示与 `web_fetch` | 确认卡展示完整命令 / 内容，超限直接拒绝而不截断；`web_fetch` 固定校验过的 IP；`pathGuard` 以宿主显式 deny 为准并拒绝悬空符号链接；进程锁核对启动时间防 pid 复用 | 工具约束 §4.1、§4.3、§4.4；本文 §6 |

#### 第一版默认（主人可改）

| # | 问题 | 默认 | 备注 |
| :--- | :--- | :--- | :--- |
| D1 | 输入框有草稿时，汇报是否延后 | **延后**：渲染进程上报 `chat.composing`（草稿非空且 30 秒内有键入），主进程不发 `report.deliver` | 超时由渲染进程自己置回，避免汇报永远发不出 |
| D2 | `report_proactive` 关闭后，积压汇报怎么办 | 留在 pending、只显示卡片，红莉栖不主动开口。目标是下次开口时随回合带出，机制（静默 `write` 条目）待 V4，通过后启用 | 取消的任务没有汇报，不在此列 |
| D3 | 崩溃后遗留的根对话 run | 打开会话时中止，不静默续跑 | 见 §2.2 |
| D4 | 非当前会话完成了汇报 | 只打徽标，不发系统通知 | — |

### 可调的默认值

| 项 | 默认 | 何时改 |
| :--- | :--- | :--- |
| `cacheRetention` | `"long"` | 若账单显示长保留的写入成本明显高于读命中收益，改回 `"short"` |
| SessionHost 空闲关闭时限 | 10 分钟 | 与 `contextRetentionMs` 无关，按内存占用调整 |
| 子代理超时 / 并发 | 5 分钟（活跃时间）/ 每会话 2 | 按 `research` 子代理的实测时长调整 |
| 委托专用模型 | 空（与对话模型相同） | 想让后台任务用更便宜或更强的模型时在设置页填 `provider/model` |
| `task.graph` 进度节流 | 15 秒 | 界面刷新太频繁或太迟钝时调 `limits.progressIntervalMs` |
| 主动汇报 | 开 | 设置页开关 |
| 汇报防抖（`armed` 抢占） | 500ms | 主人反映被抢话就调大 |
| `report.deliver` 遇 `busy` 重试 | 1 秒 × 5 次，再等下一次 `pump()` | — |
| `deferred` 退避 | 1、2、4、8、16、30 秒（封顶 30 秒，信箱级） | — |
| 回合看门狗 | 120 秒无 `turn.*` 事件 | 慢模型的首包 / 长工具调用常超过它时调大 |
| 草稿延后的活跃窗口 | 30 秒 | 渲染进程判定 |
| SessionHost 并存上限 | 16 | 随 S2 实测的 fd 与 RSS 调整 |
| worker 自动重拉退避 | 1s → 30s 封顶，连败 5 次放弃 | — |
| 命令超时 | 见 §7.4 | `checkpoint` 随原型实测调整 |

### 待原型验证

这些结论只来自源码阅读或评估文档的单项实测，没有在本应用里跑通；P0 原型一并验证，结果补进评估文档。评估已实测的不再列：开库不调度、`abort` 先于 `resume` 不发模型请求（S1）、多库开销（S2）、双进程中毒。

| # | 问题 | 为什么要验证 |
| :--- | :--- | :--- |
| V1 | 流式中途失败后重试：失败的那条 assistant 消息（`stopReason: "error"`）已被事件桥转发，重试从头再来，会重复播报。是降 `retry.maxRetries`，还是在 `auto_retry_start` 时让主进程重置字幕与 TTS | 语音场景下重复播报很显眼 |
| V2 | 在两次提交之间 SIGKILL：对账后 `delivered` 与遗留 run 的状态是否一致；`submit` 返回 `queued` 的出现概率与 `entryId` 补记 | 评估 P5 的扩展；§4.3 的 `queued` 特例 |
| V3 | 进程锁：存活 pid 的判定、`checkpoint` 后释放与 `resume` 重取的时序、开发热重载（退出码 75）时旧 worker 未死的情形 | §2.2 的单进程独占只靠它兜底 |
| V4 | 静默 `write` 条目（自定义 kind，model 为围栏文本的 user 消息）承载汇报：与相邻 user 消息连续出现时，经 pi-ai 转换后的消息序列对 Anthropic 与 OpenAI 兼容端点都合法；对缓存前缀的影响 | `report_proactive` 关闭时"下次开口随回合带出"，以及可能的取消通知，都依赖它（工具约束 §3.3、§3.5 引用本条；同类问题见其待验证清单 7） |

### 待主人决策

| # | 问题 | 备注 |
| :--- | :--- | :--- |
| ~~Q1~~ | ~~`research` 子代理的 `web_search` 后端~~ | 已定：设置页可选 Brave / Tavily（`web_search_provider`），未配置时如实返回未配置（工具约束 §4.4） |

前面"第一版默认"里的 D1~D4 已按默认写入，主人可以改，不阻塞开工。
