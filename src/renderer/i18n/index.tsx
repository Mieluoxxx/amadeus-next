import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { interpolate, normalizeLocale, type Locale, SUPPORTED_LOCALES } from './core'

export { interpolate, normalizeLocale, SUPPORTED_LOCALES }
export type { Locale }

type Messages = Record<string, string>

const MAIN_LOCALE_MESSAGES = {
  'en-US': {
    'chat.provider': 'Chat provider', 'chat.microphone': 'Toggle microphone input', 'chat.send': 'Send message', 'chat.interacting_prefix': 'Interacting with Amadeus about',
    'activity.summary_failed': '{completed} completed · {failed} failed · observable activity only',
    'backend.error_prefix': 'ERROR:', 'backend.render_status': 'Render:', 'backend.wallpaper_status': 'Wallpaper:',
  },
  'zh-CN': {
    'chat.provider': '聊天提供方', 'chat.microphone': '切换麦克风输入', 'chat.send': '发送消息', 'chat.interacting_prefix': '正在与 Amadeus 讨论',
    'activity.summary_failed': '已完成 {completed} 个 · 失败 {failed} 个 · 仅显示可观察活动',
    'backend.error_prefix': '错误：', 'backend.render_status': '渲染：', 'backend.wallpaper_status': '壁纸：',
  },
  'ja-JP': {
    'chat.provider': 'チャット Provider', 'chat.microphone': 'マイク入力を切り替え', 'chat.send': 'メッセージを送信', 'chat.interacting_prefix': 'Amadeus と対話中',
    'activity.summary_failed': '{completed} 件完了 · {failed} 件失敗 · 観測可能なアクティビティのみ',
    'backend.error_prefix': 'ERROR:', 'backend.render_status': 'レンダー：', 'backend.wallpaper_status': '壁紙：',
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
  'settings.section.general_detail': 'Current health, appearance, vision, and interface preferences.',
  'settings.section.models_detail': 'Choose the conversational model and configure only the connections you use.',
  'settings.section.asr_detail': 'Conversation and wake recognition, plus acoustic processing.',
  'settings.section.tts_detail': 'Synthesis backend, output language, and runtime mode.',
  'settings.section.providers_detail': 'Manage delegated work providers.',
  'settings.section.mcp_detail': 'Manage host-managed MCP connections and their shared servers.',
  'settings.section.skills_detail': 'Skill packages shared across compatible Work Providers.',
  'settings.aria_sections': 'Settings sections',
  'settings.security.available': 'Secrets protected by the operating system',
  'settings.security.unavailable': 'System secret encryption unavailable',
  'settings.restart_pending': 'Saved changes need a backend restart',
  'settings.restart_pending_detail': 'Applied automatically. Use the button if this backend cannot be restarted from here.',
  'settings.overview.title': 'Runtime overview',
  'settings.overview.model': 'Main model',
  'settings.overview.listening': 'Speech recognition',
  'settings.overview.speaking': 'Speech synthesis',
  'settings.group.optional_assets': 'Optional Runtime Assets',
  'settings.group.chat_appearance': 'Chat appearance',
  'settings.group.avatar_compatibility': 'Avatar compatibility',
  'settings.group.vision': 'Multimodal & Vision',
  'settings.group.chat_voice': 'Chat & Voice',
  'settings.group.main_model': 'Main chat model',
  'settings.group.model_connections': 'Model connections',
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
  'settings.group.voice_backends': 'Voice backends',
  'settings.group.work_providers': 'Work Provider connections',
  'settings.group.mcp': 'MCP connections',
  'settings.group.capabilities': 'Shared Provider capabilities',
  'settings.detail.chat_appearance': 'Local presentation only; avatar images are never sent to the model.',
  'settings.detail.avatar_compatibility': 'Optional output paths are disabled unless explicitly enabled.',
  'settings.detail.main_model': 'These controls affect the current backend process. Connection edits below are desktop defaults and require a restart.',
  'settings.detail.model_connections': 'Secrets are encrypted by the operating system and are never returned to the renderer.',
  'settings.detail.runtime_presentation': 'These controls apply immediately and do not select the synthesis or recognition provider.',
  'settings.detail.voice_backends': 'Startup configuration. Secrets are encrypted by the operating system and never returned to this page.',
  'settings.detail.work_providers': 'Registered means the adapter passed its startup boundary. Remote availability is verified when that Provider connects.',
  'settings.detail.mcp': 'Host-managed connections are projected only into explicitly compatible Work Providers.',
  'settings.detail.capabilities': 'Installed once by the Host, then projected only to Providers that explicitly support the capability shape.',
  'settings.note.no_user_settings': 'No user-managed connection settings.',
  'settings.note.no_active_connection': 'No active connection is selected.',
  'settings.no_skills': 'No skills are shared with Work Providers in this backend process.',
  'settings.advanced_roles': 'Advanced model roles',
  'settings.other_connections': 'Other model connections',
  'settings.other_voice_backends': 'Other synthesis backends',
  'settings.field.locked': 'locked',
  'settings.field.restart_required': 'restart required',
  'settings.source.environment': 'Process environment',
  'settings.source.user': 'Desktop settings',
  'settings.source.dotenv': '.env',
  'settings.source.default': 'Built-in default',
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
  'settings.label.vision_context_detail': 'Attach a scoped screenshot to visual chat turns',
  'settings.label.vision_mode': 'Vision Mode',
  'settings.label.vision_mode_detail': 'On-demand captures when asked; watching attaches one fresh frame to each chat turn',
  'settings.label.vision_scope': 'Vision Scope',
  'settings.label.vision_scope_detail': 'Choose what Amadeus may capture for a visual turn',
  'settings.label.vision_provider': 'Vision Provider',
  'settings.label.vision_provider_detail': 'Direct image input is supported first by the OpenAI, Anthropic and Gemini protocols',
  'settings.label.vision_size': 'Vision Image Size',
  'settings.label.vision_size_detail': 'Maximum long edge sent to the model',
  'settings.label.vision_quality': 'Vision JPEG Quality',
  'settings.label.vision_quality_detail': 'Higher quality increases request payload size',
  'settings.label.interface_language': 'Interface language',
  'settings.label.interface_language_detail': 'Also controls process cards and Provider summaries',
  'settings.label.chat_translation': 'Chat Translation Subtitles',
  'settings.label.chat_translation_detail': 'Show Simplified Chinese below completed Japanese assistant messages. Display-only; never added to conversation history.',
  'settings.label.wallpaper_caption': 'Wallpaper Caption Mode',
  'settings.label.wallpaper_caption_detail': 'Choose translated, source, bilingual, or no captions',
  'settings.label.current_model': 'Current model profile',
  'settings.label.current_model_detail': 'The model used by the main conversational role',
  'settings.label.tts_mode': 'Local TTS inference mode',
  'settings.label.tts_mode_detail': 'Used by the Amadeus GPT-SoVITS v3 rewrite; switch while TTS is idle',
  'settings.label.tts_language': 'TTS output language',
  'settings.label.tts_language_detail': 'Updates sentence splitting, cache keys, and embedded reference selection',
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
  'settings.field.ASR_BACKEND': 'Backend',
  'settings.field.ASR_LANGUAGE': 'Recognition language',
  'settings.field.ASR_CONTEXT': 'Context and terminology',
  'settings.field.QWEN3_ASR_MODEL_PATH': 'Qwen model directory',
  'settings.field.QWEN3_ASR_DEVICE': 'Qwen device',
  'settings.field.QWEN3_ASR_REQUIRE_CUDA': 'Require Qwen CUDA',
  'settings.field.MICROPHONE_DEVICE_INDEX': 'Microphone',
  'settings.field.MICROPHONE_PREFERRED_NAME': 'Preferred microphone name',
  'settings.field.ASR_LISTEN_TIMEOUT_SECONDS': 'Wait for speech',
  'settings.field.ASR_VAD_SILENCE_MS': 'End-of-speech pause',
  'settings.field.ASR_API_BASE_URL': 'API base URL',
  'settings.field.ASR_API_KEY': 'API key',
  'settings.field.ASR_API_MODEL': 'Model',
  'settings.field.WAKE_ENABLED': 'Wake service',
  'settings.field.WAKE_PHRASES': 'Wake phrases',
  'settings.field.WAKE_AUTO_SEND_TO_CHAT': 'Send command to Chat',
  'settings.field.WAKE_ASR_BACKEND': 'Wake backend',
  'settings.field.WAKE_SENSEVOICE_LANGUAGES': 'Wake languages',
  'settings.field.SENSEVOICE_LANGUAGE': 'SenseVoice conversation language',
  'settings.field.SENSEVOICE_MODEL_PATH': 'SenseVoice model path',
  'settings.field.AEC_REALTIME_ENABLED': 'Realtime echo cancellation',
  'settings.field.AEC_REALTIME_BARGE_IN': 'Allow microphone interruption',
  'settings.field.AEC_REALTIME_DELAY_MS': 'AEC reference delay',
  'settings.field.TTS_REF_AUDIO_JA': 'Japanese reference audio',
  'settings.field.TTS_REF_TEXT_JA': 'Japanese reference transcript',
  'settings.field.TTS_REF_AUDIO_EN': 'English reference audio',
  'settings.field.TTS_REF_TEXT_EN': 'English reference transcript',
  'settings.field.TTS_BACKEND': 'Backend',
  'settings.field.TTS_DEVICE': 'Inference device',
  'settings.field.TTS_GPT_MODEL_PATH': 'GPT semantic checkpoint (v3)',
  'settings.field.TTS_SOVITS_MODEL_PATH': 'SoVITS acoustic checkpoint (v3)',
  'settings.field.TTS_API_BASE_URL': 'API base URL',
  'settings.field.TTS_API_KEY': 'API key',
  'settings.field.TTS_API_MODEL': 'Model',
  'settings.field.TTS_API_VOICE': 'Voice',
  'settings.field.TTS_API_STREAM_PROTOCOL': 'Response mode',
  'settings.field.MIMO_TTS_BASE_URL': 'API base URL',
  'settings.field.MIMO_TTS_API_KEY': 'API key',
  'settings.field.MIMO_TTS_MODEL': 'Model',
  'settings.field.MIMO_TTS_VOICE': 'Voice',
  'settings.field.VTS_ENABLED': 'Enable compatibility output',
  'settings.field.VTS_WS_URL': 'WebSocket URL',
  'settings.field.VTS_TOKEN_FILE': 'Authentication token file',
  'chat.error.decode_image': 'Could not decode image', 'chat.error.read_image': 'Could not read image', 'chat.error.choose_image': 'Please choose an image file.', 'chat.error.canvas': 'Canvas is unavailable.', 'chat.error.send_failed': 'Send failed: backend unreachable', 'chat.error.attach_image': 'Could not attach image', 'chat.error.create_session': 'Could not create session', 'chat.error.create_project_chat': 'Could not create the Project chat', 'chat.error.select_project_directory': 'Could not select a Project directory', 'chat.error.create_project': 'Could not create the Project', 'chat.error.load_project_apps': 'Could not load Project apps', 'chat.error.load_draft_apps': 'Could not load recent Draft apps', 'chat.error.open_artifact_chat': 'Could not open the Artifact conversation', 'chat.error.prepare_auip': 'Could not prepare the AUIP application', 'chat.error.launch_descriptor': 'The Host did not return a complete AUIP launch descriptor.', 'chat.error.host_refused': 'The desktop Host refused the AUIP application.', 'chat.error.promote_draft_app': 'Could not promote the Draft app', 'chat.error.move_chat': 'Could not move the chat', 'chat.error.promote_draft': 'Could not promote the Draft', 'chat.error.delete_session': 'Could not delete session', 'chat.error.rename_session': 'Could not rename session',
  'chat.rename_prompt': 'Rename session', 'chat.start': 'Type a message to start.', 'chat.dismiss_context': 'Dismiss Artifact context label', 'chat.remove_image': 'Remove image', 'chat.ask_artifact': 'Ask Amadeus about {title}…', 'chat.select_visual_provider': 'Select an OpenAI, Anthropic or Gemini protocol provider to use visual input', 'chat.vision_watching': 'Global vision watching is on. Hold to turn it off. Right-click to choose a window.', 'chat.vision_pending': '{name} will be sent with the next message. Click to choose another image; hold for watching; right-click for window.', 'chat.vision_choose': 'Choose an image for the next message. Hold for watching; right-click for window.', 'chat.refresh': 'Refresh', 'chat.pixi_render': 'PixiJS Render', 'chat.switch_vts': 'Switch to VTS render', 'chat.current_render': 'Current: {mode}. Click to switch.', 'chat.expression_presets': 'Open expression presets', 'chat.transparent_overlay': 'Open transparent overlay', 'session.delete': 'Delete chat', 'session.no_chats': 'No chats yet', 'session.drafts': 'Drafts', 'activity.working': 'Working', 'activity.completed': 'Completed', 'activity.failed': 'Failed', 'activity.cancelled': 'Cancelled', 'activity.waiting': 'Waiting', 'activity.preparing': 'Preparing the provider run…', 'activity.waiting_observable': 'Waiting for observable provider activity.', 'activity.summary': '{completed} completed · observable activity only', 'backend.title': 'Backend', 'backend.subtitle': 'Live runtime status and server diagnostics.', 'backend.connected': 'Connected', 'backend.offline': 'Offline', 'backend.server_log': 'Server log', 'backend.lines': 'lines', 'backend.refresh': 'Refresh', 'backend.no_log': 'No log output yet...', 'backend.controls': 'Runtime controls and connection details', 'backend.start_render': 'Start Render', 'backend.stop_render': 'Stop Render', 'backend.start_wallpaper': 'Start Wallpaper', 'backend.stop_wallpaper': 'Stop Wallpaper', 'backend.render': 'Render', 'backend.wallpaper': 'Wallpaper',
  'artifact.aria': '{name} artifacts', 'artifact.back': 'Back to chat', 'artifact.recent_draft': 'RECENT DRAFT ARTIFACTS', 'artifact.project': 'PROJECT ARTIFACTS', 'artifact.loading': 'Loading', 'artifact.refresh': 'Refresh apps', 'artifact.new_chat': 'New chat', 'artifact.title': 'Artifacts', 'artifact.draft_description': 'The five most recent verified Draft artifacts. Open one, continue its original conversation, or promote the Draft to keep it as a Project.', 'artifact.project_description': 'Verified AUIP artifacts kept by this Project. Open the current revision, or enter its exact WorkItem conversation to continue with Amadeus.', 'artifact.older_drafts': 'Older Drafts fall outside this bounded recent view.', 'artifact.more_work': 'This Project has more WorkItems than this bounded view can show.', 'artifact.none': 'No verified AUIP artifacts yet', 'artifact.none_draft': 'No recent Draft contains a currently verified AUIP artifact.', 'artifact.none_project': 'Draft outputs stay with their WorkItem until you promote that Draft. Promoted artifacts appear here without copying their files.', 'artifact.version_unknown': 'version unknown', 'artifact.revision': 'revision {count}', 'artifact.verified_app': 'Verified interactive application', 'artifact.registered': 'registered', 'artifact.open': 'open', 'artifact.opening': 'Opening', 'artifact.interact': 'Interact with Amadeus', 'artifact.open_chat': 'Opening chat', 'artifact.promoting': 'Promoting', 'artifact.promote': 'Promote to Project',
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
  'scene.work_needs_permission': 'Needs your permission', 'chat.error.prefix': 'Error: {error}', 'chat.submode_graph': 'SpriteForge graph', 'chat.submode_sprite': 'Sprite frames', 'chat.submode_hybrid': 'Live2D idle + frames',
}

const ZH: Messages = {
  ...EN,
  ...MAIN_LOCALE_MESSAGES['zh-CN'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '设置', 'settings.restart': '重启后端以应用设置', 'settings.restarting': '正在重启…',
  'settings.loading_error': '无法加载设置', 'settings.save_error': '无法保存 {key}', 'settings.update_error': '无法更新 {key}', 'settings.saving': '正在保存 {key}…', 'settings.asset.character_content': '{frames} 个 KTX2 帧 · {path}',
  'settings.saving_label': '正在保存…', 'settings.section.general': '总览', 'settings.section.models': '模型', 'settings.section.asr': '语音识别', 'settings.section.tts': '语音合成', 'settings.section.providers': '提供方', 'settings.section.mcp': 'MCP', 'settings.section.skills': 'Skills',
  'settings.section.general_detail': '查看当前状态，并管理外观、视觉和界面偏好。', 'settings.section.models_detail': '选择主对话模型，只配置实际使用的连接。', 'settings.section.asr_detail': '管理会话识别、唤醒和声学处理。', 'settings.section.tts_detail': '管理合成后端、输出语言和运行时模式。', 'settings.section.providers_detail': '管理工作委托和提供方连接。', 'settings.section.mcp_detail': '管理 MCP 连接和共享的 MCP 服务器。', 'settings.section.skills_detail': '查看跨兼容提供方共享的技能包。',
  'settings.security.available': '密钥受操作系统保护', 'settings.security.unavailable': '系统密钥加密不可用', 'settings.restart_pending': '已保存的更改需要重启后端才能生效', 'settings.restart_pending_detail': '本应用会自动重启；若该后端无法从这里自动重启，请点击右侧按钮。',
  'settings.overview.title': '运行状态总览', 'settings.overview.model': '主模型', 'settings.overview.listening': '语音识别', 'settings.overview.speaking': '语音合成',
  'settings.aria_sections': '设置分区', 'settings.group.optional_assets': '可选运行时资源', 'settings.group.chat_appearance': '聊天外观', 'settings.group.avatar_compatibility': '头像兼容',
  'settings.group.vision': '多模态与视觉', 'settings.group.chat_voice': '界面与字幕', 'settings.group.main_model': '主聊天模型', 'settings.group.model_connections': '模型连接', 'settings.group.active_connections': '当前模型连接', 'settings.group.voice_output': '说话与合成',
  'settings.group.asr_current': '当前配置', 'settings.group.asr_configuration': '识别设置', 'settings.group.asr_capture': '麦克风与端点', 'settings.group.asr_remaining': '其余设置', 'settings.label.asr_mode': '识别后端', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（本地）', 'settings.asrBackend.sense_voice': 'SenseVoice（本地）', 'settings.asrBackend.openai_compatible': 'OpenAI 兼容转写（远程）', 'settings.asrBackend.mimo': '小米 ASR 模型（远程）',
  'settings.group.runtime_presentation': '运行时呈现', 'settings.group.voice_backends': '语音后端', 'settings.group.work_providers': '工作提供方连接', 'settings.group.mcp': 'MCP 连接', 'settings.group.capabilities': '共享提供方能力',
  'settings.detail.chat_appearance': '仅影响本地呈现；头像图片不会发送给模型。', 'settings.detail.avatar_compatibility': '可选输出路径只有在明确启用后才会使用。',
  'settings.detail.main_model': '这些控制项影响当前后端进程。下方连接编辑是桌面默认值，需要重启。', 'settings.detail.model_connections': '密钥由操作系统加密，绝不会返回渲染器。',
  'settings.detail.runtime_presentation': '这些控制项立即生效，不选择合成或识别提供方。', 'settings.detail.voice_backends': '启动配置。密钥由操作系统加密，绝不会返回此页面。',
  'settings.detail.work_providers': '已注册表示适配器通过了启动边界；远程可用性在提供方连接时验证。', 'settings.detail.mcp': '主机管理的连接只投影给明确兼容的工作提供方。', 'settings.detail.capabilities': '由主机安装一次，再只投影给明确支持该能力形态的提供方。',
  'settings.note.no_user_settings': '没有用户管理的连接设置。', 'settings.note.no_active_connection': '当前没有选中的活动连接。', 'settings.no_skills': '此后端进程中没有与提供方共享的技能。', 'settings.advanced_roles': '高级模型角色', 'settings.other_connections': '其他模型连接', 'settings.other_voice_backends': '其他语音合成后端',
  'settings.field.locked': '已锁定', 'settings.field.restart_required': '需要重启', 'settings.source.environment': '进程环境', 'settings.source.user': '桌面设置', 'settings.source.default': '内置默认值',
  'settings.placeholder.secret_replace': '已配置——输入以替换', 'settings.placeholder.secret_empty': '未配置', 'settings.action.save': '保存', 'settings.action.clear': '清除', 'settings.action.on': '开', 'settings.action.off': '关',
  'settings.asset.installed': '已安装', 'settings.asset.incomplete': '不完整', 'settings.asset.invalid': '无效包', 'settings.asset.not_installed': '未安装',
  'settings.asset.visual_content': '环境层、字幕、场景媒体和壁纸音频资源可用。', 'settings.asset.visual_optional': '可选。没有它，内置壁纸、聊天、工作页和无界面模式仍可用。',
  'settings.asset.visual_attention': '可选视觉资源包需要处理：{detail}', 'settings.asset.character_attention': '可选资源包不完整：{detail}', 'settings.asset.clips': '个片段', 'settings.validation_failed': '验证失败', 'settings.restart_error': '后端重启失败', 'settings.restart_unowned': '该后端不是由本应用启动的，无法从这里自动重启；请在启动它的地方重启。', 'settings.provider_needs_key': '{provider} 尚未配置 API Key，请在下方填写后即可生效。',
  'settings.asset.character_optional': '可选。没有此资源包，聊天、工作页和无界面模式仍可用。', 'settings.label.visual_pack': '视觉运行时资源包', 'settings.label.character_pack': '红莉栖角色包',
  'settings.label.vision_context': '视觉上下文', 'settings.label.vision_context_detail': '为视觉聊天附加限定范围的截图', 'settings.label.vision_mode': '视觉模式', 'settings.label.vision_mode_detail': '按需捕获；监看模式会为每轮聊天附加一帧新画面',
  'settings.label.vision_scope': '视觉范围', 'settings.label.vision_scope_detail': '选择 Amadeus 可以为视觉轮次捕获的内容', 'settings.label.vision_provider': '视觉提供方', 'settings.label.vision_provider_detail': '目前优先支持 OpenAI / Anthropic / Gemini 系协议的直接图像输入',
  'settings.label.vision_size': '视觉图像尺寸', 'settings.label.vision_size_detail': '发送给模型的最大长边', 'settings.label.vision_quality': '视觉 JPEG 质量', 'settings.label.vision_quality_detail': '质量越高，请求负载越大',
  'settings.label.interface_language': '界面语言', 'settings.label.interface_language_detail': '同时控制流程卡片和提供方摘要', 'settings.label.chat_translation': '聊天翻译字幕', 'settings.label.chat_translation_detail': '在完成的日语助手消息下显示简体中文；仅用于显示，不会写入对话历史。',
  'settings.label.wallpaper_caption': '壁纸字幕模式', 'settings.label.wallpaper_caption_detail': '选择译文、原文、双语或关闭字幕', 'settings.label.current_model': '当前模型配置', 'settings.label.current_model_detail': '主对话角色使用的模型',
  'settings.avatar.user': '你的头像', 'settings.avatar.user_detail': '显示在你的消息旁', 'settings.avatar.assistant': '红莉栖头像', 'settings.avatar.assistant_detail': '显示在 Amadeus 回复旁', 'settings.avatar.opening': '正在打开…', 'settings.avatar.replace': '替换', 'settings.avatar.choose': '选择图片', 'settings.avatar.restore': '恢复默认 {name}', 'settings.avatar.note': '应用会在本地资源中保存居中的 PNG 副本，不会修改原始文件。', 'settings.avatar.load_error': '无法加载聊天头像', 'settings.avatar.save_error': '无法保存头像', 'settings.avatar.restore_error': '无法恢复默认头像',
  'settings.label.tts_mode': '本地 TTS 推理模式', 'settings.label.tts_mode_detail': 'Amadeus GPT-SoVITS v3 重写版使用；请在 TTS 空闲时切换', 'settings.label.tts_language': 'TTS 输出语言', 'settings.label.tts_language_detail': '更新分句、缓存键和内置参考音频选择',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.cuda_graph': 'CUDA Graph ×1', 'settings.option.parallel': '并行 ×2', 'settings.option.auto': '自动', 'settings.option.on_demand': '按需', 'settings.option.watching': '监看', 'settings.option.self_aware': '自感知', 'settings.option.wallpaper_surface': '壁纸表面', 'settings.option.region': '区域', 'settings.option.buffered': '缓冲 WAV · 兼容', 'settings.option.openai_sse': 'OpenAI SSE · 流式 PCM',
  'settings.status.registered': '已注册', 'settings.status.unavailable': '不可用', 'settings.status.configured': '已配置', 'settings.status.needs_setup': '需要设置', 'settings.status.available': '可用', 'settings.status.disabled': '已禁用', 'settings.status.not_installed': '未安装', 'settings.status.remote': '远程', 'settings.status.enabled': '已启用', 'settings.status.no_access': '无访问权限', 'settings.status.none': '无', 'settings.status.not_bound': '未绑定', 'settings.status.no_active_binding': '没有活动的提供方绑定', 'settings.status.work_providers_only': '仅限工作提供方', 'settings.kind.mcp': 'MCP', 'settings.kind.skill': '技能', 'settings.capability.consumers': '使用方：', 'settings.capability.scope': '范围：', 'settings.capability.projection': '投影：', 'settings.capability.source': '来源：', 'settings.capability.no_binding': '没有活动的提供方绑定', 'settings.capability.none': '无',
  'settings.status.active': '活动',
  'mcp.boundary.title': '仅限提供方的边界', 'mcp.boundary.body': 'MCP 连接只对兼容的工作提供方可用，主聊天无法访问 MCP 工具。', 'mcp.enabled': '已启用', 'mcp.disabled': '已禁用', 'mcp.providers': '提供方：', 'mcp.not_bound': '未绑定', 'mcp.main_chat': '主聊天：', 'mcp.no_access': '无访问权限', 'mcp.encrypted_environment': '加密环境：', 'mcp.none': '无', 'mcp.test': '测试', 'mcp.testing': '连接中…', 'mcp.test_title': '连接并发现工具', 'mcp.restart_test_title': '测试前请重启后端', 'mcp.edit': '编辑', 'mcp.remove': '移除', 'mcp.confirm_remove': '确认移除', 'mcp.edit_title': '编辑 MCP 连接', 'mcp.add_title': '添加 MCP 服务器', 'mcp.editor_detail': '由主机保存，重启后应用到选定的工作提供方。', 'mcp.close': '关闭 MCP 编辑器', 'mcp.name': '名称', 'mcp.transport': '传输方式', 'mcp.stdio_command': 'stdio 命令', 'mcp.streamable_http': '可流式 HTTP', 'mcp.command': '命令', 'mcp.arguments': '参数', 'mcp.working_directory': '工作目录', 'mcp.server_url': '服务器 URL', 'mcp.bearer_env': 'Bearer 令牌环境变量', 'mcp.encrypted_values': '加密环境值', 'mcp.keep_environment': '留空以保留已存储值；使用 KEY= 删除一项', 'mcp.environment_optional': '可选 · 每行一个 KEY=value', 'mcp.stored': '已存储：', 'mcp.compatible_providers': '兼容的工作提供方', 'mcp.no_compatible_provider': '当前没有已安装的工作提供方接受 MCP 连接。', 'mcp.enable_selected': '为选定提供方启用', 'mcp.no_main_chat_grant': '保存连接不会授予主聊天访问权限。', 'mcp.cancel': '取消', 'mcp.save': '保存连接', 'mcp.add': '+ 添加 MCP 服务器', 'mcp.locked': 'MCP 注册表已被父进程环境锁定。', 'mcp.empty': '未配置 MCP 连接。', 'mcp.connected_tools': '已连接 · 发现 {count} 个工具', 'mcp.connection_failed': '连接失败', 'mcp.save_error': '无法保存 MCP 连接', 'mcp.remove_error': '无法移除 MCP 连接', 'mcp.optional': '可选', 'mcp.bearer_optional': '可选 · 例如 MCP_TOKEN',
  'chat.error.decode_image': '无法解码图片', 'chat.error.read_image': '无法读取图片', 'chat.error.choose_image': '请选择图片文件。', 'chat.error.canvas': '画布不可用。', 'chat.error.send_failed': '发送失败：后端不可达', 'chat.error.attach_image': '无法附加图片', 'chat.error.create_session': '无法创建会话', 'chat.error.create_project_chat': '无法创建项目聊天', 'chat.error.select_project_directory': '无法选择项目目录', 'chat.error.create_project': '无法创建项目', 'chat.error.load_project_apps': '无法加载项目应用', 'chat.error.load_draft_apps': '无法加载最近的 Draft 应用', 'chat.error.open_artifact_chat': '无法打开 Artifact 对话', 'chat.error.prepare_auip': '无法准备 AUIP 应用', 'chat.error.launch_descriptor': '主机未返回完整的 AUIP 启动描述。', 'chat.error.host_refused': '桌面主机拒绝了 AUIP 应用。', 'chat.error.promote_draft_app': '无法提升 Draft 应用', 'chat.error.move_chat': '无法移动聊天', 'chat.error.promote_draft': '无法提升 Draft', 'chat.error.delete_session': '无法删除会话', 'chat.error.rename_session': '无法重命名会话',
  'chat.rename_prompt': '重命名会话', 'chat.start': '输入消息以开始。', 'chat.dismiss_context': '关闭 Artifact 上下文标签', 'chat.remove_image': '移除图片', 'chat.ask_artifact': '询问 Amadeus 关于 {title} 的信息…', 'chat.select_visual_provider': '请选择 OpenAI / Anthropic / Gemini 系协议提供方以使用视觉输入', 'chat.vision_watching': '全局视觉监看已开启。按住以关闭，右键选择窗口。', 'chat.vision_pending': '下一条消息将发送 {name}。点击选择其他图片；按住开启监看；右键选择窗口。', 'chat.vision_choose': '为下一条消息选择图片。按住开启监看；右键选择窗口。', 'chat.refresh': '刷新', 'chat.pixi_render': 'PixiJS 渲染', 'chat.switch_vts': '切换到 VTS 渲染', 'chat.current_render': '当前：{mode}。点击切换。', 'chat.expression_presets': '打开表情预设', 'chat.transparent_overlay': '打开透明覆盖层', 'session.delete': '删除聊天', 'session.no_chats': '还没有聊天', 'session.drafts': 'Drafts', 'activity.working': '工作中', 'activity.completed': '已完成', 'activity.failed': '失败', 'activity.cancelled': '已取消', 'activity.waiting': '等待中', 'activity.preparing': '正在准备提供方运行……', 'activity.waiting_observable': '正在等待可观察的提供方活动。', 'activity.summary': '已完成 {completed} 个 · 仅显示可观察活动', 'backend.title': '后端', 'backend.subtitle': '实时运行状态和服务器诊断。', 'backend.connected': '已连接', 'backend.offline': '离线', 'backend.server_log': '服务器日志', 'backend.lines': '行', 'backend.refresh': '刷新', 'backend.no_log': '暂无日志输出……', 'backend.controls': '运行控制和连接详情', 'backend.start_render': '启动渲染', 'backend.stop_render': '停止渲染', 'backend.start_wallpaper': '启动壁纸', 'backend.stop_wallpaper': '停止壁纸', 'backend.render': '渲染', 'backend.wallpaper': '壁纸',
  'artifact.aria': '{name} Artifact', 'artifact.back': '返回聊天', 'artifact.recent_draft': '最近的 DRAFT ARTIFACTS', 'artifact.project': 'PROJECT ARTIFACTS', 'artifact.loading': '加载中', 'artifact.refresh': '刷新应用', 'artifact.new_chat': '新建聊天', 'artifact.title': 'Artifacts', 'artifact.draft_description': '最近五个已验证的 Draft artifact。可以打开、继续原始对话，或将 Draft 提升为项目。', 'artifact.project_description': '此项目保留的已验证 AUIP artifact。可以打开当前修订，或进入对应 WorkItem 对话继续与 Amadeus 交流。', 'artifact.older_drafts': '更早的 Draft 不在此次限定视图中。', 'artifact.more_work': '此项目包含的 WorkItem 超出限定视图可显示的范围。', 'artifact.none': '还没有已验证的 AUIP artifact', 'artifact.none_draft': '最近的 Draft 中没有当前已验证的 AUIP artifact。', 'artifact.none_project': 'Draft 输出会保留在其 WorkItem 中，直到你将 Draft 提升。提升后的 artifact 会显示在这里，不会复制文件。', 'artifact.version_unknown': '版本未知', 'artifact.revision': '修订 {count}', 'artifact.verified_app': '已验证的交互式应用', 'artifact.registered': '已注册', 'artifact.open': '打开', 'artifact.opening': '打开中', 'artifact.interact': '与 Amadeus 交互', 'artifact.open_chat': '正在打开聊天', 'artifact.promoting': '提升中', 'artifact.promote': '提升为项目',
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
  'scene.work_needs_permission': '需要你的授权', 'chat.error.prefix': '错误：{error}', 'chat.submode_graph': 'SpriteForge 图形', 'chat.submode_sprite': 'Sprite 帧', 'chat.submode_hybrid': 'Live2D 待机 + 帧',
}

const JA: Messages = {
  ...EN,
  ...MAIN_LOCALE_MESSAGES['ja-JP'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '設定', 'settings.restart': '適用するにはバックエンドを再起動', 'settings.restarting': '再起動中…',
  'settings.loading_error': '設定を読み込めません', 'settings.save_error': '{key} を保存できません', 'settings.update_error': '{key} を更新できません', 'settings.saving': '{key} を保存中…', 'settings.asset.character_content': '{frames} 個の KTX2 フレーム · {path}',
  'settings.section.general': '概要', 'settings.section.models': 'モデル', 'settings.section.asr': '音声認識', 'settings.section.tts': '音声合成', 'settings.section.providers': 'プロバイダー', 'settings.section.mcp': 'MCP', 'settings.section.skills': 'Skills', 'settings.aria_sections': '設定セクション',
  'settings.section.general_detail': '現在の状態、外観、ビジョン、表示設定を管理します。', 'settings.section.models_detail': '会話モデルを選び、使用する接続だけを設定します。', 'settings.section.asr_detail': '会話認識、Wake、音響処理を管理します。', 'settings.section.tts_detail': '合成バックエンド、出力言語、実行モードを管理します。', 'settings.section.providers_detail': 'Work 委任を管理します。', 'settings.section.mcp_detail': 'MCP 接続と共有 MCP サーバーを管理します。', 'settings.section.skills_detail': '互換性のある Provider 間で共有されるスキルを表示します。',
  'settings.security.available': '秘密情報は OS により保護されています', 'settings.security.unavailable': 'OS の秘密情報暗号化を利用できません', 'settings.restart_pending': '保存済みの変更はバックエンドの再起動で反映されます', 'settings.restart_pending_detail': '自動で再起動します。ここから再起動できない場合は右のボタンを使用してください。',
  'settings.overview.title': 'ランタイム概要', 'settings.overview.model': 'メインモデル', 'settings.overview.listening': '音声認識', 'settings.overview.speaking': '音声合成',
  'settings.group.optional_assets': 'オプションのランタイムアセット', 'settings.group.chat_appearance': 'チャットの外観', 'settings.group.avatar_compatibility': 'アバター互換性', 'settings.group.vision': 'マルチモーダルとビジョン', 'settings.group.chat_voice': '表示と言語', 'settings.group.main_model': 'メインチャットモデル', 'settings.group.model_connections': 'モデル接続', 'settings.group.active_connections': '現在のモデル接続', 'settings.group.voice_output': '合成と出力', 'settings.group.runtime_presentation': 'ランタイム表示', 'settings.group.voice_backends': '音声バックエンド', 'settings.group.work_providers': 'Work Provider 接続', 'settings.group.mcp': 'MCP 接続', 'settings.group.capabilities': '共有 Provider 機能',
  'settings.group.asr_current': '現在の設定', 'settings.group.asr_configuration': '認識設定', 'settings.group.asr_capture': 'マイクと端点検出', 'settings.group.asr_remaining': 'その他の設定', 'settings.label.asr_mode': '認識バックエンド', 'settings.asrBackend.qwen3_asr': 'Qwen3-ASR（ローカル）', 'settings.asrBackend.sense_voice': 'SenseVoice（ローカル）', 'settings.asrBackend.openai_compatible': 'OpenAI 互換文字起こし（リモート）', 'settings.asrBackend.mimo': 'MiMo ASR モデル（Xiaomi・リモート）',
  'settings.detail.chat_appearance': 'ローカル表示のみ。アバター画像はモデルへ送信されません。', 'settings.detail.avatar_compatibility': 'オプションの出力パスは明示的に有効化した場合のみ使用されます。', 'settings.detail.main_model': '現在のバックエンドプロセスに適用されます。下の接続編集はデスクトップ既定値で、再起動が必要です。', 'settings.detail.model_connections': '秘密情報は OS により暗号化され、renderer へ返されません。', 'settings.detail.runtime_presentation': '即時に適用され、音声合成・認識プロバイダーは選択しません。', 'settings.detail.voice_backends': '起動設定。秘密情報は暗号化され、このページへ返されません。', 'settings.detail.work_providers': '登録済みはアダプターが起動境界を通過した状態です。リモート可用性は Provider 接続時に確認されます。', 'settings.detail.mcp': 'ホスト管理の接続は互換性を明示した Work Provider にのみ投影されます。', 'settings.detail.capabilities': 'Host が一度だけインストールし、対応を明示した Provider にのみ投影します。',
  'settings.note.no_user_settings': 'ユーザー管理の接続設定はありません。', 'settings.note.no_active_connection': '選択中のアクティブな接続はありません。', 'settings.no_skills': 'このバックエンドプロセスで Work Provider と共有されるスキルはありません。', 'settings.advanced_roles': '高度なモデルロール', 'settings.other_connections': 'その他のモデル接続', 'settings.other_voice_backends': 'その他の音声合成バックエンド',
  'settings.avatar.user': 'ユーザーアバター', 'settings.avatar.user_detail': 'あなたのメッセージの横に表示', 'settings.avatar.assistant': '紅莉栖アバター', 'settings.avatar.assistant_detail': 'Amadeus の返信の横に表示', 'settings.avatar.opening': '開いています…', 'settings.avatar.replace': '置換', 'settings.avatar.choose': '画像を選択', 'settings.avatar.restore': '既定の {name} に戻す', 'settings.avatar.note': 'アプリのローカルアセットに中央揃えの PNG コピーを保存します。元ファイルは変更しません。', 'settings.avatar.load_error': 'チャットアバターを読み込めません', 'settings.avatar.save_error': 'アバターを保存できません', 'settings.avatar.restore_error': '既定のアバターに戻せません',
  'settings.saving_label': '保存中…', 'settings.field.locked': 'ロック済み', 'settings.field.restart_required': '再起動が必要', 'settings.source.environment': 'プロセス環境', 'settings.source.user': 'デスクトップ設定', 'settings.source.default': '組み込み既定値', 'settings.placeholder.secret_replace': '設定済み — 入力して置換', 'settings.placeholder.secret_empty': '未設定', 'settings.action.save': '保存', 'settings.action.clear': 'クリア', 'settings.action.on': 'オン', 'settings.action.off': 'オフ',
  'settings.asset.installed': 'インストール済み', 'settings.asset.incomplete': '不完全', 'settings.asset.invalid': '無効なパッケージ', 'settings.asset.not_installed': '未インストール', 'settings.asset.visual_content': '環境レイヤー、字幕、シナリオメディア、壁紙音声アセットが利用できます。', 'settings.asset.visual_optional': 'オプションです。内蔵壁紙、Chat、Work、ヘッドレスモードはなくても利用できます。', 'settings.asset.character_optional': 'オプションです。このパッケージがなくても Chat、Work、ヘッドレスモードは利用できます。', 'settings.label.visual_pack': 'ビジュアルランタイムパック', 'settings.label.character_pack': '紅莉栖キャラクターパック',
  'settings.asset.visual_attention': 'オプションのビジュアルパックに要確認事項があります：{detail}', 'settings.asset.character_attention': 'オプションパッケージが不完全です：{detail}', 'settings.asset.clips': 'クリップ', 'settings.validation_failed': '検証に失敗しました', 'settings.restart_error': 'バックエンドの再起動に失敗しました', 'settings.restart_unowned': 'このバックエンドは本アプリが起動したものではないため、ここから再起動できません。起動した場所で再起動してください。', 'settings.provider_needs_key': '{provider} の API キーが未設定です。下で入力すると反映されます。',
  'settings.label.vision_context': 'ビジョンコンテキスト', 'settings.label.vision_context_detail': '範囲を指定したスクリーンショットをビジュアルチャットへ添付', 'settings.label.vision_mode': 'ビジョンモード', 'settings.label.vision_mode_detail': '要求時に取得。監視中は各チャットターンに新しいフレームを添付', 'settings.label.vision_scope': 'ビジョン範囲', 'settings.label.vision_scope_detail': 'ビジュアルターンで Amadeus が取得できる範囲を選択', 'settings.label.vision_provider': 'ビジョンプロバイダー', 'settings.label.vision_provider_detail': '直接画像入力はまず OpenAI と Gemini に対応', 'settings.label.vision_size': 'ビジョン画像サイズ', 'settings.label.vision_size_detail': 'モデルへ送信する長辺の最大値', 'settings.label.vision_quality': 'ビジョン JPEG 品質', 'settings.label.vision_quality_detail': '品質を上げるとリクエストサイズが増加', 'settings.label.interface_language': 'インターフェース言語', 'settings.label.interface_language_detail': 'プロセスカードと Provider 概要にも適用', 'settings.label.chat_translation': 'チャット翻訳字幕', 'settings.label.chat_translation_detail': '完了した日本語アシスタントメッセージの下に簡体字中国語を表示。表示専用で履歴には追加しません。', 'settings.label.wallpaper_caption': '壁紙キャプションモード', 'settings.label.wallpaper_caption_detail': '翻訳、原文、二言語、または非表示を選択', 'settings.label.current_model': '現在のモデルプロファイル', 'settings.label.current_model_detail': 'メイン会話ロールが使用するモデル', 'settings.label.local_backend': '純ローカルバックエンド種別', 'settings.label.local_backend_detail': 'llama.cpp はオプションの純ローカルプロファイル内の既定値です。', 'settings.label.tts_mode': 'ローカル TTS 推論モード', 'settings.label.tts_mode_detail': 'Amadeus GPT-SoVITS v3 rewrite 用。TTS がアイドル中に切り替えてください。', 'settings.label.tts_language': 'TTS 出力言語', 'settings.label.tts_language_detail': '文分割、キャッシュキー、組み込み参照選択を更新',
  'settings.option.english': 'English', 'settings.option.chinese': '简体中文', 'settings.option.japanese': '日本語', 'settings.option.cuda_graph': 'CUDA Graph ×1', 'settings.option.parallel': '並列 ×2', 'settings.option.auto': '自動', 'settings.option.on_demand': 'オンデマンド', 'settings.option.watching': '監視', 'settings.option.self_aware': '自己認識', 'settings.option.wallpaper_surface': '壁紙サーフェス', 'settings.option.region': '範囲', 'settings.option.custom': 'カスタム', 'settings.option.buffered': 'バッファー WAV · 互換', 'settings.option.openai_sse': 'OpenAI SSE · ストリーミング PCM',
  'settings.status.registered': '登録済み', 'settings.status.unavailable': '利用不可', 'settings.status.configured': '設定済み', 'settings.status.needs_setup': '設定が必要', 'settings.status.available': '利用可能', 'settings.status.disabled': '無効', 'settings.status.not_installed': '未インストール', 'settings.status.remote': 'リモート', 'settings.status.enabled': '有効', 'settings.status.no_access': 'アクセスなし', 'settings.status.none': 'なし', 'settings.status.not_bound': '未バインド', 'settings.status.no_active_binding': '有効な Provider バインドなし', 'settings.status.work_providers_only': 'Work Provider のみ', 'settings.kind.mcp': 'MCP', 'settings.kind.skill': 'Skill', 'settings.capability.consumers': '利用者：', 'settings.capability.scope': '範囲：', 'settings.capability.projection': '投影：', 'settings.capability.source': 'ソース：', 'settings.capability.no_binding': '有効な Provider バインドなし', 'settings.capability.none': 'なし',
  'settings.status.active': '有効',
  'mcp.boundary.title': 'Provider 専用境界', 'mcp.boundary.body': 'MCP 接続は互換性のある Work Provider だけが利用でき、Main Chat は MCP ツールへアクセスできません。', 'mcp.enabled': '有効', 'mcp.disabled': '無効', 'mcp.providers': 'Provider：', 'mcp.not_bound': '未バインド', 'mcp.main_chat': 'Main Chat：', 'mcp.no_access': 'アクセスなし', 'mcp.encrypted_environment': '暗号化環境：', 'mcp.none': 'なし', 'mcp.test': 'テスト', 'mcp.testing': '接続中…', 'mcp.test_title': '接続してツールを検出', 'mcp.restart_test_title': 'テスト前にバックエンドを再起動', 'mcp.edit': '編集', 'mcp.remove': '削除', 'mcp.confirm_remove': '削除を確認', 'mcp.edit_title': 'MCP 接続を編集', 'mcp.add_title': 'MCP サーバーを追加', 'mcp.editor_detail': 'Host が保存し、再起動後に選択した Work Provider へ適用します。', 'mcp.close': 'MCP エディターを閉じる', 'mcp.name': '名前', 'mcp.transport': 'トランスポート', 'mcp.stdio_command': 'stdio コマンド', 'mcp.streamable_http': 'Streamable HTTP', 'mcp.command': 'コマンド', 'mcp.arguments': '引数', 'mcp.working_directory': '作業ディレクトリ', 'mcp.server_url': 'サーバー URL', 'mcp.bearer_env': 'Bearer トークン環境変数', 'mcp.encrypted_values': '暗号化環境値', 'mcp.keep_environment': '空欄で保存済みの値を維持。削除には KEY= を使用', 'mcp.environment_optional': 'オプション · 1 行に 1 つの KEY=value', 'mcp.stored': '保存済み：', 'mcp.compatible_providers': '互換性のある Work Provider', 'mcp.no_compatible_provider': '現在 MCP 接続を受け付けるインストール済み Work Provider はありません。', 'mcp.enable_selected': '選択した Provider で有効化', 'mcp.no_main_chat_grant': '接続を保存しても Main Chat へのアクセス権は付与されません。', 'mcp.cancel': 'キャンセル', 'mcp.save': '接続を保存', 'mcp.add': '+ MCP サーバーを追加', 'mcp.locked': 'MCP レジストリは親プロセス環境によってロックされています。', 'mcp.empty': 'MCP 接続は設定されていません。', 'mcp.connected_tools': '接続済み · {count} 個のツールを検出', 'mcp.connection_failed': '接続に失敗しました', 'mcp.save_error': 'MCP 接続を保存できません', 'mcp.remove_error': 'MCP 接続を削除できません', 'mcp.optional': 'オプション', 'mcp.bearer_optional': 'オプション · 例: MCP_TOKEN',
  'chat.error.decode_image': '画像をデコードできません', 'chat.error.read_image': '画像を読み込めません', 'chat.error.choose_image': '画像ファイルを選択してください。', 'chat.error.canvas': 'キャンバスを利用できません。', 'chat.error.send_failed': '送信失敗：バックエンドに接続できません', 'chat.error.attach_image': '画像を添付できません', 'chat.error.create_session': 'セッションを作成できません', 'chat.error.create_project_chat': 'Project チャットを作成できません', 'chat.error.select_project_directory': 'Project ディレクトリを選択できません', 'chat.error.create_project': 'Project を作成できません', 'chat.error.load_project_apps': 'Project アプリを読み込めません', 'chat.error.load_draft_apps': '最近の Draft アプリを読み込めません', 'chat.error.open_artifact_chat': 'Artifact 会話を開けません', 'chat.error.prepare_auip': 'AUIP アプリを準備できません', 'chat.error.launch_descriptor': 'Host が完全な AUIP 起動記述子を返しませんでした。', 'chat.error.host_refused': 'デスクトップ Host が AUIP アプリを拒否しました。', 'chat.error.promote_draft_app': 'Draft アプリを Project に昇格できません', 'chat.error.move_chat': 'チャットを移動できません', 'chat.error.promote_draft': 'Draft を Project に昇格できません', 'chat.error.delete_session': 'セッションを削除できません', 'chat.error.rename_session': 'セッション名を変更できません',
  'chat.rename_prompt': 'セッション名を変更', 'chat.start': 'メッセージを入力して開始', 'chat.dismiss_context': 'Artifact コンテキストラベルを閉じる', 'chat.remove_image': '画像を削除', 'chat.ask_artifact': 'Amadeus に {title} について質問…', 'chat.select_visual_provider': 'ビジュアル入力には OpenAI / Anthropic / Gemini 系プロトコルを選択', 'chat.vision_watching': 'グローバルビジョン監視中。長押しでオフ、右クリックでウィンドウを選択', 'chat.vision_pending': '次のメッセージと一緒に {name} を送信します。クリックで別画像、長押しで監視、右クリックでウィンドウを選択', 'chat.vision_choose': '次のメッセージ用の画像を選択。長押しで監視、右クリックでウィンドウを選択', 'chat.refresh': '更新', 'chat.pixi_render': 'PixiJS レンダー', 'chat.switch_vts': 'VTS レンダーへ切り替え', 'chat.current_render': '現在：{mode}。クリックして切り替え', 'chat.expression_presets': '表情プリセットを開く', 'chat.transparent_overlay': '透明オーバーレイを開く', 'session.delete': 'チャットを削除', 'session.no_chats': 'チャットはまだありません', 'session.drafts': 'Drafts', 'activity.working': '実行中', 'activity.completed': '完了', 'activity.failed': '失敗', 'activity.cancelled': 'キャンセル済み', 'activity.waiting': '待機中', 'activity.preparing': 'Provider の実行を準備中…', 'activity.waiting_observable': '観測可能な Provider アクティビティを待機中', 'activity.summary': '{completed} 件完了 · 観測可能なアクティビティのみ', 'backend.title': 'バックエンド', 'backend.subtitle': 'ランタイムのライブ状態とサーバー診断', 'backend.connected': '接続済み', 'backend.offline': 'オフライン', 'backend.server_log': 'サーバーログ', 'backend.lines': '行', 'backend.refresh': '更新', 'backend.no_log': 'ログ出力はまだありません…', 'backend.controls': 'ランタイム制御と接続詳細', 'backend.start_render': 'レンダーを開始', 'backend.stop_render': 'レンダーを停止', 'backend.start_wallpaper': '壁紙を開始', 'backend.stop_wallpaper': '壁紙を停止', 'backend.render': 'レンダー', 'backend.wallpaper': '壁紙',
  'artifact.aria': '{name} Artifact', 'artifact.back': 'チャットに戻る', 'artifact.recent_draft': '最近の DRAFT ARTIFACTS', 'artifact.project': 'PROJECT ARTIFACTS', 'artifact.loading': '読み込み中', 'artifact.refresh': 'アプリを更新', 'artifact.new_chat': '新しいチャット', 'artifact.title': 'Artifacts', 'artifact.draft_description': '最近検証された 5 件の Draft artifact。開いて元の会話を続けるか、Draft を Project に昇格できます。', 'artifact.project_description': 'この Project に保持された検証済み AUIP artifact。現在のリビジョンを開くか、WorkItem 会話に入り Amadeus と続けられます。', 'artifact.older_drafts': '古い Draft はこの限定表示の対象外です。', 'artifact.more_work': 'この Project には限定表示を超える WorkItem があります。', 'artifact.none': '検証済み AUIP artifact はまだありません', 'artifact.none_draft': '最近の Draft に現在検証済みの AUIP artifact はありません。', 'artifact.none_project': 'Draft 出力は昇格するまで WorkItem に保持されます。昇格した artifact はファイルをコピーせずここに表示されます。', 'artifact.version_unknown': 'バージョン不明', 'artifact.revision': 'リビジョン {count}', 'artifact.verified_app': '検証済みインタラクティブアプリ', 'artifact.registered': '登録済み', 'artifact.open': '開く', 'artifact.opening': '開いています', 'artifact.interact': 'Amadeus と対話', 'artifact.open_chat': 'チャットを開いています', 'artifact.promoting': '昇格中', 'artifact.promote': 'Project に昇格',
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
  'scene.work_needs_permission': '権限が必要です', 'chat.error.prefix': 'エラー：{error}', 'chat.submode_graph': 'SpriteForge グラフ', 'chat.submode_sprite': 'Sprite フレーム', 'chat.submode_hybrid': 'Live2D 待機 + フレーム',
}

export const MESSAGES: Record<Locale, Messages> = { 'en-US': EN, 'zh-CN': ZH, 'ja-JP': JA }
export type MessageKey = keyof typeof EN

type SettingCopy = Record<'group' | 'field' | 'description' | 'groupDescription' | 'status' | 'option', Record<string, string>>

const ZH_SETTINGS: SettingCopy = {
  group: {
    conversation_asr: '麦克风与端点', asr_local: '本地 ASR 模型', asr_remote: 'OpenAI 兼容转写', asr_mimo: '小米 ASR 模型（远程）', wake_asr: '唤醒识别', acoustic_pipeline: '回声消除与打断', voice_reference_profile: '语音参考配置', speech_synthesis: '语音合成', tts_embedded_v3: '内置 GPT-SoVITS v3 模型', tts_remote: '远程语音 API', tts_mimo: 'MiMo 语音 API（小米）', vts_compatibility: 'VTube Studio 兼容', profile: '桌面默认配置', local: '纯本地模型', work_observer: '工作观察器', auip_narration: 'AUIP 叙述', auip_action: 'AUIP 操作决策', browser: '浏览器', openclaw: 'OpenClaw', codex: 'Codex',
  },
  field: {
    ASR_BACKEND: '后端', ASR_LANGUAGE: '识别语言', ASR_CONTEXT: '上下文与术语', QWEN3_ASR_MODEL_PATH: 'Qwen 模型目录', QWEN3_ASR_DEVICE: 'Qwen 设备', QWEN3_ASR_REQUIRE_CUDA: '要求 Qwen CUDA', MICROPHONE_DEVICE_INDEX: '麦克风', MICROPHONE_PREFERRED_NAME: '首选麦克风名称', ASR_LISTEN_TIMEOUT_SECONDS: '等待语音', ASR_VAD_SILENCE_MS: '语音结束停顿', ASR_API_BASE_URL: 'API 基础 URL', ASR_API_KEY: 'API 密钥', ASR_API_MODEL: '模型', WAKE_ENABLED: '唤醒服务', WAKE_PHRASES: '唤醒短语', WAKE_AUTO_SEND_TO_CHAT: '将命令发送到聊天', WAKE_ASR_BACKEND: '唤醒后端', WAKE_SENSEVOICE_LANGUAGES: '唤醒语言', SENSEVOICE_LANGUAGE: 'SenseVoice 会话语言', SENSEVOICE_MODEL_PATH: 'SenseVoice 模型路径', AEC_REALTIME_ENABLED: '实时回声消除', AEC_REALTIME_BARGE_IN: '允许麦克风打断', AEC_REALTIME_DELAY_MS: 'AEC 参考延迟', TTS_REF_AUDIO_JA: '日语参考音频', TTS_REF_TEXT_JA: '日语参考转写', TTS_REF_AUDIO_EN: '英语参考音频', TTS_REF_TEXT_EN: '英语参考转写', TTS_BACKEND: '后端', TTS_DEVICE: '推理设备', TTS_GPT_MODEL_PATH: 'GPT 语义检查点（v3）', TTS_SOVITS_MODEL_PATH: 'SoVITS 声学检查点（v3）', TTS_API_BASE_URL: 'API 基础 URL', TTS_API_KEY: 'API 密钥', TTS_API_MODEL: '模型', TTS_API_VOICE: '声音', TTS_API_STREAM_PROTOCOL: '响应模式', MIMO_TTS_BASE_URL: 'API 基础 URL', MIMO_TTS_API_KEY: 'API 密钥', MIMO_TTS_MODEL: '模型', MIMO_TTS_VOICE: '声音', VTS_ENABLED: '启用兼容输出', VTS_WS_URL: 'WebSocket URL', VTS_TOKEN_FILE: '认证令牌文件', LLM_PROVIDER: '默认模型配置', DEEPSEEK_API_KEY: 'API 密钥', DEEPSEEK_BASE_URL: '基础 URL', DEEPSEEK_MODEL_NAME: '模型', OPENAI_API_KEY: 'API 密钥', OPENAI_BASE_URL: '基础 URL', OPENAI_MODEL_NAME: '模型', GEMINI_API_KEY: 'API 密钥', GEMINI_MODEL_NAME: '模型', WORK_OBSERVER_PROVIDER: '提供方覆盖', WORK_OBSERVER_MODEL: '模型覆盖', AUIP_NARRATION_PROVIDER: '提供方覆盖', AUIP_NARRATION_MODEL: '模型覆盖', AUIP_ACTION_PROVIDER: '提供方覆盖', AUIP_ACTION_MODEL: '模型覆盖', AUIP_ACTION_REASONING_EFFORT: '推理力度', AUIP_ACTION_SERVICE_TIER: '服务层级',
    OPENCLAW_BASE_URL: 'Gateway URL', OPENCLAW_GATEWAY_TOKEN: 'Gateway 令牌', OPENCLAW_PROJECT_DIR: 'OpenClaw 项目目录', CODEX_PROVIDER_TRANSPORT: '传输方式', CODEX_APP_SERVER_CODEX_BIN: 'App Server 可执行文件', CODEX_APP_SERVER_MODEL_PROVIDER: '模型提供方', CODEX_APP_SERVER_PROVIDER_BASE_URL: '提供方基础 URL', CODEX_APP_SERVER_MODEL: '模型', CODEX_APP_SERVER_REASONING_EFFORT: '推理力度', CODEX_APP_SERVER_SERVICE_TIER: '服务层级', DIRECT_CODEX_CLI_PATH: 'Direct CLI 可执行文件',
  },
  description: {
    ASR_LANGUAGE: 'auto 或 ISO-639-1 语言代码，例如 en、ja 或 zh。', ASR_CONTEXT: '兼容的完整识别器使用的提示词或领域词汇。', QWEN3_ASR_MODEL_PATH: '留空以使用 assets/models/asr/qwen3-asr-0.6b；如果存在，也会使用旧的 Hugging Face 缓存。', QWEN3_ASR_DEVICE: '仅用于内置 Qwen 识别器；Apple Silicon 需要 PyTorch 2.7 MPS 配置。', QWEN3_ASR_REQUIRE_CUDA: '请求 CUDA 但不可用时，明确失败而不是回退到 CPU。', MICROPHONE_PREFERRED_NAME: '设备索引变化时使用的可选名称匹配。', ASR_LISTEN_TIMEOUT_SECONDS: '开始监听后等待语音开始的秒数。', ASR_VAD_SILENCE_MS: '判定语音轮次完成所需的静音时长；自然停顿被截断时请增大。', WAKE_PHRASES: '由唤醒识别器匹配的逗号分隔短语。', WAKE_AUTO_SEND_TO_CHAT: '唤醒交接后提交识别出的命令。', WAKE_SENSEVOICE_LANGUAGES: '逗号分隔的 SenseVoice 语言轮次。', SENSEVOICE_MODEL_PATH: '未安装在默认缓存中时使用的可选本地模型目录。', AEC_REALTIME_BARGE_IN: '启用后，确认的近端语音可以停止当前播放。', AEC_REALTIME_DELAY_MS: '播放到麦克风的显式参考延迟（毫秒）。', TTS_DEVICE: 'auto/cuda、cuda:N、mps 或 cpu；仅用于内置后端。', TTS_GPT_MODEL_PATH: 'GPT-SoVITS v3 .ckpt 文件路径；相对路径从仓库根目录解析。', TTS_SOVITS_MODEL_PATH: 'GPT-SoVITS v3 .pth 文件路径；相对路径从仓库根目录解析。', TTS_API_STREAM_PROTOCOL: '仅当端点实现 speech.audio.delta 事件时使用 OpenAI SSE。', VTS_TOKEN_FILE: '本地令牌缓存路径；令牌本身不会显示在设置中。',
  }, groupDescription: {
    conversation_asr: '麦克风采集与端点判定在本机完成，对所有识别后端生效——包括远程 API，它只接收已经录好的音频。', asr_mimo: '通过 chat-completions 端点识别，音频以 input_audio 传入；语言自动检测，无需指定。', tts_remote: '缓冲 WAV 兼容更多 OpenAI 接口；OpenAI SSE 将 PCM 流式送入首包播放，必须明确选择。', tts_mimo: 'MiMo-TTS chat-completions 合成。仅 mimo-v2.5-tts 支持流式 PCM16。', vts_compatibility: '可选的下游口型信号与参数转发；SpriteForge 浏览器动画不依赖此兼容路径。', profile: '桌面后端启动时选择的模型配置。', local: '可选纯本地配置中的 llama.cpp 默认后端；LM Studio、Ollama 和 llama-cli 是兼容选项。', work_observer: '汇总提供方进度；留空时继承主模型。', auip_narration: '叙述已验证的应用结果；继承工作观察器或主模型。', auip_action: '默认 B2 AppSession 操作路径使用的决策模型。', browser: '主机管理的浏览器工作提供方；没有连接设置。', openclaw: '仅在主角色委托工作后使用的远程 agent Gateway。', codex: '编码提供方；同一 ID 只能由 App Server 或 Direct 传输之一拥有。',
  }, status: {}, option: {},
}

const JA_SETTINGS: SettingCopy = {
  group: {
    conversation_asr: 'マイクと端点検出', asr_local: '組み込み ASR モデル', asr_remote: 'OpenAI 互換文字起こし', asr_mimo: 'MiMo ASR モデル（Xiaomi・リモート）', wake_asr: 'Wake 認識', acoustic_pipeline: 'エコーキャンセルと割り込み', voice_reference_profile: '音声参照プロファイル', speech_synthesis: '音声合成', tts_embedded_v3: '組み込み GPT-SoVITS v3 モデル', tts_remote: 'リモート音声 API', tts_mimo: 'MiMo 音声 API（Xiaomi）', vts_compatibility: 'VTube Studio 互換', profile: 'デスクトップ既定', local: '純ローカルモデル', work_observer: 'Work observer', auip_narration: 'AUIP ナレーション', auip_action: 'AUIP アクション判断', browser: 'ブラウザー', openclaw: 'OpenClaw', codex: 'Codex',
  },
  field: {
    ASR_BACKEND: 'バックエンド', ASR_LANGUAGE: '認識言語', ASR_CONTEXT: 'コンテキストと用語', QWEN3_ASR_MODEL_PATH: 'Qwen モデルディレクトリ', QWEN3_ASR_DEVICE: 'Qwen デバイス', QWEN3_ASR_REQUIRE_CUDA: 'Qwen CUDA を要求', MICROPHONE_DEVICE_INDEX: 'マイク', MICROPHONE_PREFERRED_NAME: '優先マイク名', ASR_LISTEN_TIMEOUT_SECONDS: '音声待機時間', ASR_VAD_SILENCE_MS: '発話終了の無音', ASR_API_BASE_URL: 'API ベース URL', ASR_API_KEY: 'API キー', ASR_API_MODEL: 'モデル', WAKE_ENABLED: 'Wake サービス', WAKE_PHRASES: 'Wake フレーズ', WAKE_AUTO_SEND_TO_CHAT: 'コマンドを Chat へ送信', WAKE_ASR_BACKEND: 'Wake バックエンド', WAKE_SENSEVOICE_LANGUAGES: 'Wake 言語', SENSEVOICE_LANGUAGE: 'SenseVoice 会話言語', SENSEVOICE_MODEL_PATH: 'SenseVoice モデルパス', AEC_REALTIME_ENABLED: 'リアルタイムエコーキャンセル', AEC_REALTIME_BARGE_IN: 'マイク割り込みを許可', AEC_REALTIME_DELAY_MS: 'AEC 参照遅延', TTS_REF_AUDIO_JA: '日本語参照音声', TTS_REF_TEXT_JA: '日本語参照テキスト', TTS_REF_AUDIO_EN: '英語参照音声', TTS_REF_TEXT_EN: '英語参照テキスト', TTS_BACKEND: 'バックエンド', TTS_DEVICE: '推論デバイス', TTS_GPT_MODEL_PATH: 'GPT セマンティックチェックポイント（v3）', TTS_SOVITS_MODEL_PATH: 'SoVITS 音響チェックポイント（v3）', TTS_API_BASE_URL: 'API ベース URL', TTS_API_KEY: 'API キー', TTS_API_MODEL: 'モデル', TTS_API_VOICE: '音声', TTS_API_STREAM_PROTOCOL: '応答モード', MIMO_TTS_BASE_URL: 'API ベース URL', MIMO_TTS_API_KEY: 'API キー', MIMO_TTS_MODEL: 'モデル', MIMO_TTS_VOICE: '音声', VTS_ENABLED: '互換出力を有効化', VTS_WS_URL: 'WebSocket URL', VTS_TOKEN_FILE: '認証トークンファイル', LLM_PROVIDER: '既定モデルプロファイル', DEEPSEEK_API_KEY: 'API キー', DEEPSEEK_BASE_URL: 'ベース URL', DEEPSEEK_MODEL_NAME: 'モデル', OPENAI_API_KEY: 'API キー', OPENAI_BASE_URL: 'ベース URL', OPENAI_MODEL_NAME: 'モデル', GEMINI_API_KEY: 'API キー', GEMINI_MODEL_NAME: 'モデル', WORK_OBSERVER_PROVIDER: 'Provider 上書き', WORK_OBSERVER_MODEL: 'モデル上書き', AUIP_NARRATION_PROVIDER: 'Provider 上書き', AUIP_NARRATION_MODEL: 'モデル上書き', AUIP_ACTION_PROVIDER: 'Provider 上書き', AUIP_ACTION_MODEL: 'モデル上書き', AUIP_ACTION_REASONING_EFFORT: '推論強度', AUIP_ACTION_SERVICE_TIER: 'サービス階層',
    OPENCLAW_BASE_URL: 'Gateway URL', OPENCLAW_GATEWAY_TOKEN: 'Gateway トークン', OPENCLAW_PROJECT_DIR: 'OpenClaw プロジェクトディレクトリ', CODEX_PROVIDER_TRANSPORT: 'トランスポート', CODEX_APP_SERVER_CODEX_BIN: 'App Server 実行ファイル', CODEX_APP_SERVER_MODEL_PROVIDER: 'モデルプロバイダー', CODEX_APP_SERVER_PROVIDER_BASE_URL: 'Provider ベース URL', CODEX_APP_SERVER_MODEL: 'モデル', CODEX_APP_SERVER_REASONING_EFFORT: '推論強度', CODEX_APP_SERVER_SERVICE_TIER: 'サービス階層', DIRECT_CODEX_CLI_PATH: 'Direct CLI 実行ファイル',
  },
  description: {
    ASR_LANGUAGE: 'auto または en、ja、zh などの ISO-639-1 言語コード。', ASR_CONTEXT: '対応する完全認識器で使うプロンプトまたはドメイン語彙。', QWEN3_ASR_MODEL_PATH: '空欄なら assets/models/asr/qwen3-asr-0.6b、存在すれば旧 Hugging Face キャッシュを使用。', QWEN3_ASR_DEVICE: '組み込み Qwen 認識器のみ。Apple Silicon には PyTorch 2.7 MPS プロファイルが必要。', QWEN3_ASR_REQUIRE_CUDA: 'CUDA が要求され利用できない場合、CPU へフォールバックせず明示的に失敗。', MICROPHONE_PREFERRED_NAME: 'デバイス番号が変わった場合の任意の名前照合。', ASR_LISTEN_TIMEOUT_SECONDS: 'リスニング開始後、発話開始まで待つ秒数。', ASR_VAD_SILENCE_MS: '発話完了と判断する無音時間。自然な間が切れる場合は増やしてください。', WAKE_PHRASES: 'Wake 認識器が照合するカンマ区切りフレーズ。', WAKE_AUTO_SEND_TO_CHAT: 'Wake 引き継ぎ後に認識コマンドを送信。', WAKE_SENSEVOICE_LANGUAGES: 'カンマ区切りの SenseVoice 言語パス。', SENSEVOICE_MODEL_PATH: '既定キャッシュにない場合の任意のローカルモデルディレクトリ。', AEC_REALTIME_BARGE_IN: '有効時、確認済みの近端音声で再生を停止できます。', AEC_REALTIME_DELAY_MS: '再生からマイクへの明示的な参照遅延（ミリ秒）。', TTS_DEVICE: 'auto/cuda、cuda:N、mps、cpu。組み込みバックエンドのみで使用。', TTS_GPT_MODEL_PATH: 'GPT-SoVITS v3 .ckpt パス。相対パスはリポジトリルートから解決。', TTS_SOVITS_MODEL_PATH: 'GPT-SoVITS v3 .pth パス。相対パスはリポジトリルートから解決。', TTS_API_STREAM_PROTOCOL: 'エンドポイントが speech.audio.delta イベントを実装する場合のみ OpenAI SSE を使用。', VTS_TOKEN_FILE: 'ローカルトークンキャッシュのパス。トークン自体は設定に表示しません。',
  }, groupDescription: {
    conversation_asr: 'マイク入力と端点検出は常にこのマシンで実行され、リモート API を含むすべての認識バックエンドに適用されます。', asr_mimo: 'chat-completions エンドポイントで認識し、音声は input_audio で送信します。言語は自動検出されます。', tts_remote: 'Buffered WAV は広い互換性を持ち、OpenAI SSE は PCM ストリーミングを行います。', tts_mimo: 'MiMo-TTS chat-completions 合成。ストリーミング PCM16 は mimo-v2.5-tts のみ対応します。', vts_compatibility: 'オプションの口パク信号とパラメーター転送です。', profile: 'デスクトップ起動時に選択されるモデルプロファイルです。', local: 'オプションの純ローカルプロファイル内の既定バックエンドです。', work_observer: 'Provider の進捗を要約します。空欄ならメインモデルを継承します。', auip_narration: '検証済みアプリ結果をナレーションします。', auip_action: '既定の B2 AppSession 操作経路で使う判断モデルです。', browser: 'Host 管理のブラウザー Work Provider です。', openclaw: 'Main role が作業を委任した後だけ使うリモート agent Gateway です。', codex: 'コーディング Provider。同じ ID は App Server または Direct の一方だけが所有します。',
  }, status: {}, option: {},
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
