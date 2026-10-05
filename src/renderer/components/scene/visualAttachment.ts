/**
 * 图片附件预处理模块。
 * 统一长边限制、JPEG 压缩与体量估算，适配视觉模型上下文并复用主对话链路协议。
 */

const VISUAL_ATTACHMENT_MAX_LONG_SIDE = 1280
const VISUAL_ATTACHMENT_JPEG_QUALITY = 0.82

// 支持直接接收图片输入的多模态模型提供商白名单。
const MULTIMODAL_CHAT_PROVIDERS = new Set([
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-gemini',
])

export function supportsDirectImage(provider: unknown): boolean {
  return MULTIMODAL_CHAT_PROVIDERS.has(String(provider ?? '').trim().toLowerCase())
}

export type VisualAttachment = {
  name: string
  mime: string
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

// 异常标识码，解耦具体文案以交由上层统一国际化。
const ATTACHMENT_ERROR_NOT_IMAGE = 'chat.error.choose_image'
const ATTACHMENT_ERROR_DECODE = 'chat.error.decode_image'
const ATTACHMENT_ERROR_READ = 'chat.error.read_image'
const ATTACHMENT_ERROR_CANVAS = 'chat.error.canvas'

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(ATTACHMENT_ERROR_DECODE))
    image.src = src
  })
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error(ATTACHMENT_ERROR_READ))
    reader.readAsDataURL(file)
  })
}

export async function prepareImageAttachment(file: File): Promise<VisualAttachment> {
  if (!file.type.startsWith('image/')) {
    throw new Error(ATTACHMENT_ERROR_NOT_IMAGE)
  }
  const originalDataUrl = await readFileAsDataUrl(file)
  const image = await loadImageElement(originalDataUrl)
  const scale = Math.min(
    1,
    VISUAL_ATTACHMENT_MAX_LONG_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1),
  )
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error(ATTACHMENT_ERROR_CANVAS)
  context.drawImage(image, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/jpeg', VISUAL_ATTACHMENT_JPEG_QUALITY)
  const base64 = dataUrl.split(',', 2)[1] || ''
  return {
    name: file.name || 'image.jpg',
    mime: 'image/jpeg',
    dataUrl,
    width,
    height,
    byteLength: Math.floor((base64.length * 3) / 4),
  }
}

// 组装视觉载荷协议对象，对齐后端多模态输入契约。
export function visualPayload(
  attachment: VisualAttachment | null,
  provider: string,
): Record<string, unknown> | undefined {
  if (!attachment || !supportsDirectImage(provider)) return undefined
  return {
    request: true,
    mode: 'attachment',
    scope: 'user_image',
    provider,
    source: 'user_image',
    attachment: { name: attachment.name, byteLength: attachment.byteLength },
    frame: {
      mime: attachment.mime,
      dataUrl: attachment.dataUrl,
      width: attachment.width,
      height: attachment.height,
      byteLength: attachment.byteLength,
    },
  }
}

// 纯图片发送时的缺省占位文本，满足大模型必须包含文字提示词的输入约束。
export const ATTACHMENT_ONLY_TEXT = '请看这张图片。'
