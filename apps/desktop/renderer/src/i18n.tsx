import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Locale = 'zh-CN' | 'en'
export const LOCALE_STORAGE_KEY = 'aliasai.locale'

const en = {
  'app.tagline': 'Local-first privacy workspace',
  'language.label': 'Language',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'language.switch': 'Switch language',
  'matters.title': 'Matters',
  'matters.empty': 'No matters yet',
  'matters.namePlaceholder': 'New matter name',
  'matters.create': 'Create',
  'documents.title': 'Documents',
  'documents.selectMatter': 'Select a matter first',
  'documents.empty': 'No documents yet',
  'documents.import': 'Import PDF…',
  'nav.review': 'Review',
  'nav.preview': 'Sanitized preview',
  'workspace.noReview': 'No review data',
  'workspace.select': 'Select a matter and document',
  'pipeline.parse': 'Parse',
  'pipeline.detect': 'Detect',
  'pipeline.resolve': 'Resolve',
  'pipeline.run': 'Run {stage}',
  'pipeline.retry': 'Retry {stage}',
  'pipeline.idle': 'Pipeline idle',
  'pipeline.progress': '{stage}: {percent}%',
  'block.position': 'Page {page} · Block {block}',
  'mention.select': 'Select a highlighted mention to review it',
  'mention.details': '{type} · {strength} · confidence {confidence} · page {page}',
  'mention.margin': ' · margin {margin}',
  'mention.review': ' · review {status}',
  'mention.assigned': 'Assigned to',
  'mention.locked': 'Document is sanitized; re-import to change review decisions.',
  'mention.confirm': 'Confirm',
  'mention.confirmed': 'Confirmed',
  'mention.counts': '{mentions} mentions · {resolved} resolved · {needsReview} need review · {unresolved} unresolved',
  'candidate.empty': 'No candidates — create a new entity or keep pending',
  'candidate.summary': 'score {score} · {state}',
  'candidate.evidence': '{type} (weight {weight}, score {score})',
  'candidate.accept': 'Accept',
  'entity.title': 'Entities',
  'entity.empty': 'No entities',
  'entity.constraints': 'Cannot-Link constraints',
  'entity.none': 'None',
  'entity.first': 'First entity',
  'entity.firstOption': 'First…',
  'entity.second': 'Second entity',
  'entity.secondOption': 'Second…',
  'entity.reason': 'Reason',
  'entity.constraintReason': 'Constraint reason',
  'entity.cannotLink': 'Cannot-Link',
  'entity.noOther': 'No other entities',
  'entity.reassign': 'Reassign to',
  'entity.choose': 'Choose entity…',
  'entity.newAlias': 'New entity primary alias',
  'entity.type': 'Entity type',
  'entity.createAssign': 'Create entity & assign',
  'preview.empty': 'No preview yet',
  'preview.notReady': 'Run the pipeline to READY before generating a preview ({status}).',
  'preview.readyTitle': 'Ready to sanitize',
  'preview.readyDescription': 'All detected mentions have assignments and restoration tokens.',
  'preview.generating': 'Generating…',
  'preview.generate': 'Generate sanitized preview',
  'preview.blocked': 'Preview blocked',
  'preview.reviewMention': 'Review mention',
  'preview.resolveAll': 'Resolve every mention in review, then generate again.',
  'preview.title': 'Sanitized preview',
  'preview.copy': 'Copy sanitized document',
  'preview.export': 'Export sanitized document…',
  'preview.copied': 'Sanitized document copied.',
  'preview.saved': 'Sanitized document saved.',
  'preview.demoTitle': 'Local rehydration demo',
  'preview.demoHint': 'Paste or edit the sanitized text as a simulated AI reply; tokens are restored locally only.',
  'preview.demoAria': 'Simulated AI reply',
  'preview.restoreOnRequest': 'Restore RESTORE_ON_REQUEST values',
  'preview.rehydrate': 'Rehydrate locally',
  'preview.useSanitized': 'Use sanitized text',
  'preview.unresolved': 'Unresolved tokens for manual review: {tokens}',
  'preview.regenerate': 'Regenerate',
  'ai.title': 'Mock AI',
  'ai.hint': 'Only the persisted sanitized document is sent. Restoration happens locally.',
  'ai.restoreOnRequest': 'Restore RESTORE_ON_REQUEST values locally',
  'ai.runningButton': 'Running…',
  'ai.send': 'Send sanitized document',
  'ai.running': 'AI execution is running.',
  'ai.failed': 'AI execution failed: {code}',
  'ai.sanitizedResponse': 'Sanitized AI response',
  'ai.restoredResponse': 'Locally rehydrated response',
  'ai.restoredWarning': 'Copying or exporting this restored result exposes sensitive plaintext outside AliasAI.',
  'ai.copy': 'Copy {variant} response',
  'ai.export': 'Export {variant} response…',
  'ai.sanitizedVariant': 'sanitized',
  'ai.restoredVariant': 'restored',
  'ai.sanitizedCopied': 'Sanitized response copied.',
  'ai.sanitizedSaved': 'Sanitized response saved.',
  'ai.restoredCopied': 'Restored response copied.',
  'ai.restoredSaved': 'Restored response saved.',
  'ai.unresolved': 'Unresolved tokens: {tokens}'
} as const

type TranslationKey = keyof typeof en

const zh = {
  'app.tagline': '本地优先的隐私保护工作台',
  'language.label': '界面语言',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'language.switch': '切换语言',
  'matters.title': '事项',
  'matters.empty': '还没有事项',
  'matters.namePlaceholder': '新事项名称',
  'matters.create': '创建',
  'documents.title': '文档',
  'documents.selectMatter': '请先选择事项',
  'documents.empty': '还没有文档',
  'documents.import': '导入 PDF…',
  'nav.review': '审查',
  'nav.preview': '脱敏预览',
  'workspace.noReview': '暂无审查数据',
  'workspace.select': '请选择事项和文档',
  'pipeline.parse': '解析',
  'pipeline.detect': '隐私检测',
  'pipeline.resolve': '实体解析',
  'pipeline.run': '运行{stage}',
  'pipeline.retry': '重试{stage}',
  'pipeline.idle': '处理流程空闲',
  'pipeline.progress': '{stage}：{percent}%',
  'block.position': '第 {page} 页 · 第 {block} 个文本块',
  'mention.select': '请选择高亮的敏感信息进行审查',
  'mention.details': '{type} · {strength} · 置信度 {confidence} · 第 {page} 页',
  'mention.margin': ' · 分差 {margin}',
  'mention.review': ' · 审查状态 {status}',
  'mention.assigned': '已分配给',
  'mention.locked': '文档已经脱敏；如需修改审查结果，请重新导入文档。',
  'mention.confirm': '确认',
  'mention.confirmed': '已确认',
  'mention.counts': '共 {mentions} 处 · 已解析 {resolved} 处 · 待审查 {needsReview} 处 · 未解析 {unresolved} 处',
  'candidate.empty': '没有候选实体——可创建新实体或暂时保留未决状态',
  'candidate.summary': '得分 {score} · {state}',
  'candidate.evidence': '{type}（权重 {weight}，得分 {score}）',
  'candidate.accept': '接受',
  'entity.title': '实体',
  'entity.empty': '还没有实体',
  'entity.constraints': '禁止关联约束',
  'entity.none': '无',
  'entity.first': '第一个实体',
  'entity.firstOption': '选择第一个实体…',
  'entity.second': '第二个实体',
  'entity.secondOption': '选择第二个实体…',
  'entity.reason': '原因',
  'entity.constraintReason': '约束原因',
  'entity.cannotLink': '禁止关联',
  'entity.noOther': '没有其他实体',
  'entity.reassign': '重新分配给',
  'entity.choose': '选择实体…',
  'entity.newAlias': '新实体的主要别名',
  'entity.type': '实体类型',
  'entity.createAssign': '创建实体并分配',
  'preview.empty': '还没有脱敏预览',
  'preview.notReady': '请先运行处理流程，文档达到“就绪”状态后才能生成脱敏预览（当前：{status}）。',
  'preview.readyTitle': '可以生成脱敏文档',
  'preview.readyDescription': '所有检测到的敏感信息都已分配实体并具备还原令牌。',
  'preview.generating': '正在生成…',
  'preview.generate': '生成脱敏预览',
  'preview.blocked': '暂时无法生成预览',
  'preview.reviewMention': '审查此项',
  'preview.resolveAll': '请在审查页面处理所有敏感信息，然后再次生成。',
  'preview.title': '脱敏预览',
  'preview.copy': '复制脱敏文档',
  'preview.export': '导出脱敏文档…',
  'preview.copied': '已复制脱敏文档。',
  'preview.saved': '已保存脱敏文档。',
  'preview.demoTitle': '本地还原演示',
  'preview.demoHint': '粘贴或编辑脱敏文本来模拟 AI 回复；令牌只会在本地还原。',
  'preview.demoAria': '模拟 AI 回复',
  'preview.restoreOnRequest': '还原“按需还原”的值',
  'preview.rehydrate': '在本地还原',
  'preview.useSanitized': '使用脱敏文本',
  'preview.unresolved': '需要人工检查的未还原令牌：{tokens}',
  'preview.regenerate': '重新生成',
  'ai.title': '模拟 AI',
  'ai.hint': '只发送已持久化的脱敏文档；真实内容仅在本地还原。',
  'ai.restoreOnRequest': '在本地还原“按需还原”的值',
  'ai.runningButton': '正在运行…',
  'ai.send': '发送脱敏文档',
  'ai.running': 'AI 正在处理。',
  'ai.failed': 'AI 处理失败：{code}',
  'ai.sanitizedResponse': '脱敏后的 AI 回复',
  'ai.restoredResponse': '本地还原后的回复',
  'ai.restoredWarning': '复制或导出还原结果会让敏感明文离开 AliasAI 的保护边界。',
  'ai.copy': '复制{variant}回复',
  'ai.export': '导出{variant}回复…',
  'ai.sanitizedVariant': '脱敏',
  'ai.restoredVariant': '还原',
  'ai.sanitizedCopied': '已复制脱敏回复。',
  'ai.sanitizedSaved': '已保存脱敏回复。',
  'ai.restoredCopied': '已复制还原回复。',
  'ai.restoredSaved': '已保存还原回复。',
  'ai.unresolved': '未还原令牌：{tokens}'
} satisfies Record<TranslationKey, string>

const translations: Record<Locale, Record<TranslationKey, string>> = { en, 'zh-CN': zh }

const codeLabels: Record<Locale, Readonly<Record<string, string>>> = {
  en: {
    IMPORTED: 'Imported', PARSING: 'Parsing', PARSED: 'Parsed', DETECTING: 'Detecting', DETECTED: 'Detected',
    RESOLVING: 'Resolving', READY: 'Ready', SANITIZING: 'Sanitizing', SANITIZED: 'Sanitized', FAILED: 'Failed',
    PARSE: 'Parse', OCR: 'OCR', DETECT: 'Detect', RESOLVE: 'Resolve', SANITIZE: 'Sanitize', VERIFY: 'Verify',
    PERSON: 'Person', ORGANIZATION: 'Organization', PHONE: 'Phone number', EMAIL: 'Email address',
    ID_CARD: 'ID card number', BANK_ACCOUNT: 'Bank account', ADDRESS: 'Address', CASE_NUMBER: 'Case number',
    CONTRACT_NUMBER: 'Contract number', COURT: 'Court', LAWYER: 'Lawyer', JUDGE: 'Judge',
    EXPLICIT: 'Explicit', PARTIAL: 'Partial', REFERENCE: 'Reference', UNREVIEWED: 'Unreviewed', CONFIRMED: 'Confirmed',
    REJECTED: 'Rejected', AUTO_LINKED: 'Auto-linked', USER_ASSIGNED: 'User assigned', NEEDS_REVIEW: 'Needs review',
    UNRESOLVED: 'Unresolved', PENDING: 'Pending', ACCEPTED: 'Accepted', SAME_ID_CARD: 'Same ID card',
    NAME_EXACT: 'Exact name', EXACT_NAME: 'Exact name', SHARED_PROTECTED_VALUE: 'Shared protected value',
    USER_MUST_LINK: 'User Must-Link', USER_CANNOT_LINK: 'User Cannot-Link',
    CONFLICTING_ID_CARD: 'Conflicting ID card', UNSUPPORTED_TYPE: 'Unsupported type', INACTIVE_ENTITY: 'Inactive entity',
    MISSING_ALIAS: 'Missing alias', MISSING_TOKEN: 'Missing restoration token', CANNOT_LINK: 'Cannot-Link', MUST_LINK: 'Must-Link'
  },
  'zh-CN': {
    IMPORTED: '已导入', PARSING: '解析中', PARSED: '已解析', DETECTING: '检测中', DETECTED: '已检测',
    RESOLVING: '实体解析中', READY: '就绪', SANITIZING: '脱敏中', SANITIZED: '已脱敏', FAILED: '失败',
    PARSE: '解析', OCR: '文字识别', DETECT: '隐私检测', RESOLVE: '实体解析', SANITIZE: '脱敏', VERIFY: '验证',
    PERSON: '个人', ORGANIZATION: '组织', PHONE: '电话号码', EMAIL: '电子邮箱', ID_CARD: '身份证号',
    BANK_ACCOUNT: '银行账号', ADDRESS: '地址', CASE_NUMBER: '案号', CONTRACT_NUMBER: '合同编号', COURT: '法院',
    LAWYER: '律师', JUDGE: '法官', EXPLICIT: '明确提及', PARTIAL: '部分提及', REFERENCE: '指代',
    UNREVIEWED: '未审查', CONFIRMED: '已确认', REJECTED: '已拒绝', AUTO_LINKED: '自动关联',
    USER_ASSIGNED: '用户分配', NEEDS_REVIEW: '待审查', UNRESOLVED: '未解析', PENDING: '待处理', ACCEPTED: '已接受',
    SAME_ID_CARD: '身份证号相同', NAME_EXACT: '姓名完全一致', EXACT_NAME: '姓名完全一致',
    SHARED_PROTECTED_VALUE: '受保护值相同', USER_MUST_LINK: '用户要求关联',
    USER_CANNOT_LINK: '用户禁止关联', CONFLICTING_ID_CARD: '身份证号冲突', UNSUPPORTED_TYPE: '暂不支持的类型',
    INACTIVE_ENTITY: '实体已停用', MISSING_ALIAS: '缺少别名', MISSING_TOKEN: '缺少还原令牌',
    CANNOT_LINK: '禁止关联', MUST_LINK: '必须关联'
  }
}

const chineseErrors: Readonly<Record<string, string>> = {
  VALIDATION_ERROR: '输入内容无效，请检查后重试。',
  INTERNAL_ERROR: '发生内部错误，请重试。',
  DOCUMENT_NOT_FOUND: '未找到该文档。',
  MENTION_NOT_FOUND: '未找到该敏感信息。',
  MENTION_UNASSIGNED: '请先为该敏感信息分配实体。',
  ASSIGNMENT_FAILED: '实体分配失败，请重试。',
  CONFIRMATION_FAILED: '确认失败，请重试。',
  CONSTRAINT_FAILED: '保存约束失败，请重试。',
  SOURCE_CHANGED: '源文件已经发生变化，请重新导入。',
  SOURCE_PATH_UNAVAILABLE: '源文件路径不可用，请重新导入。',
  SOURCE_PATH_DECRYPTION_FAILED: '无法读取源文件路径，请重新导入。',
  SOURCE_VALIDATION_FAILED: '无法验证源文件，请检查文件后重试。',
  UNSUPPORTED_DOCUMENT: '当前版本暂不支持此类文档。',
  PROCESSOR_FAILURE: '文档解析失败，请重试。',
  INVALID_DOCUMENT_MODEL: '文档解析结果无效。',
  DETECTION_NOT_AVAILABLE: '当前文档还不能进行隐私检测。',
  DETECTION_FAILED: '隐私检测失败，请重试。',
  RESOLUTION_NOT_AVAILABLE: '当前文档还不能进行实体解析。',
  RESOLUTION_FAILED: '实体解析失败，请重试。',
  SANITIZATION_NOT_AVAILABLE: '当前文档还不能进行脱敏。',
  SANITIZATION_FAILED: '脱敏失败，请检查审查结果后重试。',
  UNSUPPORTED_MENTION_TYPE: '文档包含当前版本暂不支持的敏感信息类型。',
  UNRESOLVED_MENTION: '仍有敏感信息尚未解析。',
  LEAK_DETECTED: '检测到潜在隐私泄漏，已阻止继续处理。',
  SANITIZED_DOCUMENT_NOT_AVAILABLE: '脱敏文档不可用，请重新生成。',
  AI_RESULT_NOT_AVAILABLE: 'AI 结果不可用，请重新运行。',
  AI_PROVIDER_FAILURE: 'AI 服务执行失败，请重试。',
  INVALID_PROVIDER_RESPONSE: 'AI 返回了无效结果。',
  OUTBOUND_LEAK_DETECTED: '发送前检测到潜在隐私泄漏，已阻止发送。',
  OUTBOUND_PAYLOAD_TOO_LARGE: '脱敏文档超过发送大小限制。',
  OUTBOUND_DENYLIST_TOO_LARGE: '当前事项中的受保护值过多，已阻止发送。',
  OUTBOUND_DENYLIST_INTEGRITY_FAILURE: '隐私校验数据异常，已阻止发送。',
  AI_SOURCE_INTEGRITY_FAILURE: '脱敏文档完整性校验失败，已阻止发送。',
  AI_REHYDRATION_FAILED: 'AI 结果的本地还原失败。'
}

type TranslationParams = Readonly<Record<string, string | number>>

interface LocalizableError {
  readonly code: string
  readonly message: string
}

interface I18nContextValue {
  readonly locale: Locale
  readonly setLocale: (locale: Locale) => void
  readonly t: (key: TranslationKey, params?: TranslationParams) => string
  readonly label: (code: string) => string
  readonly formatError: (error: LocalizableError) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider(props: { readonly children: ReactNode; readonly initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => props.initialLocale ?? readStoredLocale())

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      // Language remains active for this session when storage is unavailable.
    }
  }, [locale])

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => interpolate(translations[locale][key], params),
    [locale]
  )
  const label = useCallback((code: string) => codeLabels[locale][code] ?? code, [locale])
  const formatError = useCallback(
    (error: LocalizableError) => locale === 'en' ? error.message : chineseErrors[error.code] ?? `操作失败（${error.code}）。`,
    [locale]
  )
  const value = useMemo(() => ({ locale, setLocale, t, label, formatError }), [locale, t, label, formatError])

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (context === null) throw new Error('useI18n must be used within I18nProvider')
  return context
}

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    return stored === 'en' || stored === 'zh-CN' ? stored : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

function interpolate(template: string, params?: TranslationParams): string {
  if (params === undefined) return template
  return template.replace(/\{([A-Za-z]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  )
}
