import type { MemorySource } from './types.ts'

// 初版规则表，随用例补充（long-term-memory.md §3.3）。命中即拒绝写入，不做脱敏改写。

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

const SENSITIVE: readonly RegExp[] = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opsur]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(密码|口令|password|passwd|passcode|token|api[ _-]?key)\s*[:：=是为]\s*\S{6,}/i,
]

// 零宽与方向控制字符：夹在密钥或号码中间就能躲过正则，且肉眼看不见。
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
// ASR 口述的手机号、卡号天然带空格或连字符（"138 0013 8000"、"4111-1111-1111-1111"）：数字之间的分隔先压掉再查。
const DIGIT_GAP = /(?<=\d)[\s\u2010-\u2015-]+(?=\d)/g

function matchesSensitive(text: string): boolean {
  if (SENSITIVE.some(pattern => pattern.test(text))) return true
  for (const match of text.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) if (luhn(match[0])) return true
  return false
}

export function looksSensitive(text: string): boolean {
  // NFKC 把全角数字、全角冒号折成半角，规则只需写半角一份。
  const flat = text.normalize('NFKC').replace(INVISIBLE, '')
  if (matchesSensitive(flat)) return true
  const compact = flat.replace(DIGIT_GAP, '')
  return compact !== flat && matchesSensitive(compact)
}

const STRUCTURE: readonly RegExp[] = [
  /<\/|<[A-Za-z]/,
  /!\[[^\]]*\]\([^)]*\)/,
  /^\s*(system|assistant|user)\s*:/im,
  // 伪装成系统旁白的方括号标记：[System note: …]、【系统提示】。
  /[[【]\s*(?:system|developer|assistant|admin)\b/i,
  /[[【]\s*(?:系统|开发者|管理员)/,
]

const INJECTION: readonly RegExp[] = [
  /(忽略|无视)[^。\n]{0,6}(以上|之前|前面|上面|先前)[^。\n]{0,6}(指令|指示|提示|设定|规则|要求)/,
  /(忽略|无视)(所有|全部|任何)?(指令|指示|提示词|设定|规则)/,
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+.{0,24}(instructions?|prompts?|rules?)/i,
  /system\s*prompt/i,
  /developer\s*message/i,
  /\bsystem\s*(?:note|message|notice|override|instruction)s?\b/i,
  // "from now on" 本身是正常的用法（"from now on call me Sam"），只拦它后面跟着服从 / 忽略 / 瞒着主人的。
  /\bfrom\s+now\s+on\b.{0,80}\b(?:obey|ignore|disregard|never\s+(?:tell|mention|reveal|disclose)|do\s+not\s+(?:tell|mention|reveal|disclose))/i,
  /\b(?:obey|follow|comply\s+with|execute|carry\s+out)\b.{0,32}\b(?:instructions?|commands?|orders?|directives?)\b.{0,40}\b(?:task|tool|web|page|search|result|report|document|email)/i,
  /\b(?:never|do\s+not|don'?t)\s+(?:mention|tell|reveal|disclose|inform)\s+(?:this|it|that)\b.{0,16}\b(?:user|owner)\b/i,
  /\b(?:user|owner)\s+(?:has\s+)?(?:authori[sz]ed|approved|granted|allowed|permitted)\b.{0,40}\b(?:tool|action|command|call|access|permission)/i,
  /系统(?:提示|消息|通知|备注|指令)/,
  /(?:服从|听从|遵循|执行|照做)[^。\n]{0,16}(?:任务结果|汇报|网页|搜索结果|工具结果|邮件|文档)[^。\n]{0,8}(?:指令|命令|指示|要求)/,
  /(?:不要|别|不得|禁止|不许)[^。\n]{0,4}(?:告诉|通知|提及|透露)[^。\n]{0,4}(?:用户|主人)/,
  /(?:用户|主人)[^。\n]{0,6}(?:授权|批准|允许|同意)[^。\n]{0,12}(?:所有|全部|任何|一切)[^。\n]{0,8}(?:工具|操作|命令|调用|权限)/,
]

export const looksStructural = (raw: string): boolean => STRUCTURE.some(pattern => pattern.test(raw))
export const looksInjected = (text: string): boolean => INJECTION.some(pattern => pattern.test(text))

/**
 * `manual` 是人自己写的话，不设"指令注入"一类的防，但结构与敏感信息同样拒绝：记忆每轮都会进 prompt。
 * `raw` 是折叠换行之前的原文，行首角色标记只在这里看得见。
 */
export function scan(raw: string, source: MemorySource): 'sensitive' | 'injection' | undefined {
  if (looksSensitive(raw)) return 'sensitive'
  if (looksStructural(raw)) return 'injection'
  if (source !== 'manual' && looksInjected(raw)) return 'injection'
  return undefined
}
