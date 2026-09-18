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
  'settings.section.providers': 'Providers',
  'settings.section.mcp': 'MCP',
  'settings.section.skills': 'Skills',







  'settings.aria_sections': 'Settings sections',
  'settings.security.available': 'Secrets protected by the operating system',
  'settings.security.unavailable': 'System secret encryption unavailable',
  'settings.restart_pending': 'Saved changes need a backend restart',
  'settings.restart_pending_detail': 'Applied automatically. Use the button if this backend cannot be restarted from here.',
  'settings.overview.title': 'Runtime overview',
  'settings.overview.model': 'Main model',
  'settings.overview.listening': 'Speech recognition',
  'settings.overview.speaking': 'Speech synthesis',

  'settings.group.chat_appearance': 'Chat appearance',
  'settings.group.avatar_compatibility': 'Avatar compatibility',
  'settings.group.vision': 'Multimodal & Vision',
  'settings.group.chat_voice': 'Chat & Voice',
  'settings.group.main_model': 'Main chat model',

  'settings.group.active_connections': 'Active model connections',
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
  'settings.group.runtime_presentation': 'Runtime presentation',

  'settings.group.work_providers': 'Work Provider connections',
  'settings.group.mcp': 'MCP connections',
  'settings.group.capabilities': 'Shared Provider capabilities',









  'settings.note.no_user_settings': 'No user-managed connection settings.',
  'settings.note.no_active_connection': 'No active connection is selected.',
  'settings.no_skills': 'No skills are shared with Work Providers in this backend process.',
  'settings.advanced_roles': 'Advanced model roles',
  'settings.other_connections': 'Other model connections',
  'settings.other_voice_backends': 'Other synthesis backends',






  'settings.placeholder.secret_replace': 'Configured — enter to replace',
  'settings.placeholder.secret_empty': 'Not configured',
  'settings.action.save': 'Save',
  'settings.action.clear': 'Clear',
  'settings.action.on': 'On',
  'settings.action.off': 'Off',
  'settings.asset.installed': 'Installed',
  'settings.asset.incomplete': 'Incomplete',
  'settings.asset.invalid': 'Invalid package',
  'settings.asset.not_installed': 'Not installed',
  'settings.asset.visual_content': 'Ambient layers, subtitles, scenario media, and wallpaper sound assets are available.',
  'settings.asset.visual_attention': 'The optional visual pack needs attention: {detail}',
  'settings.asset.visual_optional': 'Optional. The built-in wallpaper, Chat, Work, and headless mode remain available without it.',
  'settings.asset.character_content': '{frames} indexed KTX2 frames · {path}',
  'settings.asset.character_optional': 'Optional. Chat, Work, and headless mode remain available without this package.',
  'settings.asset.clips': 'clips',
  'settings.asset.character_attention': 'The optional package is incomplete: {detail}',
  'settings.validation_failed': 'validation failed',
  'settings.restart_error': 'Backend restart failed',
  'settings.restart_unowned': 'This backend was not started by this app, so it cannot be restarted from here. Restart it where it was launched.',
  'settings.provider_needs_key': 'No API key is configured for {provider}. Enter one below and it will be applied.',
  'settings.label.visual_pack': 'Visual Runtime Pack',
  'settings.label.character_pack': 'Kurisu Character Pack',
  'settings.label.vision_context': 'Vision Context',

  'settings.label.vision_mode': 'Vision Mode',

  'settings.label.vision_scope': 'Vision Scope',

  'settings.label.vision_provider': 'Vision Provider',

  'settings.label.vision_size': 'Vision Image Size',

  'settings.label.vision_quality': 'Vision JPEG Quality',

  'settings.label.interface_language': 'Interface language',

  'settings.label.chat_translation': 'Chat Translation Subtitles',

  'settings.label.wallpaper_caption': 'Wallpaper Caption Mode',

  'settings.label.current_model': 'Current model profile',

  'settings.label.tts_mode': 'Local TTS inference mode',

  'settings.label.tts_language': 'TTS output language',

  'settings.avatar.user': 'Your avatar',
  'settings.avatar.user_detail': 'Shown beside your messages',
  'settings.avatar.assistant': 'Kurisu avatar',
  'settings.avatar.assistant_detail': 'Shown beside Amadeus responses',
  'settings.avatar.opening': 'Opening…',
  'settings.avatar.replace': 'Replace',
  'settings.avatar.choose': 'Choose image',
  'settings.avatar.restore': 'Restore default {name}',
  'settings.avatar.note': "A centered PNG copy is stored in the app's local assets. The original file is never modified.",
  'settings.avatar.load_error': 'Could not load chat avatars',
  'settings.avatar.save_error': 'Could not save avatar',
  'settings.avatar.restore_error': 'Could not restore default avatar',
  'mcp.boundary.title': 'Provider-only boundary',
  'mcp.boundary.body': 'MCP connections are available only to compatible Work Providers. Main Chat cannot access MCP tools.',
  'mcp.enabled': 'Enabled', 'mcp.disabled': 'Disabled', 'mcp.providers': 'Providers:', 'mcp.not_bound': 'Not bound', 'mcp.main_chat': 'Main Chat:', 'mcp.no_access': 'No access', 'mcp.encrypted_environment': 'Encrypted environment:', 'mcp.none': 'None',
  'mcp.save_error': 'Could not save MCP connection', 'mcp.remove_error': 'Could not remove MCP connection', 'mcp.optional': 'Optional', 'mcp.bearer_optional': 'Optional · for example MCP_TOKEN',
  'mcp.test': 'Test', 'mcp.testing': 'Connecting…', 'mcp.test_title': 'Connect and discover tools', 'mcp.restart_test_title': 'Restart the backend before testing', 'mcp.edit': 'Edit', 'mcp.remove': 'Remove', 'mcp.confirm_remove': 'Confirm remove',
  'mcp.edit_title': 'Edit MCP connection', 'mcp.add_title': 'Add MCP server', 'mcp.editor_detail': 'Saved by the Host and applied to selected Work Providers after restart.', 'mcp.close': 'Close MCP editor', 'mcp.name': 'Name', 'mcp.transport': 'Transport', 'mcp.stdio_command': 'stdio command', 'mcp.streamable_http': 'Streamable HTTP', 'mcp.command': 'Command', 'mcp.arguments': 'Arguments', 'mcp.working_directory': 'Working directory', 'mcp.server_url': 'Server URL', 'mcp.bearer_env': 'Bearer token environment variable', 'mcp.encrypted_values': 'Encrypted environment values', 'mcp.keep_environment': 'Leave blank to keep stored values; use KEY= to remove one', 'mcp.environment_optional': 'Optional · one KEY=value per line', 'mcp.stored': 'Stored:', 'mcp.compatible_providers': 'Compatible Work Providers', 'mcp.no_compatible_provider': 'No installed Work Provider currently accepts MCP connections.', 'mcp.enable_selected': 'Enable for selected Providers', 'mcp.no_main_chat_grant': 'Saving a connection does not grant it to Main Chat.', 'mcp.cancel': 'Cancel', 'mcp.save': 'Save connection', 'mcp.add': '+ Add MCP server', 'mcp.locked': 'MCP registry is locked by the parent process environment.', 'mcp.empty': 'No MCP connections configured.', 'mcp.connected_tools': 'Connected · {count} tools discovered', 'mcp.connection_failed': 'Connection failed', 'mcp.invalid_env_entry': 'Environment entry must use KEY=value: {line}', 'mcp.invalid_env_key': 'Invalid environment key: {key}',
  'settings.option.english': 'English',
  'settings.option.chinese': '简体中文',
  'settings.option.japanese': '日本語',
  'settings.option.cuda_graph': 'CUDA Graph ×1',
  'settings.option.parallel': 'Parallel ×2',
  'settings.option.auto': 'Automatic',
  'settings.option.on_demand': 'On demand',
  'settings.option.watching': 'Watching',
  'settings.option.self_aware': 'Self-aware',
  'settings.option.wallpaper_surface': 'Wallpaper surface',
  'settings.option.region': 'Region',
  'settings.option.buffered': 'Buffered WAV · compatible',
  'settings.option.openai_sse': 'OpenAI SSE · streaming PCM',
  'settings.option.off': 'Off', 'settings.option.source': 'Source', 'settings.option.bilingual': 'Bilingual', 'settings.option.translated': 'Translated',
  'settings.option.deepseek': 'DeepSeek', 'settings.option.openai': 'OpenAI', 'settings.option.gemini': 'Gemini',
  'settings.status.registered': 'Registered', 'settings.status.active': 'ACTIVE',
  'settings.status.unavailable': 'Unavailable',
  'settings.status.configured': 'Configured',
  'settings.status.needs_setup': 'Needs setup',
  'settings.status.available': 'Available',
  'settings.status.disabled': 'Disabled',
  'settings.status.not_installed': 'Not installed',
  'settings.status.remote': 'Remote',
  'settings.status.enabled': 'Enabled',
  'settings.status.no_access': 'No access',
  'settings.status.none': 'None',
  'settings.status.not_bound': 'Not bound',
  'settings.status.no_active_binding': 'No active Provider binding',
  'settings.status.work_providers_only': 'Work Providers only',
  'settings.kind.mcp': 'MCP',
  'settings.kind.skill': 'Skill',
  'settings.capability.consumers': 'Consumers:',
  'settings.capability.scope': 'Scope:',
  'settings.capability.projection': 'Projection:',
  'settings.capability.source': 'Source:',
  'settings.capability.no_binding': 'No active Provider binding',
  'settings.capability.none': 'None',











































  'chat.error.decode_image': 'Could not decode image', 'chat.error.read_image': 'Could not read image', 'chat.error.choose_image': 'Please choose an image file.', 'chat.error.canvas': 'Canvas is unavailable.', 'chat.error.send_failed': 'Send failed: backend unreachable', 'chat.error.attach_image': 'Could not attach image', 'chat.error.create_session': 'Could not create session', 'chat.error.create_project_chat': 'Could not create the Project chat', 'chat.error.select_project_directory': 'Could not select a Project directory', 'chat.error.create_project': 'Could not create the Project', 'chat.error.load_project_apps': 'Could not load Project apps', 'chat.error.load_draft_apps': 'Could not load recent Draft apps', 'chat.error.open_artifact_chat': 'Could not open the Artifact conversation', 'chat.error.prepare_auip': 'Could not prepare the AUIP application', 'chat.error.launch_descriptor': 'The Host did not return a complete AUIP launch descriptor.', 'chat.error.host_refused': 'The desktop Host refused the AUIP application.', 'chat.error.promote_draft_app': 'Could not promote the Draft app', 'chat.error.move_chat': 'Could not move the chat', 'chat.error.promote_draft': 'Could not promote the Draft', 'chat.error.delete_session': 'Could not delete session', 'chat.error.rename_session': 'Could not rename session',
  'chat.remove_image': 'Remove image', 'chat.refresh': 'Refresh',

  'scene.attach_image': 'Attach a picture', 'scene.attach_needs_visual_provider': 'Select an OpenAI, Anthropic or Gemini protocol provider to attach a picture',
  'scene.character_missing': 'The scene is up, but Amadeus has not appeared yet', 'scene.approval_unavailable': 'Approval details are incomplete; refresh before deciding',
  'scene.export_needs_recovery': 'Export needs your decision',
  'scene.approve_once': 'Allow once', 'scene.deny': 'Deny', 'scene.retry_export': 'Retry export', 'scene.abandon_export': 'Abandon export',
  'scene.transcript': 'Conversation',
  'scene.collapse': 'Collapse', 'scene.new_task': 'New task', 'scene.current_task': 'Current task',
  'scene.send': 'Send', 'scene.mic_start': 'Start voice input', 'scene.mic_stop': 'Stop voice input',
  'scene.placeholder': 'Say something to Amadeus...', 'scene.placeholder_offline': 'Connecting to the backend...',
  'scene.listening': 'Listening…', 'scene.streaming': 'Replying...',
  'scene.notice_permission': 'Permission needed: {detail}', 'scene.notice_failed': 'Task failed: {detail}',
  'scene.dismiss': 'Dismiss', 'scene.empty_transcript': 'This task has no conversation yet.',
  'scene.starting': 'Waking up the scene...', 'scene.waiting_backend': 'Waiting for the backend...',
  'scene.failed_title': 'The scene could not start', 'scene.retry': 'Retry',
  'scene.role_user': 'You', 'scene.role_system': 'System', 'scene.role_assistant': 'Amadeus',
  'scene.settings': 'Settings', 'scene.workboard': 'Work surface',
  'scene.legacy_entry': 'Legacy chat shell (debug)', 'scene.legacy_title': 'Development / diagnostic fallback entry', 'scene.legacy_description': 'Leaves the scene for the legacy chat shell. Diagnostics only — the scene is the normal interface.', 'scene.legacy_open': 'Open legacy chat shell',
  'scene.notify_title': 'Amadeus task finished',
  'scene.work_needs_permission': 'Needs your permission', 'chat.error.prefix': 'Error: {error}',
}

const ZH: Messages = {
  ...EN,
  ...MAIN_LOCALE_MESSAGES['zh-CN'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '设置', 'settings.restart': '重启后端以应用设置', 'settings.restarting': '正在重启…',
  'settings.loading_error': '无法加载设置', 'settings.save_error': '无法保存 {key}', 'settings.update_error': '无法更新 {key}', 'settings.saving': '正在保存 {key}…', 'settings.asset.character_content': '{frames} 个 KTX2 帧 · {path}',
  'settings.saving_label': '正在保存…', 'settings.section.general': '总览', 'settings.section.models': '模型', 'settings.section.asr': '语音识别', 'settings.section.tts': '语音合成', 'settings.section.providers': '提供方', 'settings.section.mcp': 'MCP', 'settings.section.skills': 'Skills',

  'settings.security.available': '密钥受操作系统保护', 'settings.security.unavailable': '系统密钥加密不可用', 'settings.restart_pending': '已保存的更改需要重启后端才能生效', 'settings.restart_pending_detail': '本应用会自动重启；若该后端无法从这里自动重启，请点击右侧按钮。',
  'settings.overview.title': '运行状态总览', 'settings.overview.model': '主模型', 'settings.overview.listening': '语音识别', 'settings.overview.speaking': '语音合成',
  'settings.aria_sections': '设置分区', 'settings.group.chat_appearance': '聊天外观', 'settings.group.avatar_compatibility': '头像兼容',
  'settings.group.vision': '多模态与视觉', 'settings.group.chat_voice': '界面与字幕', 'settings.group.main_model': '主聊天模型', 'settings.group.active_connections': '当前模型连接', 'settings.group.voice_output': '说话与合成',
  'settings.group.asr_current': '当前配置', 'settings.group.asr_configuration': '识别设置', 'settings.group.asr_capture': '麦克风与端点', 'settings.group.asr_remaining': '其余设置', 'settings.label.asr_mode': '识别后端', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（本地）', 'settings.asrBackend.sense_voice': 'SenseVoice（本地）', 'settings.asrBackend.openai_compatible': 'OpenAI 兼容转写（远程）', 'settings.asrBackend.mimo': '小米 ASR 模型（远程）',
  'settings.group.runtime_presentation': '运行时呈现', 'settings.group.work_providers': '工作提供方连接', 'settings.group.mcp': 'MCP 连接', 'settings.group.capabilities': '共享提供方能力',




  'settings.note.no_user_settings': '没有用户管理的连接设置。', 'settings.note.no_active_connection': '当前没有选中的活动连接。', 'settings.no_skills': '此后端进程中没有与提供方共享的技能。', 'settings.advanced_roles': '高级模型角色', 'settings.other_connections': '其他模型连接', 'settings.other_voice_backends': '其他语音合成后端',

  'settings.placeholder.secret_replace': '已配置——输入以替换', 'settings.placeholder.secret_empty': '未配置', 'settings.action.save': '保存', 'settings.action.clear': '清除', 'settings.action.on': '开', 'settings.action.off': '关',
  'settings.asset.installed': '已安装', 'settings.asset.incomplete': '不完整', 'settings.asset.invalid': '无效包', 'settings.asset.not_installed': '未安装',
  'settings.asset.visual_content': '环境层、字幕、场景媒体和壁纸音频资源可用。', 'settings.asset.visual_optional': '可选。没有它，内置壁纸、聊天、工作页和无界面模式仍可用。',
  'settings.asset.visual_attention': '可选视觉资源包需要处理：{detail}', 'settings.asset.character_attention': '可选资源包不完整：{detail}', 'settings.asset.clips': '个片段', 'settings.validation_failed': '验证失败', 'settings.restart_error': '后端重启失败', 'settings.restart_unowned': '该后端不是由本应用启动的，无法从这里自动重启；请在启动它的地方重启。', 'settings.provider_needs_key': '{provider} 尚未配置 API Key，请在下方填写后即可生效。',
  'settings.asset.character_optional': '可选。没有此资源包，聊天、工作页和无界面模式仍可用。', 'settings.label.visual_pack': '视觉运行时资源包', 'settings.label.character_pack': '红莉栖角色包',
  'settings.label.vision_context': '视觉上下文', 'settings.label.vision_mode': '视觉模式',
  'settings.label.vision_scope': '视觉范围', 'settings.label.vision_provider': '视觉提供方',
  'settings.label.vision_size': '视觉图像尺寸', 'settings.label.vision_quality': '视觉 JPEG 质量',
  'settings.label.interface_language': '界面语言', 'settings.label.chat_translation': '聊天翻译字幕',
  'settings.label.wallpaper_caption': '壁纸字幕模式', 'settings.label.current_model': '当前模型配置',
  'settings.avatar.user': '你的头像', 'settings.avatar.user_detail': '显示在你的消息旁', 'settings.avatar.assistant': '红莉栖头像', 'settings.avatar.assistant_detail': '显示在 Amadeus 回复旁', 'settings.avatar.opening': '正在打开…', 'settings.avatar.replace': '替换', 'settings.avatar.choose': '选择图片', 'settings.avatar.restore': '恢复默认 {name}', 'settings.avatar.note': '应用会在本地资源中保存居中的 PNG 副本，不会修改原始文件。', 'settings.avatar.load_error': '无法加载聊天头像', 'settings.avatar.save_error': '无法保存头像', 'settings.avatar.restore_error': '无法恢复默认头像',
  'settings.label.tts_mode': '本地 TTS 推理模式', 'settings.label.tts_language': 'TTS 输出语言',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.cuda_graph': 'CUDA Graph ×1', 'settings.option.parallel': '并行 ×2', 'settings.option.auto': '自动', 'settings.option.on_demand': '按需', 'settings.option.watching': '监看', 'settings.option.self_aware': '自感知', 'settings.option.wallpaper_surface': '壁纸表面', 'settings.option.region': '区域', 'settings.option.buffered': '缓冲 WAV · 兼容', 'settings.option.openai_sse': 'OpenAI SSE · 流式 PCM',
  'settings.status.registered': '已注册', 'settings.status.unavailable': '不可用', 'settings.status.configured': '已配置', 'settings.status.needs_setup': '需要设置', 'settings.status.available': '可用', 'settings.status.disabled': '已禁用', 'settings.status.not_installed': '未安装', 'settings.status.remote': '远程', 'settings.status.enabled': '已启用', 'settings.status.no_access': '无访问权限', 'settings.status.none': '无', 'settings.status.not_bound': '未绑定', 'settings.status.no_active_binding': '没有活动的提供方绑定', 'settings.status.work_providers_only': '仅限工作提供方', 'settings.kind.mcp': 'MCP', 'settings.kind.skill': '技能', 'settings.capability.consumers': '使用方：', 'settings.capability.scope': '范围：', 'settings.capability.projection': '投影：', 'settings.capability.source': '来源：', 'settings.capability.no_binding': '没有活动的提供方绑定', 'settings.capability.none': '无',
  'settings.status.active': '活动',
  'mcp.boundary.title': '仅限提供方的边界', 'mcp.boundary.body': 'MCP 连接只对兼容的工作提供方可用，主聊天无法访问 MCP 工具。', 'mcp.enabled': '已启用', 'mcp.disabled': '已禁用', 'mcp.providers': '提供方：', 'mcp.not_bound': '未绑定', 'mcp.main_chat': '主聊天：', 'mcp.no_access': '无访问权限', 'mcp.encrypted_environment': '加密环境：', 'mcp.none': '无', 'mcp.test': '测试', 'mcp.testing': '连接中…', 'mcp.test_title': '连接并发现工具', 'mcp.restart_test_title': '测试前请重启后端', 'mcp.edit': '编辑', 'mcp.remove': '移除', 'mcp.confirm_remove': '确认移除', 'mcp.edit_title': '编辑 MCP 连接', 'mcp.add_title': '添加 MCP 服务器', 'mcp.editor_detail': '由主机保存，重启后应用到选定的工作提供方。', 'mcp.close': '关闭 MCP 编辑器', 'mcp.name': '名称', 'mcp.transport': '传输方式', 'mcp.stdio_command': 'stdio 命令', 'mcp.streamable_http': '可流式 HTTP', 'mcp.command': '命令', 'mcp.arguments': '参数', 'mcp.working_directory': '工作目录', 'mcp.server_url': '服务器 URL', 'mcp.bearer_env': 'Bearer 令牌环境变量', 'mcp.encrypted_values': '加密环境值', 'mcp.keep_environment': '留空以保留已存储值；使用 KEY= 删除一项', 'mcp.environment_optional': '可选 · 每行一个 KEY=value', 'mcp.stored': '已存储：', 'mcp.compatible_providers': '兼容的工作提供方', 'mcp.no_compatible_provider': '当前没有已安装的工作提供方接受 MCP 连接。', 'mcp.enable_selected': '为选定提供方启用', 'mcp.no_main_chat_grant': '保存连接不会授予主聊天访问权限。', 'mcp.cancel': '取消', 'mcp.save': '保存连接', 'mcp.add': '+ 添加 MCP 服务器', 'mcp.locked': 'MCP 注册表已被父进程环境锁定。', 'mcp.empty': '未配置 MCP 连接。', 'mcp.connected_tools': '已连接 · 发现 {count} 个工具', 'mcp.connection_failed': '连接失败', 'mcp.save_error': '无法保存 MCP 连接', 'mcp.remove_error': '无法移除 MCP 连接', 'mcp.optional': '可选', 'mcp.bearer_optional': '可选 · 例如 MCP_TOKEN',
  'chat.error.decode_image': '无法解码图片', 'chat.error.read_image': '无法读取图片', 'chat.error.choose_image': '请选择图片文件。', 'chat.error.canvas': '画布不可用。', 'chat.error.send_failed': '发送失败：后端不可达', 'chat.error.attach_image': '无法附加图片', 'chat.error.create_session': '无法创建会话', 'chat.error.create_project_chat': '无法创建项目聊天', 'chat.error.select_project_directory': '无法选择项目目录', 'chat.error.create_project': '无法创建项目', 'chat.error.load_project_apps': '无法加载项目应用', 'chat.error.load_draft_apps': '无法加载最近的 Draft 应用', 'chat.error.open_artifact_chat': '无法打开 Artifact 对话', 'chat.error.prepare_auip': '无法准备 AUIP 应用', 'chat.error.launch_descriptor': '主机未返回完整的 AUIP 启动描述。', 'chat.error.host_refused': '桌面主机拒绝了 AUIP 应用。', 'chat.error.promote_draft_app': '无法提升 Draft 应用', 'chat.error.move_chat': '无法移动聊天', 'chat.error.promote_draft': '无法提升 Draft', 'chat.error.delete_session': '无法删除会话', 'chat.error.rename_session': '无法重命名会话',
  'chat.remove_image': '移除图片', 'chat.refresh': '刷新',

  'scene.attach_image': '附加图片', 'scene.attach_needs_visual_provider': '请选择 OpenAI / Anthropic / Gemini 系协议提供方以附加图片',
  'scene.character_missing': '场景已就绪，但 Amadeus 还没有出现', 'scene.approval_unavailable': '授权信息不完整，请刷新后再决定',
  'scene.export_needs_recovery': '导出需要你决定',
  'scene.approve_once': '仅此次允许', 'scene.deny': '拒绝', 'scene.retry_export': '重试导出', 'scene.abandon_export': '放弃导出',
  'scene.transcript': '对话记录',
  'scene.collapse': '收起', 'scene.new_task': '新建任务', 'scene.current_task': '当前任务',
  'scene.send': '发送', 'scene.mic_start': '开始语音输入', 'scene.mic_stop': '停止语音输入',
  'scene.placeholder': '对 Amadeus 说点什么…', 'scene.placeholder_offline': '正在连接后端…',
  'scene.listening': '正在聆听…', 'scene.streaming': '正在回应…',
  'scene.notice_permission': '需要授权：{detail}', 'scene.notice_failed': '任务失败：{detail}',
  'scene.dismiss': '收起', 'scene.empty_transcript': '这个任务还没有对话。',
  'scene.starting': '正在唤起场景…', 'scene.waiting_backend': '正在等待后端…',
  'scene.failed_title': '场景未能启动', 'scene.retry': '重试',
  'scene.role_user': '主人', 'scene.role_system': '系统', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '设置', 'scene.workboard': '工作面板',
  'scene.legacy_entry': '旧版聊天界面（调试）', 'scene.legacy_title': '开发 / 诊断回退入口', 'scene.legacy_description': '离开场景，进入旧版聊天界面。仅供诊断，正常入口是场景。', 'scene.legacy_open': '打开旧版聊天界面',
  'scene.notify_title': 'Amadeus 任务已结束',
  'scene.work_needs_permission': '需要你的授权', 'chat.error.prefix': '错误：{error}',
}

const JA: Messages = {
  ...EN,
  ...MAIN_LOCALE_MESSAGES['ja-JP'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '設定', 'settings.restart': '適用するにはバックエンドを再起動', 'settings.restarting': '再起動中…',
  'settings.loading_error': '設定を読み込めません', 'settings.save_error': '{key} を保存できません', 'settings.update_error': '{key} を更新できません', 'settings.saving': '{key} を保存中…', 'settings.asset.character_content': '{frames} 個の KTX2 フレーム · {path}',
  'settings.section.general': '概要', 'settings.section.models': 'モデル', 'settings.section.asr': '音声認識', 'settings.section.tts': '音声合成', 'settings.section.providers': 'プロバイダー', 'settings.section.mcp': 'MCP', 'settings.section.skills': 'Skills', 'settings.aria_sections': '設定セクション',

  'settings.security.available': '秘密情報は OS により保護されています', 'settings.security.unavailable': 'OS の秘密情報暗号化を利用できません', 'settings.restart_pending': '保存済みの変更はバックエンドの再起動で反映されます', 'settings.restart_pending_detail': '自動で再起動します。ここから再起動できない場合は右のボタンを使用してください。',
  'settings.overview.title': 'ランタイム概要', 'settings.overview.model': 'メインモデル', 'settings.overview.listening': '音声認識', 'settings.overview.speaking': '音声合成',
  'settings.group.chat_appearance': 'チャットの外観', 'settings.group.avatar_compatibility': 'アバター互換性', 'settings.group.vision': 'マルチモーダルとビジョン', 'settings.group.chat_voice': '表示と言語', 'settings.group.main_model': 'メインチャットモデル', 'settings.group.active_connections': '現在のモデル接続', 'settings.group.voice_output': '合成と出力', 'settings.group.runtime_presentation': 'ランタイム表示', 'settings.group.work_providers': 'Work Provider 接続', 'settings.group.mcp': 'MCP 接続', 'settings.group.capabilities': '共有 Provider 機能',
  'settings.group.asr_current': '現在の設定', 'settings.group.asr_configuration': '認識設定', 'settings.group.asr_capture': 'マイクと端点検出', 'settings.group.asr_remaining': 'その他の設定', 'settings.label.asr_mode': '認識バックエンド', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（ローカル）', 'settings.asrBackend.sense_voice': 'SenseVoice（ローカル）', 'settings.asrBackend.openai_compatible': 'OpenAI 互換文字起こし（リモート）', 'settings.asrBackend.mimo': 'MiMo ASR モデル（Xiaomi・リモート）',

  'settings.note.no_user_settings': 'ユーザー管理の接続設定はありません。', 'settings.note.no_active_connection': '選択中のアクティブな接続はありません。', 'settings.no_skills': 'このバックエンドプロセスで Work Provider と共有されるスキルはありません。', 'settings.advanced_roles': '高度なモデルロール', 'settings.other_connections': 'その他のモデル接続', 'settings.other_voice_backends': 'その他の音声合成バックエンド',
  'settings.avatar.user': 'ユーザーアバター', 'settings.avatar.user_detail': 'あなたのメッセージの横に表示', 'settings.avatar.assistant': '紅莉栖アバター', 'settings.avatar.assistant_detail': 'Amadeus の返信の横に表示', 'settings.avatar.opening': '開いています…', 'settings.avatar.replace': '置換', 'settings.avatar.choose': '画像を選択', 'settings.avatar.restore': '既定の {name} に戻す', 'settings.avatar.note': 'アプリのローカルアセットに中央揃えの PNG コピーを保存します。元ファイルは変更しません。', 'settings.avatar.load_error': 'チャットアバターを読み込めません', 'settings.avatar.save_error': 'アバターを保存できません', 'settings.avatar.restore_error': '既定のアバターに戻せません',
  'settings.saving_label': '保存中…', 'settings.placeholder.secret_replace': '設定済み — 入力して置換', 'settings.placeholder.secret_empty': '未設定', 'settings.action.save': '保存', 'settings.action.clear': 'クリア', 'settings.action.on': 'オン', 'settings.action.off': 'オフ',
  'settings.asset.installed': 'インストール済み', 'settings.asset.incomplete': '不完全', 'settings.asset.invalid': '無効なパッケージ', 'settings.asset.not_installed': '未インストール', 'settings.asset.visual_content': '環境レイヤー、字幕、シナリオメディア、壁紙音声アセットが利用できます。', 'settings.asset.visual_optional': 'オプションです。内蔵壁紙、Chat、Work、ヘッドレスモードはなくても利用できます。', 'settings.asset.character_optional': 'オプションです。このパッケージがなくても Chat、Work、ヘッドレスモードは利用できます。', 'settings.label.visual_pack': 'ビジュアルランタイムパック', 'settings.label.character_pack': '紅莉栖キャラクターパック',
  'settings.asset.visual_attention': 'オプションのビジュアルパックに要確認事項があります：{detail}', 'settings.asset.character_attention': 'オプションパッケージが不完全です：{detail}', 'settings.asset.clips': 'クリップ', 'settings.validation_failed': '検証に失敗しました', 'settings.restart_error': 'バックエンドの再起動に失敗しました', 'settings.restart_unowned': 'このバックエンドは本アプリが起動したものではないため、ここから再起動できません。起動した場所で再起動してください。', 'settings.provider_needs_key': '{provider} の API キーが未設定です。下で入力すると反映されます。',
  'settings.label.vision_context': 'ビジョンコンテキスト', 'settings.label.vision_mode': 'ビジョンモード', 'settings.label.vision_scope': 'ビジョン範囲', 'settings.label.vision_provider': 'ビジョンプロバイダー', 'settings.label.vision_size': 'ビジョン画像サイズ', 'settings.label.vision_quality': 'ビジョン JPEG 品質', 'settings.label.interface_language': 'インターフェース言語', 'settings.label.chat_translation': 'チャット翻訳字幕', 'settings.label.wallpaper_caption': '壁紙キャプションモード', 'settings.label.current_model': '現在のモデルプロファイル', 'settings.label.tts_mode': 'ローカル TTS 推論モード', 'settings.label.tts_language': 'TTS 出力言語',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.cuda_graph': 'CUDA Graph ×1', 'settings.option.parallel': '並列 ×2', 'settings.option.auto': '自動', 'settings.option.on_demand': 'オンデマンド', 'settings.option.watching': '監視', 'settings.option.self_aware': '自己認識', 'settings.option.wallpaper_surface': '壁紙サーフェス', 'settings.option.region': '範囲', 'settings.option.custom': 'カスタム', 'settings.option.buffered': 'バッファー WAV · 互換', 'settings.option.openai_sse': 'OpenAI SSE · ストリーミング PCM',
  'settings.status.registered': '登録済み', 'settings.status.unavailable': '利用不可', 'settings.status.configured': '設定済み', 'settings.status.needs_setup': '設定が必要', 'settings.status.available': '利用可能', 'settings.status.disabled': '無効', 'settings.status.not_installed': '未インストール', 'settings.status.remote': 'リモート', 'settings.status.enabled': '有効', 'settings.status.no_access': 'アクセスなし', 'settings.status.none': 'なし', 'settings.status.not_bound': '未バインド', 'settings.status.no_active_binding': '有効な Provider バインドなし', 'settings.status.work_providers_only': 'Work Provider のみ', 'settings.kind.mcp': 'MCP', 'settings.kind.skill': 'Skill', 'settings.capability.consumers': '利用者：', 'settings.capability.scope': '範囲：', 'settings.capability.projection': '投影：', 'settings.capability.source': 'ソース：', 'settings.capability.no_binding': '有効な Provider バインドなし', 'settings.capability.none': 'なし',
  'settings.status.active': '有効',
  'mcp.boundary.title': 'Provider 専用境界', 'mcp.boundary.body': 'MCP 接続は互換性のある Work Provider だけが利用でき、Main Chat は MCP ツールへアクセスできません。', 'mcp.enabled': '有効', 'mcp.disabled': '無効', 'mcp.providers': 'Provider：', 'mcp.not_bound': '未バインド', 'mcp.main_chat': 'Main Chat：', 'mcp.no_access': 'アクセスなし', 'mcp.encrypted_environment': '暗号化環境：', 'mcp.none': 'なし', 'mcp.test': 'テスト', 'mcp.testing': '接続中…', 'mcp.test_title': '接続してツールを検出', 'mcp.restart_test_title': 'テスト前にバックエンドを再起動', 'mcp.edit': '編集', 'mcp.remove': '削除', 'mcp.confirm_remove': '削除を確認', 'mcp.edit_title': 'MCP 接続を編集', 'mcp.add_title': 'MCP サーバーを追加', 'mcp.editor_detail': 'Host が保存し、再起動後に選択した Work Provider へ適用します。', 'mcp.close': 'MCP エディターを閉じる', 'mcp.name': '名前', 'mcp.transport': 'トランスポート', 'mcp.stdio_command': 'stdio コマンド', 'mcp.streamable_http': 'Streamable HTTP', 'mcp.command': 'コマンド', 'mcp.arguments': '引数', 'mcp.working_directory': '作業ディレクトリ', 'mcp.server_url': 'サーバー URL', 'mcp.bearer_env': 'Bearer トークン環境変数', 'mcp.encrypted_values': '暗号化環境値', 'mcp.keep_environment': '空欄で保存済みの値を維持。削除には KEY= を使用', 'mcp.environment_optional': 'オプション · 1 行に 1 つの KEY=value', 'mcp.stored': '保存済み：', 'mcp.compatible_providers': '互換性のある Work Provider', 'mcp.no_compatible_provider': '現在 MCP 接続を受け付けるインストール済み Work Provider はありません。', 'mcp.enable_selected': '選択した Provider で有効化', 'mcp.no_main_chat_grant': '接続を保存しても Main Chat へのアクセス権は付与されません。', 'mcp.cancel': 'キャンセル', 'mcp.save': '接続を保存', 'mcp.add': '+ MCP サーバーを追加', 'mcp.locked': 'MCP レジストリは親プロセス環境によってロックされています。', 'mcp.empty': 'MCP 接続は設定されていません。', 'mcp.connected_tools': '接続済み · {count} 個のツールを検出', 'mcp.connection_failed': '接続に失敗しました', 'mcp.save_error': 'MCP 接続を保存できません', 'mcp.remove_error': 'MCP 接続を削除できません', 'mcp.optional': 'オプション', 'mcp.bearer_optional': 'オプション · 例: MCP_TOKEN',
  'chat.error.decode_image': '画像をデコードできません', 'chat.error.read_image': '画像を読み込めません', 'chat.error.choose_image': '画像ファイルを選択してください。', 'chat.error.canvas': 'キャンバスを利用できません。', 'chat.error.send_failed': '送信失敗：バックエンドに接続できません', 'chat.error.attach_image': '画像を添付できません', 'chat.error.create_session': 'セッションを作成できません', 'chat.error.create_project_chat': 'Project チャットを作成できません', 'chat.error.select_project_directory': 'Project ディレクトリを選択できません', 'chat.error.create_project': 'Project を作成できません', 'chat.error.load_project_apps': 'Project アプリを読み込めません', 'chat.error.load_draft_apps': '最近の Draft アプリを読み込めません', 'chat.error.open_artifact_chat': 'Artifact 会話を開けません', 'chat.error.prepare_auip': 'AUIP アプリを準備できません', 'chat.error.launch_descriptor': 'Host が完全な AUIP 起動記述子を返しませんでした。', 'chat.error.host_refused': 'デスクトップ Host が AUIP アプリを拒否しました。', 'chat.error.promote_draft_app': 'Draft アプリを Project に昇格できません', 'chat.error.move_chat': 'チャットを移動できません', 'chat.error.promote_draft': 'Draft を Project に昇格できません', 'chat.error.delete_session': 'セッションを削除できません', 'chat.error.rename_session': 'セッション名を変更できません',
  'chat.remove_image': '画像を削除', 'chat.refresh': '更新',

  'scene.attach_image': '画像を添付', 'scene.attach_needs_visual_provider': '画像を添付するには OpenAI / Anthropic / Gemini 系プロトコルを選択してください',
  'scene.character_missing': 'シーンは表示されていますが、Amadeus はまだ現れていません', 'scene.approval_unavailable': '権限情報が不完全です。更新してから決定してください',
  'scene.export_needs_recovery': 'エクスポートの判断が必要です',
  'scene.approve_once': '今回のみ許可', 'scene.deny': '拒否', 'scene.retry_export': 'エクスポートを再試行', 'scene.abandon_export': 'エクスポートを中止',
  'scene.transcript': '会話履歴',
  'scene.collapse': '閉じる', 'scene.new_task': '新しいタスク', 'scene.current_task': '現在のタスク',
  'scene.send': '送信', 'scene.mic_start': '音声入力を開始', 'scene.mic_stop': '音声入力を停止',
  'scene.placeholder': 'Amadeus に話しかける…', 'scene.placeholder_offline': 'バックエンドに接続中…',
  'scene.listening': '聞き取り中…', 'scene.streaming': '応答中…',
  'scene.notice_permission': '権限が必要です：{detail}', 'scene.notice_failed': 'タスク失敗：{detail}',
  'scene.dismiss': '閉じる', 'scene.empty_transcript': 'このタスクにはまだ会話がありません。',
  'scene.starting': 'シーンを起動しています…', 'scene.waiting_backend': 'バックエンドを待機中…',
  'scene.failed_title': 'シーンを起動できませんでした', 'scene.retry': '再試行',
  'scene.role_user': 'あなた', 'scene.role_system': 'システム', 'scene.role_assistant': 'Amadeus',
  'scene.settings': '設定', 'scene.workboard': 'Work サーフェス',
  'scene.legacy_entry': '旧チャット画面（デバッグ）', 'scene.legacy_title': '開発 / 診断用フォールバック', 'scene.legacy_description': 'シーンを離れて旧チャット画面を開きます。診断専用で、通常はシーンを使います。', 'scene.legacy_open': '旧チャット画面を開く',
  'scene.notify_title': 'Amadeus のタスクが終了しました',
  'scene.work_needs_permission': '権限が必要です', 'chat.error.prefix': 'エラー：{error}',
}

export const MESSAGES: Record<Locale, Messages> = { 'en-US': EN, 'zh-CN': ZH, 'ja-JP': JA }
export type MessageKey = keyof typeof EN

type SettingCopy = Record<'group' | 'field' | 'description' | 'groupDescription' | 'status' | 'option', Record<string, string>>

const ZH_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（本地）', speech_synthesis: 'Fish Audio 实时合成',
  },
  field: {
    asr_language: '识别语言', FISH_API_KEY: 'Fish Audio API 密钥', FISH_VOICE_ID: 'Fish 声音 ID', FISH_API_MODEL: 'Fish 模型',
  },
  description: {}, groupDescription: {}, status: {}, option: {},
}

const JA_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（ローカル）', speech_synthesis: 'Fish Audio リアルタイム合成',
  },
  field: {
    asr_language: '認識言語', FISH_API_KEY: 'Fish Audio API キー', FISH_VOICE_ID: 'Fish ボイス ID', FISH_API_MODEL: 'Fish モデル',
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
