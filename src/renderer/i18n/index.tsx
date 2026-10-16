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
  'settings.section.general': 'General', 'settings.section.models': 'Models', 'settings.section.voice': 'Voice', 'settings.section.asr': 'Recognition', 'settings.section.tts': 'Synthesis', 'settings.section.memory': 'Memory',
  'settings.thinking_level': 'Thinking level',
  'settings.reload_error': 'Runtime reload failed',
  'settings.loading_error': 'Could not load settings',
  'settings.save_error': 'Could not save {key}',
  'settings.update_error': 'Could not update {key}',
  'settings.saving': 'Saving {key}…',
  'settings.saving_label': 'Saving…',














  'settings.security.available': 'Secrets protected by the operating system',
  'settings.security.unavailable': 'System secret encryption unavailable',








          














  'settings.note.no_user_settings': 'No user-managed connection settings.',
  'settings.note.no_active_connection': 'No active connection is selected.',

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
  'common.cancel': 'Cancel', 'common.save': 'Save', 'common.edit': 'Edit', 'common.delete': 'Delete', 'common.refresh': 'Refresh',

  'scene.stop': 'Stop reply', 'scene.stop_failed': 'Could not stop the reply: {error}',
  'scene.sessions': 'Conversations', 'scene.session_group_current': 'Conversations',
  'scene.session_untitled': 'Untitled', 'scene.session_rename': 'Rename', 'scene.session_rename_save': 'Save name', 'scene.session_delete': 'Delete conversation',
  'scene.session_reports': '{count} report(s) waiting', 'scene.session_approvals': '{count} action(s) waiting for approval',
  'scene.session_delete_title': 'Delete this conversation?', 'scene.session_delete_body': '"{title}" and its tasks will be deleted permanently.',
  'scene.session_rename_failed': 'Could not rename the conversation: {error}', 'scene.session_delete_failed': 'Could not delete the conversation: {error}',

  'scene.work': 'Work',
  'work.empty': 'Nothing has been delegated yet. Tasks handed to subagents show up here with what they are doing.',
  'work.open': 'In progress ({count})', 'work.finished': 'Finished ({count})', 'work.show_more': 'Show {count} more',
  'work.refresh': 'Refresh', 'work.back': 'Back to the list', 'work.jump': 'Open conversation',
  'work.tool_uses': '{count} tool uses', 'work.tokens': '{count} tokens', 'work.waiting': 'waiting {time}',
  'work.loading': 'Loading…', 'work.load_failed': 'Could not load the list: {error}', 'work.trace_failed': 'Could not load the steps: {error}',
  'work.trace_empty': 'No steps yet.', 'work.brief': 'Brief', 'work.progress': 'Progress', 'work.reason': 'Reason',
  'work.not_live': 'The subagent is running; new steps appear here as they happen.',
  'task.title': 'Tasks', 'task.card': 'Task',
  'task.kind.research': 'Research', 'task.kind.files': 'Files', 'task.kind.task': 'Task', 'task.kind.remote': 'Remote',
  'task.status.queued': 'Queued', 'task.status.running': 'Running', 'task.status.done': 'Done', 'task.status.failed': 'Failed', 'task.status.timeout': 'Timed out', 'task.status.cancelled': 'Cancelled', 'task.status.needs_input': 'Waiting for you',
  'task.round': 'Round {count}',
  'task.progress.now': 'just now', 'task.progress.seconds': '{count}s ago', 'task.progress.minutes': '{count} min ago', 'task.progress.hours': '{count} h ago',
  'task.question.label': 'Question from the subagent', 'task.question.hint': 'Kurisu will ask you about this and pass your answer on.',
  'task.cancel': 'Cancel task', 'task.cancelling': 'Cancelling…', 'task.cancel_failed': 'Could not cancel the task: {error}',
  'task.show_finished': 'Show {count} finished', 'task.hide_finished': 'Hide finished', 'task.expand': 'Show more', 'task.collapse': 'Show less',
  'task.approval.heading': 'Waiting for your approval', 'task.approval.allow': 'Allow once', 'task.approval.deny': 'Deny',
  'task.approval.expires': 'Expires in {time}', 'task.approval.show': 'Show details', 'task.approval.hide': 'Hide details',
  'task.approval.allowed': 'Allowed', 'task.approval.denied': 'Denied', 'task.approval.expired': 'Expired',
  'task.approval.failed': 'Could not send your decision: {error}', 'task.approval.gone': 'This request was already handled or has expired.',
  'task.approval.waiting': '{count} action(s) waiting for your approval', 'task.approval.view': 'View',
  'task.approval.review': 'Review the full content before approving.', 'task.approval.no_detail': 'No details came with this request, so you cannot check what it will do. Deny it unless you know what it is.',
  'task.detail.command': 'Command', 'task.detail.cwd': 'Working directory', 'task.detail.path': 'Path', 'task.detail.preview': 'Details',
  'task.detail.path.write': 'File to write', 'task.detail.path.edit': 'File to modify',
  'task.detail.preview.write': 'Content to write', 'task.detail.preview.edit': 'Changes ("-" removed, "+" added)',
  'task.detail.mcp_tool': 'MCP tool', 'task.detail.preview.mcp': 'Arguments',

  'memory.title': 'Long-term memory', 'memory.unavailable': 'The memory service is not available yet.', 'memory.loading': 'Loading…',
  'memory.enabled': 'Remember across conversations', 'memory.recall': 'Episodic recall',
  'memory.recall.off': 'Off', 'memory.recall.log': 'Log only', 'memory.recall.on': 'On',
  'memory.snapshot': 'Prompt budget', 'memory.snapshot_truncated': 'Some memories do not fit and are not used.',
  'memory.open_folder': 'Open folder', 'memory.clear': 'Clear all',
  'memory.clear_title': 'Clear all long-term memory?', 'memory.clear_body': 'Core memories and pending suggestions move to the trash and are kept for 7 days.',
  'memory.core': 'Core memories', 'memory.core_empty': 'Nothing here yet. Add what Amadeus should always remember.',
  'memory.type.profile': 'Profile', 'memory.type.preference': 'Preferences', 'memory.type.relationship': 'Relationship', 'memory.type.feedback': 'Feedback', 'memory.type.ongoing': 'Ongoing',
  'memory.add': 'Add memory', 'memory.add_placeholder': 'One short, self-contained sentence (up to 120 characters)', 'memory.review_after': 'Review after',
  'memory.badge.not_injected': 'Not used', 'memory.badge.due': 'Needs review', 'memory.review_by': 'Review by {date}',
  'memory.due_hint': 'Past its review date, so it is no longer used. Is it still true?', 'memory.still_true': 'Still true (+30 days)', 'memory.ended': 'Ended',
  'memory.optional': 'Optional: Jev memory judge',
  'memory.pending': 'Awaiting your review', 'memory.pending_empty': 'No suggestions right now.',
  'memory.accept': 'Accept', 'memory.reject': 'Reject',
  'memory.confidence': 'Confidence: {level}', 'memory.confidence.high': 'high', 'memory.confidence.medium': 'medium', 'memory.confidence.low': 'low',
  'memory.quote': 'You said: "{quote}"', 'memory.proposal.replace': 'Replaces:', 'memory.proposal.remove': 'Removes:',
  'memory.archived': 'Archived suggestions ({count})', 'memory.invalid': 'Unreadable files ({count})',
  'memory.source.manual': 'Added by you', 'memory.source.explicit': 'You asked to remember', 'memory.source.extracted': 'Inferred from chat',
  'memory.save_error': 'Memory update failed: {error}',

  'settings.translation.title': 'Japanese translation', 'settings.subagent.title': 'Subagents', 'settings.capability_mode.isolated': 'Isolated (Amadeus only)', 'settings.capability_mode.shared': 'Shared with this computer',
  'settings.delegation_model.same': 'Same as chat model',
  'settings.remote.title': 'Remote machines',
  'settings.remote.name': 'Name', 'settings.remote.ssh': 'SSH command', 'settings.remote.workspace': 'Workdir', 'settings.remote.node': 'Node',
  'settings.remote.add': 'Add machine', 'settings.remote.new': 'New machine', 'settings.remote.edit': 'Edit', 'settings.remote.remove': 'Remove {name}',
  'settings.remote.advanced': 'Advanced (workdir, Node)', 'settings.remote.cancel': 'Cancel', 'settings.remote.save_test': 'Save and test',
  'settings.remote.test': 'Test', 'settings.remote.testing': 'Connecting…',
  'settings.remote.ok': 'Connected: {path} ({os}/{arch}, Node {node})', 'settings.remote.failed': 'Cannot connect: {error}',
  'settings.character.title': 'Character assets',
  'settings.character.choose': 'Install from emote.zip', 'settings.character.installing': 'Installing…',
  'settings.character.installed': 'Installed. The scene uses this pack from now on.', 'settings.character.failed': 'Install failed: {error}',

}

const ZH: Messages = {
  ...EN,
  'settings.thinking_level': '思考强度',
  'settings.reload_error': '运行时重载失败',
  ...MAIN_LOCALE_MESSAGES['zh-CN'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '设置',
  'settings.section.general': '通用', 'settings.section.models': '模型配置', 'settings.section.voice': '语音配置', 'settings.section.asr': '语音识别', 'settings.section.tts': '语音合成', 'settings.section.memory': '长期记忆',
  'settings.loading_error': '无法加载设置', 'settings.save_error': '无法保存 {key}', 'settings.update_error': '无法更新 {key}', 'settings.saving': '正在保存 {key}…',
  'settings.saving_label': '正在保存…',

  'settings.security.available': '密钥受操作系统保护', 'settings.security.unavailable': '系统密钥加密不可用',





  'settings.note.no_user_settings': '没有用户管理的连接设置。', 'settings.note.no_active_connection': '当前没有选中的活动连接。', 'settings.advanced': '高级（实时校准）',

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
  'common.cancel': '取消', 'common.save': '保存', 'common.edit': '编辑', 'common.delete': '删除', 'common.refresh': '刷新',

  'scene.stop': '停止回复', 'scene.stop_failed': '无法停止回复：{error}',
  'scene.sessions': '会话列表', 'scene.session_group_current': '会话',
  'scene.session_untitled': '未命名', 'scene.session_rename': '重命名', 'scene.session_rename_save': '保存名称', 'scene.session_delete': '删除会话',
  'scene.session_reports': '{count} 条汇报待处理', 'scene.session_approvals': '{count} 个操作等待确认',
  'scene.session_delete_title': '删除这个会话？', 'scene.session_delete_body': '“{title}”及其中的任务将被永久删除。',
  'scene.session_rename_failed': '无法重命名会话：{error}', 'scene.session_delete_failed': '无法删除会话：{error}',

  'scene.work': '工作面板',
  'work.empty': '还没有委派过任务。交给子代理的任务会出现在这里，并显示它们正在做什么。',
  'work.open': '进行中（{count}）', 'work.finished': '已结束（{count}）', 'work.show_more': '再显示 {count} 个',
  'work.refresh': '刷新', 'work.back': '返回列表', 'work.jump': '打开所在会话',
  'work.tool_uses': '{count} 次工具调用', 'work.tokens': '{count} tokens', 'work.waiting': '已等待 {time}',
  'work.loading': '正在加载…', 'work.load_failed': '列表加载失败：{error}', 'work.trace_failed': '执行过程加载失败：{error}',
  'work.trace_empty': '还没有任何步骤。', 'work.brief': '任务说明', 'work.progress': '进度', 'work.reason': '原因',
  'work.not_live': '子代理正在运行，新的步骤会实时出现在这里。',
  'task.title': '任务', 'task.card': '任务',
  'task.kind.research': '调研', 'task.kind.files': '文件', 'task.kind.task': '任务', 'task.kind.remote': '远程',
  'task.status.queued': '排队中', 'task.status.running': '进行中', 'task.status.done': '已完成', 'task.status.failed': '失败', 'task.status.timeout': '超时', 'task.status.cancelled': '已取消', 'task.status.needs_input': '等你回答',
  'task.round': '第 {count} 轮',
  'task.progress.now': '刚刚', 'task.progress.seconds': '{count} 秒前', 'task.progress.minutes': '{count} 分钟前', 'task.progress.hours': '{count} 小时前',
  'task.question.label': '子代理的问题', 'task.question.hint': '红莉栖会问你这件事，你的回答会交给它继续。',
  'task.cancel': '取消任务', 'task.cancelling': '正在取消…', 'task.cancel_failed': '无法取消任务：{error}',
  'task.show_finished': '显示 {count} 个已结束', 'task.hide_finished': '收起已结束', 'task.expand': '展开全文', 'task.collapse': '收起',
  'task.approval.heading': '等待你确认', 'task.approval.allow': '允许一次', 'task.approval.deny': '拒绝',
  'task.approval.expires': '{time}后过期', 'task.approval.show': '展开详情', 'task.approval.hide': '收起详情',
  'task.approval.allowed': '已允许', 'task.approval.denied': '已拒绝', 'task.approval.expired': '已过期',
  'task.approval.failed': '无法提交你的决定：{error}', 'task.approval.gone': '这个请求已处理或已过期。',
  'task.approval.waiting': '{count} 个操作等待你确认', 'task.approval.view': '查看',
  'task.approval.review': '批准前请查看完整内容。', 'task.approval.no_detail': '这个请求没有附带详情，无法核对它要做什么。不确定时请拒绝。',
  'task.detail.command': '命令', 'task.detail.cwd': '工作目录', 'task.detail.path': '路径', 'task.detail.preview': '详情',
  'task.detail.path.write': '写入的文件', 'task.detail.path.edit': '修改的文件',
  'task.detail.preview.write': '将写入的内容', 'task.detail.preview.edit': '修改内容（“-”删除，“+”新增）',
  'task.detail.mcp_tool': 'MCP 工具', 'task.detail.preview.mcp': '调用参数',

  'memory.title': '长期记忆', 'memory.unavailable': '记忆服务暂不可用。', 'memory.loading': '正在加载…',
  'memory.enabled': '跨会话记住', 'memory.recall': '情景回忆',
  'memory.recall.off': '关闭', 'memory.recall.log': '仅记录', 'memory.recall.on': '开启',
  'memory.snapshot': '提示词占用', 'memory.snapshot_truncated': '部分记忆放不下，未被使用。',
  'memory.open_folder': '打开文件夹', 'memory.clear': '清空',
  'memory.clear_title': '清空全部长期记忆？', 'memory.clear_body': '核心记忆和待确认提议会移入回收站，保留 7 天。',
  'memory.core': '核心记忆', 'memory.core_empty': '还没有内容。可以添加希望 Amadeus 一直记住的事。',
  'memory.type.profile': '个人信息', 'memory.type.preference': '偏好', 'memory.type.relationship': '关系', 'memory.type.feedback': '反馈', 'memory.type.ongoing': '进行中的事',
  'memory.add': '添加记忆', 'memory.add_placeholder': '一句简短、自包含的话（不超过 120 字）', 'memory.review_after': '复核日期',
  'memory.badge.not_injected': '未使用', 'memory.badge.due': '待复核', 'memory.review_by': '复核于 {date}',
  'memory.due_hint': '已过复核日期，不再被使用。这件事还成立吗？', 'memory.still_true': '仍然成立（顺延 30 天）', 'memory.ended': '已结束',
  'memory.optional': '可选：Jev 记忆判定', 'memory.pending': '等待确认', 'memory.pending_empty': '目前没有待确认的提议。',
  'memory.accept': '接受', 'memory.reject': '拒绝',
  'memory.confidence': '可信度：{level}', 'memory.confidence.high': '高', 'memory.confidence.medium': '中', 'memory.confidence.low': '低',
  'memory.quote': '你说过：“{quote}”', 'memory.proposal.replace': '将替换：', 'memory.proposal.remove': '将移除：',
  'memory.archived': '已归档的提议（{count}）', 'memory.invalid': '无法解析的文件（{count}）',
  'memory.source.manual': '你添加的', 'memory.source.explicit': '你要求记住的', 'memory.source.extracted': '从对话中推断的',
  'memory.save_error': '记忆更新失败：{error}',

  'settings.translation.title': '日语翻译', 'settings.subagent.title': '子代理', 'settings.capability_mode.isolated': '隔离（仅 Amadeus）', 'settings.capability_mode.shared': '与本机共享',
  'settings.delegation_model.same': '与对话模型相同',
  'settings.remote.title': '远程机器',
  'settings.remote.name': '名称', 'settings.remote.ssh': 'SSH 命令', 'settings.remote.workspace': '工作目录', 'settings.remote.node': 'Node',
  'settings.remote.add': '添加机器', 'settings.remote.new': '新机器', 'settings.remote.edit': '编辑', 'settings.remote.remove': '移除 {name}',
  'settings.remote.advanced': '高级（工作目录、Node）', 'settings.remote.cancel': '取消', 'settings.remote.save_test': '保存并测试',
  'settings.remote.test': '测试', 'settings.remote.testing': '连接中…',
  'settings.remote.ok': '已连接：{path}（{os}/{arch}，Node {node}）', 'settings.remote.failed': '无法连接：{error}',
  'settings.character.title': '角色资源',
  'settings.character.choose': '从 emote.zip 安装', 'settings.character.installing': '正在安装…',
  'settings.character.installed': '安装完成，场景从现在起使用这个包。', 'settings.character.failed': '安装失败：{error}',

}

const JA: Messages = {
  ...EN,
  'settings.thinking_level': '思考レベル',
  'settings.reload_error': '再読み込みに失敗しました',
  ...MAIN_LOCALE_MESSAGES['ja-JP'],
  'locale.en-US': 'English', 'locale.zh-CN': '简体中文', 'locale.ja-JP': '日本語',
  'settings.title': '設定',
  'settings.section.general': '一般', 'settings.section.models': 'モデル設定', 'settings.section.voice': '音声設定', 'settings.section.asr': '音声認識', 'settings.section.tts': '音声合成', 'settings.section.memory': '長期記憶',
  'settings.loading_error': '設定を読み込めません', 'settings.save_error': '{key} を保存できません', 'settings.update_error': '{key} を更新できません', 'settings.saving': '{key} を保存中…',


  'settings.security.available': '秘密情報は OS により保護されています', 'settings.security.unavailable': 'OS の秘密情報暗号化を利用できません',

  'settings.note.no_user_settings': 'ユーザー管理の接続設定はありません。', 'settings.note.no_active_connection': '選択中のアクティブな接続はありません。', 'settings.advanced': '詳細設定（リアルタイム調整）',
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
  'common.cancel': 'キャンセル', 'common.save': '保存', 'common.edit': '編集', 'common.delete': '削除', 'common.refresh': '更新',

  'scene.stop': '返信を停止', 'scene.stop_failed': '返信を停止できません：{error}',
  'scene.sessions': '会話一覧', 'scene.session_group_current': '会話',
  'scene.session_untitled': '無題', 'scene.session_rename': '名前を変更', 'scene.session_rename_save': '名前を保存', 'scene.session_delete': '会話を削除',
  'scene.session_reports': '未処理の報告 {count} 件', 'scene.session_approvals': '承認待ちの操作 {count} 件',
  'scene.session_delete_title': 'この会話を削除しますか？', 'scene.session_delete_body': '「{title}」とその中のタスクは完全に削除されます。',
  'scene.session_rename_failed': '会話の名前を変更できません：{error}', 'scene.session_delete_failed': '会話を削除できません：{error}',

  'scene.work': 'ワーク',
  'work.empty': 'まだ委任したタスクはありません。サブエージェントに任せたタスクと、その作業内容がここに表示されます。',
  'work.open': '進行中（{count}）', 'work.finished': '終了済み（{count}）', 'work.show_more': 'さらに {count} 件表示',
  'work.refresh': '更新', 'work.back': '一覧に戻る', 'work.jump': '会話を開く',
  'work.tool_uses': 'ツール呼び出し {count} 回', 'work.tokens': '{count} トークン', 'work.waiting': '待機 {time}',
  'work.loading': '読み込み中…', 'work.load_failed': '一覧を読み込めません：{error}', 'work.trace_failed': '実行内容を読み込めません：{error}',
  'work.trace_empty': 'まだステップはありません。', 'work.brief': 'タスク内容', 'work.progress': '進捗', 'work.reason': '理由',
  'work.not_live': 'サブエージェントが実行中です。新しいステップはここにリアルタイムで表示されます。',
  'task.title': 'タスク', 'task.card': 'タスク',
  'task.kind.research': '調査', 'task.kind.files': 'ファイル', 'task.kind.task': 'タスク', 'task.kind.remote': 'リモート',
  'task.status.queued': '待機中', 'task.status.running': '実行中', 'task.status.done': '完了', 'task.status.failed': '失敗', 'task.status.timeout': 'タイムアウト', 'task.status.cancelled': 'キャンセル済み', 'task.status.needs_input': '回答待ち',
  'task.round': '{count} 回目',
  'task.progress.now': 'たった今', 'task.progress.seconds': '{count} 秒前', 'task.progress.minutes': '{count} 分前', 'task.progress.hours': '{count} 時間前',
  'task.question.label': 'サブエージェントからの質問', 'task.question.hint': '紅莉栖があなたに尋ねます。答えはそのまま引き継がれます。',
  'task.cancel': 'タスクをキャンセル', 'task.cancelling': 'キャンセル中…', 'task.cancel_failed': 'タスクをキャンセルできません：{error}',
  'task.show_finished': '終了済み {count} 件を表示', 'task.hide_finished': '終了済みを隠す', 'task.expand': '全文を表示', 'task.collapse': '閉じる',
  'task.approval.heading': '承認待ち', 'task.approval.allow': '今回のみ許可', 'task.approval.deny': '拒否',
  'task.approval.expires': 'あと {time} で期限切れ', 'task.approval.show': '詳細を表示', 'task.approval.hide': '詳細を隠す',
  'task.approval.allowed': '許可済み', 'task.approval.denied': '拒否済み', 'task.approval.expired': '期限切れ',
  'task.approval.failed': '決定を送信できません：{error}', 'task.approval.gone': 'この要求は処理済みか期限切れです。',
  'task.approval.waiting': '承認待ちの操作が {count} 件あります', 'task.approval.view': '表示',
  'task.approval.review': '承認する前に内容をすべて確認してください。', 'task.approval.no_detail': 'この要求には詳細が付いていないため、何が行われるか確認できません。不明な場合は拒否してください。',
  'task.detail.command': 'コマンド', 'task.detail.cwd': '作業ディレクトリ', 'task.detail.path': 'パス', 'task.detail.preview': '詳細',
  'task.detail.path.write': '書き込むファイル', 'task.detail.path.edit': '変更するファイル',
  'task.detail.preview.write': '書き込む内容', 'task.detail.preview.edit': '変更内容（「-」削除、「+」追加）',
  'task.detail.mcp_tool': 'MCP ツール', 'task.detail.preview.mcp': '引数',

  'memory.title': '長期記憶', 'memory.unavailable': '記憶サービスはまだ利用できません。', 'memory.loading': '読み込み中…',
  'memory.enabled': '会話をまたいで記憶する', 'memory.recall': 'エピソード想起',
  'memory.recall.off': 'オフ', 'memory.recall.log': '記録のみ', 'memory.recall.on': 'オン',
  'memory.snapshot': 'プロンプト使用量', 'memory.snapshot_truncated': '一部の記憶は収まらず使用されていません。',
  'memory.open_folder': 'フォルダを開く', 'memory.clear': 'すべて消去',
  'memory.clear_title': '長期記憶をすべて消去しますか？', 'memory.clear_body': 'コア記憶と確認待ちの提案はゴミ箱に移され、7 日間保持されます。',
  'memory.core': 'コア記憶', 'memory.core_empty': 'まだ何もありません。Amadeus に覚えていてほしいことを追加してください。',
  'memory.type.profile': 'プロフィール', 'memory.type.preference': '好み', 'memory.type.relationship': '関係', 'memory.type.feedback': 'フィードバック', 'memory.type.ongoing': '進行中',
  'memory.add': '記憶を追加', 'memory.add_placeholder': '短く完結した一文（120 文字以内）', 'memory.review_after': '見直し日',
  'memory.badge.not_injected': '未使用', 'memory.badge.due': '要見直し', 'memory.review_by': '{date} までに見直し',
  'memory.due_hint': '見直し日を過ぎたため使用されていません。今も当てはまりますか？', 'memory.still_true': '今も当てはまる（30 日延長）', 'memory.ended': '終了',
  'memory.optional': 'オプション：Jev 記憶判定', 'memory.pending': '確認待ち', 'memory.pending_empty': '現在、提案はありません。',
  'memory.accept': '承認', 'memory.reject': '却下',
  'memory.confidence': '確度：{level}', 'memory.confidence.high': '高', 'memory.confidence.medium': '中', 'memory.confidence.low': '低',
  'memory.quote': 'あなたの発言：「{quote}」', 'memory.proposal.replace': '置き換え対象：', 'memory.proposal.remove': '削除対象：',
  'memory.archived': 'アーカイブ済みの提案（{count}）', 'memory.invalid': '解析できないファイル（{count}）',
  'memory.source.manual': 'あなたが追加', 'memory.source.explicit': '覚えるよう依頼', 'memory.source.extracted': '会話から推定',
  'memory.save_error': '記憶の更新に失敗しました：{error}',

  'settings.translation.title': '日本語翻訳', 'settings.subagent.title': 'サブエージェント', 'settings.capability_mode.isolated': '分離（Amadeus のみ）', 'settings.capability_mode.shared': 'このコンピューターと共有',
  'settings.delegation_model.same': '会話モデルと同じ',
  'settings.remote.title': 'リモートマシン',
  'settings.remote.name': '名前', 'settings.remote.ssh': 'SSH コマンド', 'settings.remote.workspace': '作業ディレクトリ', 'settings.remote.node': 'Node',
  'settings.remote.add': 'マシンを追加', 'settings.remote.new': '新しいマシン', 'settings.remote.edit': '編集', 'settings.remote.remove': '{name} を削除',
  'settings.remote.advanced': '詳細（作業ディレクトリ、Node）', 'settings.remote.cancel': 'キャンセル', 'settings.remote.save_test': '保存してテスト',
  'settings.remote.test': 'テスト', 'settings.remote.testing': '接続中…',
  'settings.remote.ok': '接続済み：{path}（{os}/{arch}、Node {node}）', 'settings.remote.failed': '接続できません：{error}',
  'settings.character.title': 'キャラクター素材',
  'settings.character.choose': 'emote.zip からインストール', 'settings.character.installing': 'インストール中…',
  'settings.character.installed': 'インストールしました。以降このパックが使われます。', 'settings.character.failed': 'インストールに失敗しました：{error}',

}

const MESSAGES: Record<Locale, Messages> = { 'en-US': EN, 'zh-CN': ZH, 'ja-JP': JA }
export type MessageKey = keyof typeof EN

type SettingCopy = Record<'group' | 'field' | 'description' | 'groupDescription' | 'status' | 'option', Record<string, string>>

const ZH_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（本地）', speech_synthesis: 'Fish Audio 实时合成', display: '显示', network: '网络', memory: '长期记忆（Jev）', translation: '日语翻译', delegation: '委托',
  },
  field: {
    asr_language: '识别语言', FISH_API_KEY: 'Fish Audio API 密钥', FISH_VOICE_ID: 'Fish 声音 ID', FISH_API_MODEL: 'Fish 模型',
    mouth_gain: '嘴型增益', mouth_silence_threshold: '静音阈值', voice_sync_offset_ms: '音画同步偏移（毫秒）', network_proxy: '网络代理',
    scene_frame_rate: '场景帧率（FPS）',
    JEV_API_URL: 'Jev API 地址', JEV_API_KEY: 'Jev API 密钥', JEV_MODEL: 'Jev 模型',
    report_proactive: '主动汇报', delegation_model: '委托模型', translation_model: '翻译模型', skills_mode: 'Skills', mcp_mode: 'MCP 服务',
  },
  description: {}, groupDescription: {}, status: {}, option: {},
}

const JA_SETTINGS: SettingCopy = {
  group: {
    asr_local: 'Apple Speech（ローカル）', speech_synthesis: 'Fish Audio リアルタイム合成', display: '表示', network: 'ネットワーク', memory: '長期記憶（Jev）', translation: '日本語翻訳', delegation: '委任',
  },
  field: {
    asr_language: '認識言語', FISH_API_KEY: 'Fish Audio API キー', FISH_VOICE_ID: 'Fish ボイス ID', FISH_API_MODEL: 'Fish モデル',
    mouth_gain: '口の動きのゲイン', mouth_silence_threshold: '無音しきい値', voice_sync_offset_ms: '音声同期オフセット（ミリ秒）', network_proxy: 'ネットワークプロキシ',
    scene_frame_rate: 'シーンのフレームレート（FPS）',
    JEV_API_URL: 'Jev API エンドポイント', JEV_API_KEY: 'Jev API キー', JEV_MODEL: 'Jev モデル',
    report_proactive: '能動的な報告', delegation_model: '委任モデル', translation_model: '翻訳モデル', skills_mode: 'スキル', mcp_mode: 'MCP サーバー',
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
