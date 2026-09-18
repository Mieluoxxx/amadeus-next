/**
 * Image attachment preparation for the Amadeus scene conversation.
 *
 * The scene talks to the same backend as the chat page, so a picture the user
 * attaches must be prepared the same way: bounded long side, JPEG re-encode,
 * measured byte length. This is the shared implementation, extracted so the
 * scene does not grow a second, subtly different image pipeline.
 */

export const VISUAL_ATTACHMENT_MAX_LONG_SIDE = 1280
export const VISUAL_ATTACHMENT_JPEG_QUALITY = 0.82

/** Providers the backend accepts visual input from. */
export const MULTIMODAL_CHAT_PROVIDERS = new Set([
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-gemini',
])

/** Whether this provider id may receive direct image input. */
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

/** Error codes, translated by the caller. */
export const ATTACHMENT_ERROR_NOT_IMAGE = 'chat.error.choose_image'
export const ATTACHMENT_ERROR_DECODE = 'chat.error.decode_image'
export const ATTACHMENT_ERROR_READ = 'chat.error.read_image'
export const ATTACHMENT_ERROR_CANVAS = 'chat.error.canvas'

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(ATTACHMENT_ERROR_DECODE))
    image.src = src
  })
}

export function readFileAsDataUrl(file: File): Promise<string> {
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

/**
 * The `visual` block of a `chat.send`. Exported because the payload shape is a
 * backend contract, not an implementation detail.
 */
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

/** Text sent when the user attaches a picture without typing anything. */
export const ATTACHMENT_ONLY_TEXT = '请看这张图片。'
