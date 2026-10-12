export type RemoteTarget = {
  /** 模型与界面看到的名字，也是 HandoffItem.target 里钉住的键。 */
  name: string
  /**
   * 连接用的 ssh 命令，如 `ssh -p 2222 me@10.0.0.5` 或只写 `mini`（~/.ssh/config 里的主机）。
   * 拆成参数直接交给 ssh，不经过 shell；见 sshArguments。
   */
  ssh: string
  /** 缺省工作目录，远程路径；`~/` 开头由远程展开。 */
  workspace: string
  /** 远程 node 的命令或绝对路径；用 nvm 等只在交互 shell 里配置 PATH 的机器要写绝对路径。 */
  node: string
}

/** 设置页的 remote_targets 经这个环境变量（JSON）传给 worker；变化触发 worker 重载，目标名进 handoff 的 schema。 */
export const REMOTE_TARGETS_ENV = 'AMADEUS_REMOTE_TARGETS'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
// node 原样拼进远程 shell 命令，只收不需要引号的字符。
const NODE = /^[A-Za-z0-9_./~+-]+$/
// ssh 里带参数的选项（OpenSSH 的 usage 行）：解析时它们后面那个词是参数，不是目标主机。
const SSH_OPTIONS_WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
// 这些选项让 ssh 不开交互会话（转发、查询、控制主连接），runner 就起不来。
const SSH_NO_SESSION = new Set('NfWGVOMn'.split(''))

/** 按 POSIX shell 的引号规则拆词（单引号、双引号、反斜杠），不做任何展开：结果直接当 argv 用。 */
function splitWords(command: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quote: '"' | "'" | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && index + 1 < command.length && '"\\$`'.includes(command[index + 1])) word += command[++index]
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      word ??= ''
    } else if (char === '\\' && index + 1 < command.length) {
      word = (word ?? '') + command[++index]
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else {
      word = (word ?? '') + char
    }
  }
  if (quote) return undefined
  if (word !== undefined) words.push(word)
  return words
}

export type SshArguments = { ok: true; args: string[]; destination: string } | { ok: false; error: string }

/**
 * 把设置里的 ssh 命令拆成 ssh 的参数（不含程序名）。开头的 `ssh` 可省；必须恰好以目标主机结尾，
 * 后面不能再跟远程命令：远程命令由我们拼（部署、启动 runner）。参数直接进 spawn，不经过本机 shell。
 */
export function sshArguments(command: string): SshArguments {
  const words = splitWords(command.trim())
  if (!words) return { ok: false, error: 'the ssh command has an unclosed quote' }
  if (words[0] === 'ssh' || words[0]?.endsWith('/ssh')) words.shift()
  const args: string[] = []
  let destination: string | undefined
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (destination !== undefined) return { ok: false, error: 'the ssh command must end with the host; leave out any remote command' }
    if (word === '--') continue
    if (word.startsWith('-') && word.length > 1) {
      // -p22 与 -p 22 两种写法；-tv 这样的组合布尔选项逐个看。
      for (let at = 1; at < word.length; at++) {
        const flag = word[at]
        if (SSH_NO_SESSION.has(flag)) return { ok: false, error: `ssh -${flag} does not open a session` }
        if (SSH_OPTIONS_WITH_VALUE.has(flag)) {
          if (at === word.length - 1) {
            if (index + 1 >= words.length) return { ok: false, error: `ssh -${flag} needs a value` }
            args.push(word, words[++index])
          } else args.push(word)
          break
        }
        if (at === word.length - 1) args.push(word)
      }
      continue
    }
    destination = word
    args.push(word)
  }
  if (!destination) return { ok: false, error: 'the ssh command needs a host, for example ssh me@example.com' }
  return { ok: true, args, destination }
}

export type ParsedTargets = { targets: RemoteTarget[]; errors: string[] }

/** 规整并校验目标列表。设置页保存时有错就整体拒绝；worker 读环境变量时跳过坏条目，不让一个笔误挡住整个 worker。 */
export function parseTargets(raw: unknown): ParsedTargets {
  const targets: RemoteTarget[] = []
  const errors: string[] = []
  if (raw === undefined || raw === null || raw === '') return { targets, errors }
  if (!Array.isArray(raw)) return { targets, errors: ['remote_targets must be a list'] }
  for (const [index, entry] of raw.entries()) {
    const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    const field = (key: string) => (typeof value[key] === 'string' ? (value[key] as string).trim() : '')
    const name = field('name')
    // host 是早期的字段名，只写主机名；照旧认。
    const ssh = field('ssh') || field('host')
    const workspace = field('workspace') || '~'
    const node = field('node') || 'node'
    const label = name || `#${index + 1}`
    const parsed = ssh ? sshArguments(ssh) : undefined
    if (!NAME.test(name)) errors.push(`${label}: name must be 1-32 letters, digits, dots, dashes or underscores, starting with a letter or digit`)
    else if (targets.some(each => each.name === name)) errors.push(`${label}: duplicate name`)
    else if (!parsed) errors.push(`${label}: the ssh command is empty`)
    else if (!parsed.ok) errors.push(`${label}: ${parsed.error}`)
    else if (!NODE.test(node)) errors.push(`${label}: node must be a plain command or path`)
    else if (/[\u0000-\u001F]/.test(workspace)) errors.push(`${label}: workspace must be a single-line path`)
    else targets.push({ name, ssh, workspace, node })
  }
  return { targets, errors }
}

export function targetsFromEnv(env: NodeJS.ProcessEnv, log: (message: string) => void): RemoteTarget[] {
  const text = env[REMOTE_TARGETS_ENV]?.trim()
  if (!text) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    log(`${REMOTE_TARGETS_ENV} is not valid JSON; remote tasks are disabled`)
    return []
  }
  const { targets, errors } = parseTargets(raw)
  for (const error of errors) log(`skipping remote target ${error}`)
  return targets
}
