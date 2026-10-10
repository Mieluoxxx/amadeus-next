# Fish Audio 声学情感集成

口播文本在发给 Fish Audio 前带上语音标签，让声音随表情变化；字幕与表情的时间轴仍以不含标签的文本为准。
传输层（WebSocket、MessagePack、24 kHz PCM、对齐时间戳、AudioWorklet 口型）不变。

## 改造前的问题

`PresentationText` 只识别 `[EMO preset=...]`，剥离后把纯日文发给 Fish；提示词也禁止在 `<jp>` 中写任何标注。
立绘切到害羞或生气时，声音仍是模型按文本推断的默认语气。

## 标签的性质

S2 / S2.1 把中括号内容当作**普通文本里的自然语言描述**，不是固定的控制枚举：
`[sigh]`、`[whisper]`、`[laughing nervously]` 都可以，可放在句首或句中任意位置。
`../fish-audio-emotions.md` 中的标签表只是推荐写法，不是完整清单。
标签作为文本传输，按文本计入请求；未见官方「标签不计费」的说法。

## 数据流

```text
LLM 流式输出  <zh>字幕</zh><jp>[EMO preset=shy][sigh]ふん、バカね。</jp>
      │
      ▼
PresentationText.push()
      ├─ text    ふん、バカね。           → AlignmentTimeline（cue / 字幕偏移）
      ├─ speech  [sigh]ふん、バカね。     → FishTts.push()
      ├─ cues    [{ offset: 0, emotion: 'shy' }]
      └─ display 字幕
```

- `PresentedText.speech` 是实际发给 TTS 的文本；`text` 不含任何标签，cue 与字幕偏移都按它计算。
- `appRuntime.runChat` 以 `value.speech` 驱动合成；渲染端时间轴仍消费 `value.text`。

## 解析规则（`src/shared/presentation.ts`）

1. **语音标签**：在 `<jp>` 与块外口播文本中，`[` 后接 1–40 个英文字母、空格、`'`、`-` 并以 `]` 结束的片段视为语音标签，只进入 `speech`，不进入 `text` / `display`。
2. **不误伤**：日文方括号（`[注意]`）、Markdown 链接（`[x](url)`，需看到下一个字符才判定）、代码块和反斜杠转义内容保持原样。
3. **兜底语气**：某句只有 `[EMO]` 而没有语音标签时，在该句第一个非空白字符前补一个标签：

   | 表情 | 补充标签 |
   | :--- | :--- |
   | `neutral` | 不补，避免长回复每句都压成同一种平淡语调 |
   | `smile` | `[happy]` |
   | `thinking` | `[hesitant]` |
   | `serious` | `[serious]` |
   | `sad` | `[sad]` |
   | `shy` | `[embarrassed]` |
   | `surprise` | `[surprised]` |
   | `angry` | `[angry]` |

   模型自己写了语音标签时不再补充，标签写在 `[EMO]` 前后都一样。
4. 以上规则在流式分片的任意切点下结果一致（测试逐切点覆盖）。

## 时间轴对齐

Fish 回传的 `content` 与 `segments[].text` 是否保留标签未见文档说明，两种情况都兼容：
`AlignmentTimeline.reached()` 先按原文匹配本地文本，匹配不到时去掉标签再匹配一次。

## 提示词

默认 `PRESENTATION.md`（`src/main/role.ts`）新增 `## Voice` 一节，允许在 `<jp>` 中每句写一两个语音标签。
`ensurePromptFiles` 只在文件缺失时写入，已有的 `~/.amadeus/pi/PRESENTATION.md` 需手动同步。

## 模型

默认模型为 `s2.1-pro-free`（`fishTts.ts`、`appRuntime.ts`），设置或环境变量中已有的 `FISH_API_MODEL` 优先。
服务端在 model 头缺失或无法识别时回退到 `s2.1-pro`。

## 未做

- **语速 / 音量（`prosody`）**：只能在 `start` 事件中按会话设置一次，无法逐句调整；原方案「按对话状态动态调节」不可行，最多做成固定设置项，暂未实现。

## 验收入口

```bash
npm run typecheck
npm test     # test/presentation.test.mjs：标签分流、兜底语气、字面量保护、对齐兼容
```

实际声音效果需在应用中试听：情绪句语气是否变化、字幕与表情切换是否卡住、界面是否漏出方括号。
