import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { interpolate, normalizeLocale, type Locale, SUPPORTED_LOCALES } from './core'

export { interpolate, normalizeLocale, SUPPORTED_LOCALES }
export type { Locale }

type Messages = Record<string, string>

const MAIN_LOCALE_MESSAGES = {
  'en-US': {
    'chat.send': 'Send message',


  },
  'zh-CN': {
    'chat.send': '发送消息',


  },
  'ja-JP': {
    'chat.send': 'メッセージを送信',


  },
} as const

const EN = {
  ...MAIN_LOCALE_MESSAGES['en-US'],
  'locale.en-US': 'English',
  'locale.zh-CN': '简体中文',
  'locale.ja-JP': '日本語',
  'settings.title': 'Settings',
  'settings.thinking_level': 'Thinking level',
  'settings.reload_error': 'Runtime reload failed',
  'settings.loading_error': 'Could not load settings',
  'settings.save_error': 'Could not save {key}',
  'settings.update_error': 'Could not update {key}',
  'settings.saving': 'Saving {key}…',
  'settings.saving_label': 'Saving…',














  'settings.security.available': 'Secrets protected by the operating system',
  'settings.security.unavailable': 'System secret encryption unavailable',








  'settings.label.asr_mode': 'Recognition backend',
  // Backend labels live under their own prefix: `settings.option.*` is shared with
  // the TTS backend select, and both registries use the ids openai_compatible and
  // mimo, so a shared key would retitle one page's dropdown with the other's words.
  'settings.asrBackend.qwen3_asr': 'Qwen3-ASR (local)',
  'settings.asrBackend.sense_voice': 'SenseVoice (local)',
  'settings.asrBackend.openai_compatible': 'OpenAI-compatible transcription (remote)',
  'settings.asrBackend.mimo': 'MiMo ASR model (Xiaomi, remote)',















  'settings.note.no_user_settings': 'No user-managed connection settings.',
  'settings.note.no_active_connection': 'No active connection is selected.',

  'settings.other_voice_backends': 'Other synthesis backends',
  'settings.advanced': 'Advanced (live calibration)',







  'settings.placeholder.secret_replace': 'Configured — enter to replace',
  'settings.placeholder.secret_empty': 'Not configured',
  'settings.action.save': 'Save',
  'settings.action.clear': 'Clear',
  'settings.action.on': 'On',
  'settings.action.off': 'Off',












  'settings.label.interface_language': 'Interface language',



  'settings.label.current_model': 'Current model profile',











  'settings.option.english': 'English',
  'settings.option.chinese': '简体中文',
  'settings.option.japanese': '日本語',









  'settings.status.active': 'ACTIVE',

  'settings.status.configured': 'Configured',
  'settings.status.needs_setup': 'Needs setup',


























































  'chat.error.decode_image': 'Could not decode image', 'chat.error.read_image': 'Could not read image', 'chat.error.choose_image': 'Please choose an image file.', 'chat.error.canvas': 'Canvas is unavailable.',
  'chat.remove_image': 'Remove image',

  'scene.attach_image': 'Attach a picture', 'scene.attach_needs_visual_provider': 'Select an OpenAI, Anthropic or Gemini protocol provider to attach a picture',
  'scene.transcript': 'Conversation',
  'scene.new_task': 'New task', 'scene.current_task': 'Current task',
  'scene.send': 'Send', 'scene.mic_start': 'Start voice input', 'scene.mic_stop': 'Stop voice input',
  'scene.placeholder': 'Say something to Amadeus...', 'scene.placeholder_offline': 'Connecting to the backend...',
  'scene.listening': 'Listening…', 'scene.streaming': 'Replying...',
  'scene.dismiss': 'Dismiss', 'scene.empty_transcript': 'This task has no conversation yet.',
  'scene.starting': 'Waking up the scene...', 'scene.waiting_backend': 'Waiting for the backend...',
  'scene.failed_title': 'The scene could not start', 'scene.retry': 'Retry',
  'scene.import_assets': 'Import character resources', 'scene.importing_assets': 'Importing character resources…',
  'scene.role_user': 'You', 'scene.role_system': 'System', 'scene.role_assistant': 'Amadeus',
  'scene.settings': 'Settings',

}

const ZH: Messages = {
  ...EN,
  'settings.thinking_level': '思考强度',
  'settings.reload_error': '运行时重载失败',
  ...MAIN_LOCALE_MESSAGES['zh-CN'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '设置',
  'settings.loading_error': '无法加载设置', 'settings.save_error': '无法保存 {key}', 'settings.update_error': '无法更新 {key}', 'settings.saving': '正在保存 {key}…',
  'settings.saving_label': '正在保存…',

  'settings.security.available': '密钥受操作系统保护', 'settings.security.unavailable': '系统密钥加密不可用',

'settings.label.asr_mode': '识别后端', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（本地）', 'settings.asrBackend.sense_voice': 'SenseVoice（本地）', 'settings.asrBackend.openai_compatible': 'OpenAI 兼容转写（远程）', 'settings.asrBackend.mimo': '小米 ASR 模型（远程）',





  'settings.note.no_user_settings': '没有用户管理的连接设置。', 'settings.note.no_active_connection': '当前没有选中的活动连接。', 'settings.other_voice_backends': '其他语音合成后端', 'settings.advanced': '高级（实时校准）',

  'settings.placeholder.secret_replace': '已配置——输入以替换', 'settings.placeholder.secret_empty': '未配置', 'settings.action.save': '保存', 'settings.action.clear': '清除', 'settings.action.on': '开', 'settings.action.off': '关',



  'settings.label.interface_language': '界面语言',
  'settings.label.current_model': '当前模型配置',

  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語',
  'settings.status.configured': '已配置', 'settings.status.needs_setup': '需要设置',
  'settings.status.active': '活动',

  'chat.error.decode_image': '无法解码图片', 'chat.error.read_image': '无法读取图片', 'chat.error.choose_image': '请选择图片文件。', 'chat.error.canvas': '画布不可用。',
  'chat.remove_image': '移除图片',

  'scene.attach_image': '附加图片', 'scene.attach_needs_visual_provider': '请选择 OpenAI / Anthropic / Gemini 系协议提供方以附加图片',
  'scene.transcript': '对话记录',
  'scene.new_task': '新建任务', 'scene.current_task': '当前任务',
  'scene.send': '发送', 'scene.mic_start': '开始语音输入', 'scene.mic_stop': '停止语音输入',
  'scene.placeholder': '对 Amadeus 说点什么…', 'scene.placeholder_offline': '正在连接后端…',
  'scene.listening': '正在聆听…', 'scene.streaming': '正在回应…',
  'scene.dismiss': '收起', 'scene.empty_transcript': '这个任务还没有对话。',
  'scene.starting': '正在唤起场景…', 'scene.waiting_backend': '正在等待后端…',
  'scene.failed_title': '场景未能启动', 'scene.retry': '重试',
  'scene.import_assets': '导入角色资源', 'scene.importing_assets': '正在导入角色资源…',
  'scene.role_user': '主人', 'scene.role_system': '系统', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '设置',

}

const JA: Messages = {
  ...EN,
  'settings.thinking_level': '思考レベル',
  'settings.reload_error': '再読み込みに失敗しました',
  ...MAIN_LOCALE_MESSAGES['ja-JP'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '設定',
  'settings.loading_error': '設定を読み込めません', 'settings.save_error': '{key} を保存できません', 'settings.update_error': '{key} を更新できません', 'settings.saving': '{key} を保存中…',


  'settings.security.available': '秘密情報は OS により保護されています', 'settings.security.unavailable': 'OS の秘密情報暗号化を利用できません',

'settings.label.asr_mode': '認識バックエンド', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（ローカル）', 'settings.asrBackend.sense_voice': 'SenseVoice（ローカル）', 'settings.asrBackend.openai_compatible': 'OpenAI 互換文字起こし（リモート）', 'settings.asrBackend.mimo': 'MiMo ASR モデル（Xiaomi・リモート）',

  'settings.note.no_user_settings': 'ユーザー管理の接続設定はありません。', 'settings.note.no_active_connection': '選択中のアクティブな接続はありません。', 'settings.other_voice_backends': 'その他の音声合成バックエンド', 'settings.advanced': '詳細設定（リアルタイム調整）',
  'settings.saving_label': '保存中…', 'settings.placeholder.secret_replace': '設定済み — 入力して置換', 'settings.placeholder.secret_empty': '未設定', 'settings.action.save': '保存', 'settings.action.clear': 'クリア', 'settings.action.on': 'オン', 'settings.action.off': 'オフ',
  'settings.label.interface_language': 'インターフェース言語', 'settings.label.current_model': '現在のモデルプロファイル',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語',
  'settings.status.configured': '設定済み', 'settings.status.needs_setup': '設定が必要',
  'settings.status.active': '有効',

  'chat.error.decode_image': '画像をデコードできません', 'chat.error.read_image': '画像を読み込めません', 'chat.error.choose_image': '画像ファイルを選択してください。', 'chat.error.canvas': 'キャンバスを利用できません。',
  'chat.remove_image': '画像を削除',

  'scene.attach_image': '画像を添付', 'scene.attach_needs_visual_provider': '画像を添付するには OpenAI / Anthropic / Gemini 系プロトコルを選択してください',
  'scene.transcript': '会話履歴',
  'scene.new_task': '新しいタスク', 'scene.current_task': '現在のタスク',
  'scene.send': '送信', 'scene.mic_start': '音声入力を開始', 'scene.mic_stop': '音声入力を停止',
  'scene.placeholder': 'Amadeus に話しかける…', 'scene.placeholder_offline': 'バックエンドに接続中…',
  'scene.listening': '聞き取り中…', 'scene.streaming': '応答中…',
  'scene.dismiss': '閉じる', 'scene.empty_transcript': 'このタスクにはまだ会話がありません。',
  'scene.starting': 'シーンを起動しています…', 'scene.waiting_backend': 'バックエンドを待機中…',
  'scene.failed_title': 'シーンを起動できませんでした', 'scene.retry': '再試行',
  'scene.import_assets': 'キャラクター素材をインポート', 'scene.importing_assets': 'キャラクター素材をインポート中…',
  'scene.role_user': 'あなた', 'scene.role_system': 'システム', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '設定',

}

const MESSAGES: Record<Locale, Messages> = { 'en-US': EN, 'zh-CN': ZH, 'ja-JP': JA }
export type MessageKey = keyof typeof EN

type SettingCopy = Record<'group' | 'field' | 'description' | 'groupDescription' | 'status' | 'option', Record<string, string>>

const ZH_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（本地）', speech_synthesis: 'Fish Audio 实时合成', network: '网络',
  },
  field: {
    asr_language: '识别语言', FISH_API_KEY: 'Fish Audio API 密钥', FISH_VOICE_ID: 'Fish 声音 ID', FISH_API_MODEL: 'Fish 模型',
    mouth_gain: '嘴型增益', mouth_silence_threshold: '静音阈值', voice_sync_offset_ms: '音画同步偏移（毫秒）', network_proxy: '网络代理',
  },
  description: {}, groupDescription: {}, status: {}, option: {},
}

const JA_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（ローカル）', speech_synthesis: 'Fish Audio リアルタイム合成', network: 'ネットワーク',
  },
  field: {
    asr_language: '認識言語', FISH_API_KEY: 'Fish Audio API キー', FISH_VOICE_ID: 'Fish ボイス ID', FISH_API_MODEL: 'Fish モデル',
    mouth_gain: '口の動きのゲイン', mouth_silence_threshold: '無音しきい値', voice_sync_offset_ms: '音声同期オフセット（ミリ秒）', network_proxy: 'ネットワークプロキシ',
  },
  description: {}, groupDescription: {}, status: {}, option: {},
}
const SETTING_COPY: Record<Locale, SettingCopy> = { 'en-US': { group: {}, field: {}, description: {}, groupDescription: {}, status: {}, option: {} }, 'zh-CN': ZH_SETTINGS, 'ja-JP': JA_SETTINGS }

function translate(locale: Locale, key: MessageKey, fallback?: string, values?: Record<string, unknown>): string {
  const template = MESSAGES[locale][key] ?? MESSAGES['en-US'][key] ?? fallback ?? key
  return interpolate(template, values)
}

export function translateSetting(locale: Locale, kind: keyof SettingCopy, id: string, fallback = ''): string {
  return SETTING_COPY[locale][kind][id] ?? fallback
}

export function translateDynamic(locale: Locale, prefix: string, value: string, fallback = ''): string {
  const key = `${prefix}.${value}`
  const template = MESSAGES[locale][key] ?? MESSAGES['en-US'][key]
  return template === undefined ? fallback : interpolate(template)
}

type I18nValue = {
  locale: Locale
  setLocale: (value: unknown) => void
  t: (key: MessageKey, fallback?: string, values?: Record<string, unknown>) => string
  formatNumber: (value: number) => string
  formatDate: (value: Date | number | string) => string
}

const I18nContext = createContext<I18nValue | null>(null)

type ProviderProps = {
  children: ReactNode
  connected?: boolean
  send?: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  subscribe?: (method: string, fn: (payload: Record<string, unknown>) => void) => () => void
}

export function I18nProvider({ children, connected = false, send, subscribe }: ProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try { return normalizeLocale(localStorage.getItem('amadeus.interfaceLocale')) } catch { return 'en-US' }
  })
  const setLocale = (value: unknown) => {
    const next = normalizeLocale(value)
    setLocaleState(next)
    try { localStorage.setItem('amadeus.interfaceLocale', next) } catch { /* storage may be unavailable in previews */ }
  }

  useEffect(() => {
    let cancelled = false
    const apply = (payload: Record<string, unknown>) => {
      const values = payload.values && typeof payload.values === 'object' ? payload.values as Record<string, unknown> : payload
      if (!cancelled && values.presentation_locale !== undefined) setLocale(values.presentation_locale)
    }
    const unsubscribe = subscribe?.('system.config', apply)
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'amadeus.interfaceLocale' && event.newValue) setLocale(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    if (!connected || !send) return () => {
      cancelled = true
      unsubscribe?.()
      window.removeEventListener('storage', onStorage)
    }
    let stored = ''
    try { stored = localStorage.getItem('amadeus.interfaceLocale') || '' } catch { /* ignore unavailable storage */ }
    void send('system.get_config', {}).then(payload => {
      const values = payload.values && typeof payload.values === 'object' ? payload.values as Record<string, unknown> : payload
      if (values.presentation_locale !== undefined) {
        apply(payload)
      } else if (stored) {
        setLocale(stored)
        void send('system.set_config', { values: { presentation_locale: normalizeLocale(stored) } }).catch(() => {})
      }
    }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
      window.removeEventListener('storage', onStorage)
    }
  }, [connected, send, subscribe])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, fallback, values) => translate(locale, key, fallback, values),
    formatNumber: value => new Intl.NumberFormat(locale).format(value),
    formatDate: value => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)),
  }), [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
