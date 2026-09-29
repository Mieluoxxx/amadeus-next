import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { interpolate, normalizeLocale, type Locale, SUPPORTED_LOCALES } from './core'

export { interpolate, normalizeLocale, SUPPORTED_LOCALES }
export type { Locale }

type Messages = Record<string, string>

const MAIN_LOCALE_MESSAGES = {
  'en-US': {
    'chat.provider': 'Chat provider', 'chat.send': 'Send message',


  },
  'zh-CN': {
    'chat.provider': '聊天提供方', 'chat.send': '发送消息',


  },
  'ja-JP': {
    'chat.provider': 'チャット Provider', 'chat.send': 'メッセージを送信',


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
  'settings.restart': 'Restart backend to apply',
  'settings.restarting': 'Restarting…',
  'settings.loading_error': 'Could not load settings',
  'settings.save_error': 'Could not save {key}',
  'settings.update_error': 'Could not update {key}',
  'settings.saving': 'Saving {key}…',
  'settings.saving_label': 'Saving…',
  'settings.section.general': 'Overview',
  'settings.section.models': 'Models',
  'settings.section.asr': 'Speech recognition',
  'settings.section.tts': 'Speech synthesis',










  'settings.aria_sections': 'Settings sections',
  'settings.security.available': 'Secrets protected by the operating system',
  'settings.security.unavailable': 'System secret encryption unavailable',
  'settings.restart_pending': 'Saved changes need a backend restart',
  'settings.restart_pending_detail': 'Applied automatically. Use the button if this backend cannot be restarted from here.',

  'settings.group.chat_voice': 'Chat & Voice',
  'settings.group.main_model': 'Main chat model',

  'settings.group.asr_current': 'Current configuration',
  'settings.group.asr_configuration': 'Recognition settings',
  'settings.group.asr_capture': 'Microphone & endpointing',
  'settings.group.asr_remaining': 'Other settings',
  'settings.label.asr_mode': 'Recognition backend',
  // Backend labels live under their own prefix: `settings.option.*` is shared with
  // the TTS backend select, and both registries use the ids openai_compatible and
  // mimo, so a shared key would retitle one page's dropdown with the other's words.
  'settings.asrBackend.qwen3_asr': 'Qwen3-ASR (local)',
  'settings.asrBackend.sense_voice': 'SenseVoice (local)',
  'settings.asrBackend.openai_compatible': 'OpenAI-compatible transcription (remote)',
  'settings.asrBackend.mimo': 'MiMo ASR model (Xiaomi, remote)',
  'settings.group.voice_output': 'Speaking & synthesis',














  'settings.note.no_user_settings': 'No user-managed connection settings.',
  'settings.note.no_active_connection': 'No active connection is selected.',

  'settings.other_voice_backends': 'Other synthesis backends',
  'settings.advanced': 'Advanced (live calibration)',
  'settings.group.network': 'Network',






  'settings.placeholder.secret_replace': 'Configured — enter to replace',
  'settings.placeholder.secret_empty': 'Not configured',
  'settings.action.save': 'Save',
  'settings.action.clear': 'Clear',
  'settings.action.on': 'On',
  'settings.action.off': 'Off',
  'settings.restart_error': 'Backend restart failed',
  'settings.restart_unowned': 'This backend was not started by this app, so it cannot be restarted from here. Restart it where it was launched.',
  'settings.provider_needs_key': 'No API key is configured for {provider}. Enter one below and it will be applied.',












  'settings.label.interface_language': 'Interface language',

  'settings.label.chat_translation': 'Chat Translation Subtitles',



  'settings.label.current_model': 'Current model profile',











  'settings.option.english': 'English',
  'settings.option.chinese': '简体中文',
  'settings.option.japanese': '日本語',


  'settings.option.auto': 'Automatic',







  'settings.option.source': 'Source',
  'settings.option.deepseek': 'DeepSeek',
  'settings.status.registered': 'Registered', 'settings.status.active': 'ACTIVE',

  'settings.status.configured': 'Configured',
  'settings.status.needs_setup': 'Needs setup',


  'settings.status.not_installed': 'Not installed',
  'settings.status.remote': 'Remote',


  'settings.status.none': 'None',






















































  'chat.error.decode_image': 'Could not decode image', 'chat.error.read_image': 'Could not read image', 'chat.error.choose_image': 'Please choose an image file.', 'chat.error.canvas': 'Canvas is unavailable.', 'chat.error.send_failed': 'Send failed: backend unreachable', 'chat.error.attach_image': 'Could not attach image', 'chat.error.create_session': 'Could not create session', 'chat.error.create_project_chat': 'Could not create the Project chat', 'chat.error.select_project_directory': 'Could not select a Project directory', 'chat.error.create_project': 'Could not create the Project', 'chat.error.load_project_apps': 'Could not load Project apps', 'chat.error.load_draft_apps': 'Could not load recent Draft apps', 'chat.error.open_artifact_chat': 'Could not open the Artifact conversation', 'chat.error.prepare_auip': 'Could not prepare the AUIP application', 'chat.error.launch_descriptor': 'The Host did not return a complete AUIP launch descriptor.', 'chat.error.host_refused': 'The desktop Host refused the AUIP application.', 'chat.error.promote_draft_app': 'Could not promote the Draft app', 'chat.error.move_chat': 'Could not move the chat', 'chat.error.promote_draft': 'Could not promote the Draft', 'chat.error.delete_session': 'Could not delete session', 'chat.error.rename_session': 'Could not rename session',
  'chat.remove_image': 'Remove image', 'chat.refresh': 'Refresh',

  'scene.attach_image': 'Attach a picture', 'scene.attach_needs_visual_provider': 'Select an OpenAI, Anthropic or Gemini protocol provider to attach a picture',
  'scene.character_missing': 'The scene is up, but Amadeus has not appeared yet', 'scene.approval_unavailable': 'Approval details are incomplete; refresh before deciding',
  'scene.export_needs_recovery': 'Export needs your decision',
  'scene.approve_once': 'Allow once', 'scene.deny': 'Deny', 'scene.retry_export': 'Retry export', 'scene.abandon_export': 'Abandon export',
  'scene.transcript': 'Conversation',
  'scene.new_task': 'New task', 'scene.current_task': 'Current task',
  'scene.send': 'Send', 'scene.mic_start': 'Start voice input', 'scene.mic_stop': 'Stop voice input',
  'scene.placeholder': 'Say something to Amadeus...', 'scene.placeholder_offline': 'Connecting to the backend...',
  'scene.listening': 'Listening…', 'scene.streaming': 'Replying...',
  'scene.notice_permission': 'Permission needed: {detail}', 'scene.notice_failed': 'Task failed: {detail}',
  'scene.dismiss': 'Dismiss', 'scene.empty_transcript': 'This task has no conversation yet.',
  'scene.starting': 'Waking up the scene...', 'scene.waiting_backend': 'Waiting for the backend...',
  'scene.failed_title': 'The scene could not start', 'scene.retry': 'Retry',
  'scene.role_user': 'You', 'scene.role_system': 'System', 'scene.role_assistant': 'Amadeus',
  'scene.settings': 'Settings',

  'scene.notify_title': 'Amadeus task finished',
  'scene.work_needs_permission': 'Needs your permission', 'chat.error.prefix': 'Error: {error}',
}

const ZH: Messages = {
  ...EN,
  'settings.thinking_level': '思考强度',
  'settings.reload_error': '运行时重载失败',
  ...MAIN_LOCALE_MESSAGES['zh-CN'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '设置', 'settings.restart': '重启后端以应用设置', 'settings.restarting': '正在重启…',
  'settings.loading_error': '无法加载设置', 'settings.save_error': '无法保存 {key}', 'settings.update_error': '无法更新 {key}', 'settings.saving': '正在保存 {key}…',
  'settings.saving_label': '正在保存…', 'settings.section.general': '总览', 'settings.section.models': '模型', 'settings.section.asr': '语音识别', 'settings.section.tts': '语音合成',

  'settings.security.available': '密钥受操作系统保护', 'settings.security.unavailable': '系统密钥加密不可用', 'settings.restart_pending': '已保存的更改需要重启后端才能生效', 'settings.restart_pending_detail': '本应用会自动重启；若该后端无法从这里自动重启，请点击右侧按钮。',
  'settings.aria_sections': '设置分区',
  'settings.group.chat_voice': '界面与字幕', 'settings.group.main_model': '主聊天模型', 'settings.group.voice_output': '说话与合成',
  'settings.group.asr_current': '当前配置', 'settings.group.asr_configuration': '识别设置', 'settings.group.asr_capture': '麦克风与端点', 'settings.group.asr_remaining': '其余设置', 'settings.label.asr_mode': '识别后端', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（本地）', 'settings.asrBackend.sense_voice': 'SenseVoice（本地）', 'settings.asrBackend.openai_compatible': 'OpenAI 兼容转写（远程）', 'settings.asrBackend.mimo': '小米 ASR 模型（远程）',





  'settings.note.no_user_settings': '没有用户管理的连接设置。', 'settings.note.no_active_connection': '当前没有选中的活动连接。', 'settings.other_voice_backends': '其他语音合成后端', 'settings.advanced': '高级（实时校准）', 'settings.group.network': '网络',

  'settings.placeholder.secret_replace': '已配置——输入以替换', 'settings.placeholder.secret_empty': '未配置', 'settings.action.save': '保存', 'settings.action.clear': '清除', 'settings.action.on': '开', 'settings.action.off': '关',
  'settings.restart_error': '后端重启失败', 'settings.restart_unowned': '该后端不是由本应用启动的，无法从这里自动重启；请在启动它的地方重启。', 'settings.provider_needs_key': '{provider} 尚未配置 API Key，请在下方填写后即可生效。',



  'settings.label.interface_language': '界面语言', 'settings.label.chat_translation': '聊天翻译字幕',
  'settings.label.current_model': '当前模型配置',

  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.auto': '自动',
  'settings.status.registered': '已注册', 'settings.status.configured': '已配置', 'settings.status.needs_setup': '需要设置', 'settings.status.not_installed': '未安装', 'settings.status.remote': '远程', 'settings.status.none': '无',
  'settings.status.active': '活动',

  'chat.error.decode_image': '无法解码图片', 'chat.error.read_image': '无法读取图片', 'chat.error.choose_image': '请选择图片文件。', 'chat.error.canvas': '画布不可用。', 'chat.error.send_failed': '发送失败：后端不可达', 'chat.error.attach_image': '无法附加图片', 'chat.error.create_session': '无法创建会话', 'chat.error.create_project_chat': '无法创建项目聊天', 'chat.error.select_project_directory': '无法选择项目目录', 'chat.error.create_project': '无法创建项目', 'chat.error.load_project_apps': '无法加载项目应用', 'chat.error.load_draft_apps': '无法加载最近的 Draft 应用', 'chat.error.open_artifact_chat': '无法打开 Artifact 对话', 'chat.error.prepare_auip': '无法准备 AUIP 应用', 'chat.error.launch_descriptor': '主机未返回完整的 AUIP 启动描述。', 'chat.error.host_refused': '桌面主机拒绝了 AUIP 应用。', 'chat.error.promote_draft_app': '无法提升 Draft 应用', 'chat.error.move_chat': '无法移动聊天', 'chat.error.promote_draft': '无法提升 Draft', 'chat.error.delete_session': '无法删除会话', 'chat.error.rename_session': '无法重命名会话',
  'chat.remove_image': '移除图片', 'chat.refresh': '刷新',

  'scene.attach_image': '附加图片', 'scene.attach_needs_visual_provider': '请选择 OpenAI / Anthropic / Gemini 系协议提供方以附加图片',
  'scene.character_missing': '场景已就绪，但 Amadeus 还没有出现', 'scene.approval_unavailable': '授权信息不完整，请刷新后再决定',
  'scene.export_needs_recovery': '导出需要你决定',
  'scene.approve_once': '仅此次允许', 'scene.deny': '拒绝', 'scene.retry_export': '重试导出', 'scene.abandon_export': '放弃导出',
  'scene.transcript': '对话记录',
  'scene.new_task': '新建任务', 'scene.current_task': '当前任务',
  'scene.send': '发送', 'scene.mic_start': '开始语音输入', 'scene.mic_stop': '停止语音输入',
  'scene.placeholder': '对 Amadeus 说点什么…', 'scene.placeholder_offline': '正在连接后端…',
  'scene.listening': '正在聆听…', 'scene.streaming': '正在回应…',
  'scene.notice_permission': '需要授权：{detail}', 'scene.notice_failed': '任务失败：{detail}',
  'scene.dismiss': '收起', 'scene.empty_transcript': '这个任务还没有对话。',
  'scene.starting': '正在唤起场景…', 'scene.waiting_backend': '正在等待后端…',
  'scene.failed_title': '场景未能启动', 'scene.retry': '重试',
  'scene.role_user': '主人', 'scene.role_system': '系统', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '设置',

  'scene.notify_title': 'Amadeus 任务已结束',
  'scene.work_needs_permission': '需要你的授权', 'chat.error.prefix': '错误：{error}',
}

const JA: Messages = {
  ...EN,
  'settings.thinking_level': '思考レベル',
  'settings.reload_error': '再読み込みに失敗しました',
  ...MAIN_LOCALE_MESSAGES['ja-JP'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '設定', 'settings.restart': '適用するにはバックエンドを再起動', 'settings.restarting': '再起動中…',
  'settings.loading_error': '設定を読み込めません', 'settings.save_error': '{key} を保存できません', 'settings.update_error': '{key} を更新できません', 'settings.saving': '{key} を保存中…',
  'settings.section.general': '概要', 'settings.section.models': 'モデル', 'settings.section.asr': '音声認識', 'settings.section.tts': '音声合成', 'settings.aria_sections': '設定セクション',

  'settings.security.available': '秘密情報は OS により保護されています', 'settings.security.unavailable': 'OS の秘密情報暗号化を利用できません', 'settings.restart_pending': '保存済みの変更はバックエンドの再起動で反映されます', 'settings.restart_pending_detail': '自動で再起動します。ここから再起動できない場合は右のボタンを使用してください。',
  'settings.group.chat_voice': '表示と言語', 'settings.group.main_model': 'メインチャットモデル', 'settings.group.voice_output': '合成と出力',
  'settings.group.asr_current': '現在の設定', 'settings.group.asr_configuration': '認識設定', 'settings.group.asr_capture': 'マイクと端点検出', 'settings.group.asr_remaining': 'その他の設定', 'settings.label.asr_mode': '認識バックエンド', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（ローカル）', 'settings.asrBackend.sense_voice': 'SenseVoice（ローカル）', 'settings.asrBackend.openai_compatible': 'OpenAI 互換文字起こし（リモート）', 'settings.asrBackend.mimo': 'MiMo ASR モデル（Xiaomi・リモート）',

  'settings.note.no_user_settings': 'ユーザー管理の接続設定はありません。', 'settings.note.no_active_connection': '選択中のアクティブな接続はありません。', 'settings.other_voice_backends': 'その他の音声合成バックエンド', 'settings.advanced': '詳細設定（リアルタイム調整）', 'settings.group.network': 'ネットワーク',
  'settings.saving_label': '保存中…', 'settings.placeholder.secret_replace': '設定済み — 入力して置換', 'settings.placeholder.secret_empty': '未設定', 'settings.action.save': '保存', 'settings.action.clear': 'クリア', 'settings.action.on': 'オン', 'settings.action.off': 'オフ',
  'settings.restart_error': 'バックエンドの再起動に失敗しました', 'settings.restart_unowned': 'このバックエンドは本アプリが起動したものではないため、ここから再起動できません。起動した場所で再起動してください。', 'settings.provider_needs_key': '{provider} の API キーが未設定です。下で入力すると反映されます。',
  'settings.label.interface_language': 'インターフェース言語', 'settings.label.chat_translation': 'チャット翻訳字幕', 'settings.label.current_model': '現在のモデルプロファイル',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.auto': '自動',
  'settings.status.registered': '登録済み', 'settings.status.configured': '設定済み', 'settings.status.needs_setup': '設定が必要', 'settings.status.not_installed': '未インストール', 'settings.status.remote': 'リモート', 'settings.status.none': 'なし',
  'settings.status.active': '有効',

  'chat.error.decode_image': '画像をデコードできません', 'chat.error.read_image': '画像を読み込めません', 'chat.error.choose_image': '画像ファイルを選択してください。', 'chat.error.canvas': 'キャンバスを利用できません。', 'chat.error.send_failed': '送信失敗：バックエンドに接続できません', 'chat.error.attach_image': '画像を添付できません', 'chat.error.create_session': 'セッションを作成できません', 'chat.error.create_project_chat': 'Project チャットを作成できません', 'chat.error.select_project_directory': 'Project ディレクトリを選択できません', 'chat.error.create_project': 'Project を作成できません', 'chat.error.load_project_apps': 'Project アプリを読み込めません', 'chat.error.load_draft_apps': '最近の Draft アプリを読み込めません', 'chat.error.open_artifact_chat': 'Artifact 会話を開けません', 'chat.error.prepare_auip': 'AUIP アプリを準備できません', 'chat.error.launch_descriptor': 'Host が完全な AUIP 起動記述子を返しませんでした。', 'chat.error.host_refused': 'デスクトップ Host が AUIP アプリを拒否しました。', 'chat.error.promote_draft_app': 'Draft アプリを Project に昇格できません', 'chat.error.move_chat': 'チャットを移動できません', 'chat.error.promote_draft': 'Draft を Project に昇格できません', 'chat.error.delete_session': 'セッションを削除できません', 'chat.error.rename_session': 'セッション名を変更できません',
  'chat.remove_image': '画像を削除', 'chat.refresh': '更新',

  'scene.attach_image': '画像を添付', 'scene.attach_needs_visual_provider': '画像を添付するには OpenAI / Anthropic / Gemini 系プロトコルを選択してください',
  'scene.character_missing': 'シーンは表示されていますが、Amadeus はまだ現れていません', 'scene.approval_unavailable': '権限情報が不完全です。更新してから決定してください',
  'scene.export_needs_recovery': 'エクスポートの判断が必要です',
  'scene.approve_once': '今回のみ許可', 'scene.deny': '拒否', 'scene.retry_export': 'エクスポートを再試行', 'scene.abandon_export': 'エクスポートを中止',
  'scene.transcript': '会話履歴',
  'scene.new_task': '新しいタスク', 'scene.current_task': '現在のタスク',
  'scene.send': '送信', 'scene.mic_start': '音声入力を開始', 'scene.mic_stop': '音声入力を停止',
  'scene.placeholder': 'Amadeus に話しかける…', 'scene.placeholder_offline': 'バックエンドに接続中…',
  'scene.listening': '聞き取り中…', 'scene.streaming': '応答中…',
  'scene.notice_permission': '権限が必要です：{detail}', 'scene.notice_failed': 'タスク失敗：{detail}',
  'scene.dismiss': '閉じる', 'scene.empty_transcript': 'このタスクにはまだ会話がありません。',
  'scene.starting': 'シーンを起動しています…', 'scene.waiting_backend': 'バックエンドを待機中…',
  'scene.failed_title': 'シーンを起動できませんでした', 'scene.retry': '再試行',
  'scene.role_user': 'あなた', 'scene.role_system': 'システム', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '設定',

  'scene.notify_title': 'Amadeus のタスクが終了しました',
  'scene.work_needs_permission': '権限が必要です', 'chat.error.prefix': 'エラー：{error}',
}

export const MESSAGES: Record<Locale, Messages> = { 'en-US': EN, 'zh-CN': ZH, 'ja-JP': JA }
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

export function translate(locale: Locale, key: MessageKey, fallback?: string, values?: Record<string, unknown>): string {
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
