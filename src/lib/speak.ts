import { newId, nowIso } from "./ids.js";
import { recordSpeakInteraction } from "./store.js";
import type {
  JsonObject,
  ListenResult,
  SpeakAudience,
  SpeakChannel,
  SpeakContentType,
  SpeakIdentity,
  SpeakMessage,
  SpeakMode,
  SpeakPlan,
  SpeakResult,
  SpeakSafetyPolicy,
  SpeakSourcePolicy,
  SpeakSourceRef,
  SpeakSourceRefKind,
  SpeakTone
} from "./types.js";

const speakAudiences = new Set<SpeakAudience>([
  "user",
  "developer",
  "future_self",
  "external_person",
  "external_group",
  "public",
  "machine"
]);

const speakChannels = new Set<SpeakChannel>([
  "local_chat",
  "web_ui",
  "terminal",
  "document_draft",
  "email_draft",
  "im_draft",
  "external_channel_draft",
  "voice_draft",
  "machine_output"
]);

const speakModes = new Set<SpeakMode>([
  "answer",
  "explain",
  "ask",
  "status",
  "plan",
  "report",
  "warn",
  "draft",
  "summarize",
  "structured",
  "acknowledge",
  "decline"
]);

const speakContentTypes = new Set<SpeakContentType>([
  "plain_text",
  "markdown",
  "code",
  "json",
  "yaml",
  "table",
  "checklist",
  "diff_summary",
  "citation_summary",
  "question",
  "draft_message"
]);

const speakTones = new Set<SpeakTone>([
  "calm",
  "friendly",
  "direct",
  "technical",
  "teaching",
  "formal",
  "concise"
]);

const speakIdentities = new Set<SpeakIdentity>([
  "assistant",
  "user_draft",
  "system_status",
  "tool_report",
  "external_message_draft"
]);

const speakSourceRefKinds = new Set<SpeakSourceRefKind>([
  "context_block",
  "read_result",
  "tool_result",
  "memory",
  "user_message",
  "listen_result",
  "inference",
  "system_status"
]);

const secretLikePatterns = [
  /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/
];

export interface CreateSpeakPlanInput {
  goal?: string;
  reason?: string;
  audience?: SpeakAudience;
  channel?: SpeakChannel;
  mode?: SpeakMode;
  contentTypes?: SpeakContentType[];
  tone?: SpeakTone;
  detailLevel?: SpeakPlan["detailLevel"];
  language?: SpeakPlan["language"];
  locale?: string;
  identity?: SpeakIdentity;
  sourcePolicy?: Partial<SpeakSourcePolicy>;
  safetyPolicy?: Partial<SpeakSafetyPolicy>;
  requiresApprovalBeforeDelivery?: boolean;
}

export interface CreateSpeakMessageInput {
  title?: string;
  content: string;
  format?: SpeakMessage["format"];
  sourceRefs?: SpeakSourceRef[];
  assumptions?: string[];
  uncertaintyFlags?: string[];
  riskFlags?: string[];
  draft?: boolean;
}

export interface CreateSpeakResultInput {
  delivered?: boolean;
  deliveryTarget?: SpeakChannel;
  blockedReason?: string;
}

export interface SpeakInteractionInput extends CreateSpeakPlanInput, CreateSpeakMessageInput {
  sessionId?: string;
}

export interface SpeakInteractionOutput {
  plan: SpeakPlan;
  message: SpeakMessage;
  result: SpeakResult;
}

/**
 * 创建一次表达计划。
 *
 * 使用方法：
 * - Agent Core 决定需要表达时调用 createSpeakPlan({ mode, audience, channel })。
 * - 本地聊天默认使用 audience=user、channel=local_chat、mode=answer。
 * - 外部受众或草稿 Channel 会自动标记 requiresApprovalBeforeDelivery。
 *
 * 作用：
 * - 把“说什么、对谁说、用什么身份说、是否需要外部投递确认”固定成结构化计划。
 * - 让嘴巴不再是裸文本输出，而是可审计、可过滤、可扩展的表达层。
 *
 * @param input 创建 SpeakPlan 所需的结构化输入。
 */
export function createSpeakPlan(input: CreateSpeakPlanInput = {}): SpeakPlan {
  const audience = input.audience || "user";
  const channel = input.channel || "local_chat";
  const mode = input.mode || "answer";
  const contentTypes = normalizeContentTypes(input.contentTypes || ["plain_text"]);
  const language = input.language || languageFromLocale(input.locale);
  const identity = input.identity || defaultIdentity(audience, channel, mode);
  return {
    id: newId("spk"),
    goal: cleanString(input.goal) || defaultGoalForMode(mode, language),
    reason: cleanString(input.reason) || defaultReasonForMode(mode, language),
    audience: coerceSpeakAudience(audience),
    channel: coerceSpeakChannel(channel),
    mode: coerceSpeakMode(mode),
    contentTypes,
    tone: coerceSpeakTone(input.tone || defaultToneForMode(mode, audience)),
    detailLevel: input.detailLevel || defaultDetailLevel(mode),
    language,
    identity: coerceSpeakIdentity(identity),
    sourcePolicy: mergeSourcePolicy(input.sourcePolicy),
    safetyPolicy: mergeSafetyPolicy(input.safetyPolicy),
    requiresApprovalBeforeDelivery:
      input.requiresApprovalBeforeDelivery ?? requiresExternalDeliveryApproval(audience, channel),
    createdAt: nowIso()
  };
}

/**
 * 根据听力结果推断本轮表达模式。
 *
 * 使用方法：
 * - 用户消息已经经过 listen.ts 分析后，把 ListenResult 传入。
 * - 返回值可以直接传给 createSpeakPlan({ mode })。
 *
 * 作用：
 * - 让“耳朵”的 intent 和“嘴巴”的表达模式接起来。
 * - 例如 status -> status，correct -> acknowledge，implement/design -> plan。
 *
 * @param result 当前要格式化、返回、审计或持久化的能力结果。
 */
export function speakModeFromListenResult(result: ListenResult): SpeakMode {
  if (result.nextStep === "ask_clarifying_question") return "ask";
  if (result.nextStep === "pause" || result.nextStep === "resume") return "acknowledge";
  if (result.nextStep === "plan" || result.primaryIntent === "design" || result.primaryIntent === "implement") {
    return "plan";
  }
  if (result.primaryIntent === "status") return "status";
  if (result.primaryIntent === "explain") return "explain";
  if (result.primaryIntent === "correct") return "acknowledge";
  if (result.primaryIntent === "reject") return "decline";
  return "answer";
}

/**
 * 创建一次实际表达消息。
 *
 * 使用方法：
 * - 先创建 SpeakPlan，再调用 createSpeakMessage(plan, { content })。
 * - sourceRefs、assumptions、uncertaintyFlags 和 riskFlags 都是可选增强信息。
 * - 这个方法只生成结构，不会写入持久化。
 *
 * 作用：
 * - 对输出内容做草稿标记、敏感信息过滤、风险标记和格式判断。
 * - 明确“这是一条要展示的表达”，而不是执行结果或外部发送记录。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param input 创建 SpeakMessage 所需的结构化输入。
 */
export function createSpeakMessage(plan: SpeakPlan, input: CreateSpeakMessageInput): SpeakMessage {
  const rawContent = String(input.content || "");
  const draft = input.draft ?? shouldMarkDraft(plan);
  const contentTypes = normalizeContentTypes(plan.contentTypes.length ? plan.contentTypes : inferContentTypes(rawContent, plan.mode));
  const format = input.format || formatForContentTypes(contentTypes);
  const sourceRefs = normalizeSourceRefs(input.sourceRefs || []);
  const assumptions = cleanStringArray(input.assumptions || []);
  const uncertaintyFlags = cleanStringArray(input.uncertaintyFlags || []);
  const initialRiskFlags = cleanStringArray(input.riskFlags || []);
  const contentAfterSafety = applySpeakSafetyFilters(rawContent || fallbackContentForMode(plan), plan);
  const content = draft && plan.safetyPolicy.requireDraftLabel
    ? ensureDraftLabel(contentAfterSafety, plan.language)
    : contentAfterSafety;
  const riskFlags = detectSpeakRiskFlags(plan, rawContent, content, {
    sourceRefs,
    assumptions,
    uncertaintyFlags,
    draft,
    initialRiskFlags
  });

  return {
    id: newId("spm"),
    planId: plan.id,
    audience: plan.audience,
    channel: plan.channel,
    mode: plan.mode,
    title: cleanString(input.title),
    content,
    format,
    sourceRefs,
    assumptions,
    uncertaintyFlags,
    riskFlags,
    draft,
    createdAt: nowIso()
  };
}

/**
 * 创建一次表达结果。
 *
 * 使用方法：
 * - SpeakMessage 已经准备好后调用 createSpeakResult(plan, message)。
 * - delivered 表示嘴巴是否已经把内容交给本地展示或草稿输出。
 * - externalDelivery 永远是 false，因为嘴巴不负责真正对外发送。
 *
 * 作用：
 * - 固定“表达已生成/已交付到哪里/是否被阻止”的结果记录。
 * - 把本地表达和未来外部发送能力分开。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param message 需要持久化、表达或关联审计的单条消息。
 * @param input 创建 SpeakResult 所需的结构化输入。
 */
export function createSpeakResult(
  plan: SpeakPlan,
  message: SpeakMessage,
  input: CreateSpeakResultInput = {}
): SpeakResult {
  return {
    id: newId("spr"),
    planId: plan.id,
    messageId: message.id,
    delivered: input.delivered ?? !input.blockedReason,
    deliveryTarget: input.deliveryTarget || plan.channel,
    externalDelivery: false,
    blockedReason: cleanString(input.blockedReason),
    createdAt: nowIso()
  };
}

/**
 * 创建并记录一整次嘴巴表达。
 *
 * 使用方法：
 * - Agent 需要输出 assistant 消息时，调用 createAndRecordSpeakInteraction({ content, mode })。
 * - API 层需要预览或生成草稿时也可以调用。
 * - 返回 plan、message、result，调用方可以继续把 message.content 写入会话消息。
 *
 * 作用：
 * - 一次性完成 SpeakPlan、SpeakMessage、SpeakResult 和审计持久化。
 * - 保证正式表达入口都会留下“嘴巴说了什么、为什么说、对谁说”的记录。
 *
 * @param input 创建 AndRecordSpeakInteraction 所需的结构化输入。
 */
export async function createAndRecordSpeakInteraction(
  input: SpeakInteractionInput
): Promise<SpeakInteractionOutput> {
  const plan = createSpeakPlan(input);
  const message = createSpeakMessage(plan, input);
  const result = createSpeakResult(plan, message);
  return recordSpeakInteraction(plan, message, result, input.sessionId);
}

/**
 * 将外部输入收敛成合法受众。
 *
 * 使用方法：
 * - API 层或 createSpeakPlan 处理用户传入 audience 时调用。
 *
 * 作用：
 * - 拒绝未知受众，避免嘴巴在不知道对象是谁时输出。
 *
 * @param value 需要校验并转换为 SpeakAudience 的未知输入值。
 */
export function coerceSpeakAudience(value: unknown): SpeakAudience {
  if (typeof value !== "string" || !speakAudiences.has(value as SpeakAudience)) {
    throw new Error("Speak audience is not supported.");
  }
  return value as SpeakAudience;
}

/**
 * 将外部输入收敛成合法 Channel。
 *
 * 使用方法：
 * - API 层或 createSpeakPlan 处理 channel 字段时调用。
 *
 * 作用：
 * - 明确表达内容是本地聊天、文档草稿、邮件草稿还是机器输出。
 *
 * @param value 需要校验并转换为 SpeakChannel 的未知输入值。
 */
export function coerceSpeakChannel(value: unknown): SpeakChannel {
  if (typeof value !== "string" || !speakChannels.has(value as SpeakChannel)) {
    throw new Error("Speak channel is not supported.");
  }
  return value as SpeakChannel;
}

/**
 * 将外部输入收敛成合法表达模式。
 *
 * 使用方法：
 * - API 层或 createSpeakPlan 处理 mode 字段时调用。
 *
 * 作用：
 * - 让 answer、plan、report、draft 等输出场景进入稳定枚举。
 *
 * @param value 需要校验并转换为 SpeakMode 的未知输入值。
 */
export function coerceSpeakMode(value: unknown): SpeakMode {
  if (typeof value !== "string" || !speakModes.has(value as SpeakMode)) {
    throw new Error("Speak mode is not supported.");
  }
  return value as SpeakMode;
}

/**
 * 将外部输入收敛成合法内容类型。
 *
 * 使用方法：
 * - API 层处理 contentTypes 数组时逐项调用。
 *
 * 作用：
 * - 控制结构化输出类型，避免未知类型进入 UI 或后续 Channel。
 *
 * @param value 需要校验并转换为 SpeakContentType 的未知输入值。
 */
export function coerceSpeakContentType(value: unknown): SpeakContentType {
  if (typeof value !== "string" || !speakContentTypes.has(value as SpeakContentType)) {
    throw new Error("Speak content type is not supported.");
  }
  return value as SpeakContentType;
}

/**
 * 将外部输入收敛成合法语气。
 *
 * 使用方法：
 * - API 层或 createSpeakPlan 处理 tone 字段时调用。
 *
 * 作用：
 * - 让表达风格保持在可控集合中。
 *
 * @param value 需要校验并转换为 SpeakTone 的未知输入值。
 */
export function coerceSpeakTone(value: unknown): SpeakTone {
  if (typeof value !== "string" || !speakTones.has(value as SpeakTone)) {
    throw new Error("Speak tone is not supported.");
  }
  return value as SpeakTone;
}

/**
 * 将外部输入收敛成合法表达身份。
 *
 * 使用方法：
 * - createSpeakPlan 处理 identity 字段时调用。
 *
 * 作用：
 * - 避免嘴巴混淆 assistant、user_draft、tool_report 等身份。
 *
 * @param value 需要校验并转换为 SpeakIdentity 的未知输入值。
 */
export function coerceSpeakIdentity(value: unknown): SpeakIdentity {
  if (typeof value !== "string" || !speakIdentities.has(value as SpeakIdentity)) {
    throw new Error("Speak identity is not supported.");
  }
  return value as SpeakIdentity;
}

/**
 * 将 unknown 转成 SpeakSourceRef。
 *
 * 使用方法：
 * - /api/speak/compose 接收 sourceRefs 时可以调用。
 *
 * 作用：
 * - 保证来源引用至少有 kind 和 label。
 * - 让嘴巴可以区分来源是工具结果、记忆、上下文块还是推断。
 *
 * @param value 需要校验并转换为 SpeakSourceRef 的未知输入值。
 */
export function coerceSpeakSourceRef(value: unknown): SpeakSourceRef {
  if (!isJsonObject(value)) {
    throw new Error("Speak source ref must be an object.");
  }
  const kind = value.kind;
  const label = value.label;
  if (typeof kind !== "string" || !speakSourceRefKinds.has(kind as SpeakSourceRefKind)) {
    throw new Error("Speak source ref kind is not supported.");
  }
  if (typeof label !== "string" || !label.trim()) {
    throw new Error("Speak source ref label is required.");
  }
  return {
    kind: kind as SpeakSourceRefKind,
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined,
    label: label.trim(),
    uri: typeof value.uri === "string" && value.uri.trim() ? value.uri.trim() : undefined
  };
}

/**
 * 生成默认来源策略。
 *
 * 使用方法：
 * - createSpeakPlan 在 sourcePolicy 缺失时调用。
 *
 * 作用：
 * - 默认要求区分事实和推断，并保留本地文件和网页来源引用。
 */
function defaultSourcePolicy(): SpeakSourcePolicy {
  return {
    citeLocalFiles: true,
    citeWebSources: true,
    distinguishFactsFromInferences: true,
    includeUnverifiedWarning: true
  };
}

/**
 * 生成默认安全策略。
 *
 * 使用方法：
 * - createSpeakPlan 在 safetyPolicy 缺失时调用。
 *
 * 作用：
 * - 默认脱敏、避免虚假执行声称、避免外部承诺，并要求草稿标签。
 */
function defaultSafetyPolicy(): SpeakSafetyPolicy {
  return {
    redactSecrets: true,
    redactPrivateData: true,
    avoidExternalCommitment: true,
    avoidFalseExecutionClaim: true,
    requireDraftLabel: true
  };
}

/**
 * 合并来源策略，并忽略 undefined 字段。
 *
 * 使用方法：
 * - createSpeakPlan 在生成 sourcePolicy 时调用。
 *
 * 作用：
 * - API 层传入空对象或部分字段时不会把默认值覆盖成 undefined。
 * - 让“默认引用来源、区分推断、提示未验证内容”的策略始终稳定。
 *
 * @param policy 需要与默认策略合并或用于安全判断的策略配置。
 */
function mergeSourcePolicy(policy: Partial<SpeakSourcePolicy> | undefined): SpeakSourcePolicy {
  const merged = defaultSourcePolicy();
  if (!policy) return merged;
  if (typeof policy.citeLocalFiles === "boolean") merged.citeLocalFiles = policy.citeLocalFiles;
  if (typeof policy.citeWebSources === "boolean") merged.citeWebSources = policy.citeWebSources;
  if (typeof policy.distinguishFactsFromInferences === "boolean") {
    merged.distinguishFactsFromInferences = policy.distinguishFactsFromInferences;
  }
  if (typeof policy.includeUnverifiedWarning === "boolean") merged.includeUnverifiedWarning = policy.includeUnverifiedWarning;
  return merged;
}

/**
 * 合并安全策略，并忽略 undefined 字段。
 *
 * 使用方法：
 * - createSpeakPlan 在生成 safetyPolicy 时调用。
 *
 * 作用：
 * - 避免空策略对象关闭默认脱敏、草稿标签和外部承诺保护。
 * - 只有调用方显式传 true 或 false 时才覆盖默认策略。
 *
 * @param policy 需要与默认策略合并或用于安全判断的策略配置。
 */
function mergeSafetyPolicy(policy: Partial<SpeakSafetyPolicy> | undefined): SpeakSafetyPolicy {
  const merged = defaultSafetyPolicy();
  if (!policy) return merged;
  if (typeof policy.redactSecrets === "boolean") merged.redactSecrets = policy.redactSecrets;
  if (typeof policy.redactPrivateData === "boolean") merged.redactPrivateData = policy.redactPrivateData;
  if (typeof policy.avoidExternalCommitment === "boolean") merged.avoidExternalCommitment = policy.avoidExternalCommitment;
  if (typeof policy.avoidFalseExecutionClaim === "boolean") {
    merged.avoidFalseExecutionClaim = policy.avoidFalseExecutionClaim;
  }
  if (typeof policy.requireDraftLabel === "boolean") merged.requireDraftLabel = policy.requireDraftLabel;
  return merged;
}

/**
 * 根据 locale 推断表达语言。
 *
 * 使用方法：
 * - createSpeakPlan 在 language 未显式传入时调用。
 *
 * 作用：
 * - 保持当前项目默认中文表达，同时允许英文和混合输出。
 *
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function languageFromLocale(locale: string | undefined): SpeakPlan["language"] {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("en")) return "en";
  if (value.startsWith("zh")) return "zh-CN";
  return "zh-CN";
}

/**
 * 为表达模式生成默认目标。
 *
 * 使用方法：
 * - createSpeakPlan 在 goal 缺失时调用。
 *
 * 作用：
 * - 让审计记录即使在简短 API 调用下也有可读目标。
 *
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 * @param language 输出内容使用的语言，用于选择本地化文案。
 */
function defaultGoalForMode(mode: SpeakMode, language: SpeakPlan["language"]): string {
  const zh = language === "zh-CN";
  const map: Record<SpeakMode, string> = {
    answer: zh ? "回答用户问题。" : "Answer the user's question.",
    explain: zh ? "解释当前主题。" : "Explain the current topic.",
    ask: zh ? "提出澄清问题。" : "Ask a clarifying question.",
    status: zh ? "汇报当前状态。" : "Report current status.",
    plan: zh ? "表达下一步计划。" : "Present the next plan.",
    report: zh ? "汇报真实结果。" : "Report verified results.",
    warn: zh ? "说明风险或限制。" : "Explain risks or limits.",
    draft: zh ? "生成草稿。" : "Create a draft.",
    summarize: zh ? "总结上下文。" : "Summarize context.",
    structured: zh ? "生成结构化输出。" : "Produce structured output.",
    acknowledge: zh ? "确认已经听到用户信号。" : "Acknowledge the user's signal.",
    decline: zh ? "说明不能执行或不能表达的原因。" : "Decline with a reason."
  };
  return map[mode];
}

/**
 * 为表达模式生成默认原因。
 *
 * 使用方法：
 * - createSpeakPlan 在 reason 缺失时调用。
 *
 * 作用：
 * - 给 SpeakPlan 补上为什么需要表达，方便审计。
 *
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 * @param language 输出内容使用的语言，用于选择本地化文案。
 */
function defaultReasonForMode(mode: SpeakMode, language: SpeakPlan["language"]): string {
  return language === "zh-CN"
    ? `Agent Core 需要通过嘴巴进行 ${mode} 类型表达。`
    : `Agent Core needs a ${mode} expression through Speak Capability.`;
}

/**
 * 根据受众、Channel 和模式选择默认身份。
 *
 * 使用方法：
 * - createSpeakPlan 在 identity 缺失时调用。
 *
 * 作用：
 * - 保证外部消息默认只是草稿身份，工具结果默认是 tool_report。
 *
 * @param audience 表达内容的目标受众，用于决定身份、隐私和投递边界。
 * @param channel 表达内容所在或计划投递到的渠道。
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 */
function defaultIdentity(audience: SpeakAudience, channel: SpeakChannel, mode: SpeakMode): SpeakIdentity {
  if (mode === "report") return "tool_report";
  if (mode === "draft" || isExternalAudience(audience) || channel.endsWith("_draft")) {
    return isExternalAudience(audience) ? "external_message_draft" : "user_draft";
  }
  if (mode === "status" || mode === "warn") return "system_status";
  return "assistant";
}

/**
 * 根据表达模式和受众选择默认语气。
 *
 * 使用方法：
 * - createSpeakPlan 在 tone 缺失时调用。
 *
 * 作用：
 * - 让状态汇报更简洁，教学解释更友好，外部草稿更正式。
 *
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 * @param audience 表达内容的目标受众，用于决定身份、隐私和投递边界。
 */
function defaultToneForMode(mode: SpeakMode, audience: SpeakAudience): SpeakTone {
  if (isExternalAudience(audience) || audience === "public") return "formal";
  if (mode === "status" || mode === "report") return "concise";
  if (mode === "explain") return "teaching";
  if (mode === "warn" || mode === "decline") return "direct";
  return "friendly";
}

/**
 * 根据表达模式选择默认详细程度。
 *
 * 使用方法：
 * - createSpeakPlan 在 detailLevel 缺失时调用。
 *
 * 作用：
 * - 设计解释默认更详细，状态确认默认更简短。
 *
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 */
function defaultDetailLevel(mode: SpeakMode): SpeakPlan["detailLevel"] {
  if (mode === "explain" || mode === "plan" || mode === "structured") return "detailed";
  if (mode === "status" || mode === "acknowledge") return "brief";
  return "normal";
}

/**
 * 判断某个受众是否属于外部对象。
 *
 * 使用方法：
 * - 草稿标记、审批判断和隐私过滤都会调用。
 *
 * 作用：
 * - 把本地用户表达和外部沟通候选区分开。
 *
 * @param audience 表达内容的目标受众，用于决定身份、隐私和投递边界。
 */
function isExternalAudience(audience: SpeakAudience): boolean {
  return audience === "external_person" || audience === "external_group" || audience === "public";
}

/**
 * 判断表达是否需要外部投递前确认。
 *
 * 使用方法：
 * - createSpeakPlan 在 requiresApprovalBeforeDelivery 未传入时调用。
 *
 * 作用：
 * - 嘴巴可以生成草稿，但任何外部投递候选都应等待后续发送能力确认。
 *
 * @param audience 表达内容的目标受众，用于决定身份、隐私和投递边界。
 * @param channel 表达内容所在或计划投递到的渠道。
 */
function requiresExternalDeliveryApproval(audience: SpeakAudience, channel: SpeakChannel): boolean {
  if (isExternalAudience(audience)) return true;
  return channel === "email_draft" || channel === "im_draft" || channel === "external_channel_draft";
}

/**
 * 判断当前表达是否应标记为草稿。
 *
 * 使用方法：
 * - createSpeakMessage 在 draft 未显式传入时调用。
 *
 * 作用：
 * - 外部受众、草稿 Channel 和 draft 模式都会自动贴上草稿边界。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 */
function shouldMarkDraft(plan: SpeakPlan): boolean {
  return plan.mode === "draft" || plan.channel.endsWith("_draft") || isExternalAudience(plan.audience);
}

/**
 * 规范化内容类型数组。
 *
 * 使用方法：
 * - createSpeakPlan 和 createSpeakMessage 都会调用。
 *
 * 作用：
 * - 去重、校验并在空数组时回退到 plain_text。
 *
 * @param values 需要批量归一化、去重、替换或格式化的值集合。
 */
function normalizeContentTypes(values: SpeakContentType[]): SpeakContentType[] {
  const output: SpeakContentType[] = [];
  for (const value of values) {
    const type = coerceSpeakContentType(value);
    if (!output.includes(type)) output.push(type);
  }
  return output.length ? output : ["plain_text"];
}

/**
 * 从文本内容推断内容类型。
 *
 * 使用方法：
 * - createSpeakMessage 在计划没有明确 contentTypes 时调用。
 *
 * 作用：
 * - 给 JSON、YAML、代码块、表格、清单和草稿输出自动打标签。
 *
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 * @param mode 当前表达或处理模式，用于选择目标、语气或格式。
 */
function inferContentTypes(content: string, mode: SpeakMode): SpeakContentType[] {
  const types = new Set<SpeakContentType>();
  const trimmed = content.trim();
  if (!trimmed) types.add("plain_text");
  if (/^(\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed)) types.add("json");
  if (/^---\n|^[A-Za-z0-9_-]+:\s/m.test(trimmed)) types.add("yaml");
  if (/```/.test(content)) types.add("code");
  if (/^\s*\|.+\|\s*$/m.test(content)) types.add("table");
  if (/^\s*[-*]\s+\[[ x]\]/m.test(content)) types.add("checklist");
  if (/^diff --git /m.test(content) || /^\s*[+-][^+-]/m.test(content)) types.add("diff_summary");
  if (mode === "draft") types.add("draft_message");
  if (/[?？]\s*$/.test(trimmed) || mode === "ask") types.add("question");
  if (!types.size) types.add(content.includes("\n") ? "markdown" : "plain_text");
  return [...types];
}

/**
 * 根据内容类型选择输出格式。
 *
 * 使用方法：
 * - createSpeakMessage 在 format 缺失时调用。
 *
 * 作用：
 * - 让机器输出保持 JSON/YAML，普通聊天默认使用 Markdown。
 *
 * @param types 需要选择格式或进行归一化的内容类型集合。
 */
function formatForContentTypes(types: SpeakContentType[]): SpeakMessage["format"] {
  if (types.includes("json")) return "json";
  if (types.includes("yaml")) return "yaml";
  if (types.some((type) => type !== "plain_text")) return "markdown";
  return "text";
}

/**
 * 对表达内容应用安全过滤。
 *
 * 使用方法：
 * - createSpeakMessage 在生成最终 content 前调用。
 *
 * 作用：
 * - 默认去除密钥、token、私钥等明显敏感内容。
 * - 外部受众还会弱化邮箱、手机号和本地路径等私密信息。
 *
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 */
function applySpeakSafetyFilters(content: string, plan: SpeakPlan): string {
  let output = content;
  if (plan.safetyPolicy.redactSecrets) {
    output = maskSecrets(output);
  }
  if (plan.safetyPolicy.redactPrivateData && isExternalAudience(plan.audience)) {
    output = maskPrivateDataForExternalAudience(output);
  }
  return output.trim();
}

/**
 * 为草稿输出补充明确标签。
 *
 * 使用方法：
 * - createSpeakMessage 发现 draft=true 且 requireDraftLabel=true 时调用。
 *
 * 作用：
 * - 防止用户或后续 Channel 把草稿误认为已经发送或已经发布。
 *
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 * @param language 输出内容使用的语言，用于选择本地化文案。
 */
function ensureDraftLabel(content: string, language: SpeakPlan["language"]): string {
  if (/尚未发送|draft only,\s*not sent|not sent/i.test(content.slice(0, 160))) return content;
  const label = language === "zh-CN" ? "下面是草稿，尚未发送：" : "Draft only, not sent:";
  return `${label}\n\n${content}`;
}

/**
 * 检测表达输出的风险标记。
 *
 * 使用方法：
 * - createSpeakMessage 在过滤内容后调用。
 *
 * 作用：
 * - 标记外部受众、草稿、推断、不确定性、工具结果、敏感泄露风险等。
 * - 风险标记不阻止输出，但会进入审计和后续 UI。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param rawContent 尚未经过表达安全过滤的原始正文。
 * @param finalContent 经过安全过滤后准备形成表达消息的最终正文。
 * @param context 生成结果时使用的补充上下文和已发生事实。
 */
function detectSpeakRiskFlags(
  plan: SpeakPlan,
  rawContent: string,
  finalContent: string,
  context: {
    sourceRefs: SpeakSourceRef[];
    assumptions: string[];
    uncertaintyFlags: string[];
    draft: boolean;
    initialRiskFlags: string[];
  }
): string[] {
  const flags = new Set(context.initialRiskFlags);
  if (secretLikePatterns.some((pattern) => pattern.test(rawContent))) flags.add("may_expose_secret");
  if (containsPrivateData(rawContent)) flags.add("may_expose_private_data");
  if (isExternalAudience(plan.audience)) flags.add("external_audience");
  if (plan.audience === "public") flags.add("public_audience");
  if (context.draft) flags.add("draft_may_be_sent");
  if (context.assumptions.length || context.sourceRefs.some((ref) => ref.kind === "inference")) flags.add("contains_inference");
  if (context.uncertaintyFlags.length || /不确定|推断|可能|assume|uncertain|might/i.test(finalContent)) {
    flags.add("contains_unverified_claim");
  }
  if (context.sourceRefs.some((ref) => ref.kind === "tool_result") || /工具结果|typecheck|build|npm run|测试|test/i.test(finalContent)) {
    flags.add("mentions_tool_result");
  }
  if (plan.requiresApprovalBeforeDelivery) flags.add("requires_user_confirmation");
  if ((isExternalAudience(plan.audience) || plan.channel.endsWith("_draft")) && plan.identity === "assistant") {
    flags.add("ambiguous_identity");
  }
  if (plan.safetyPolicy.avoidFalseExecutionClaim && hasExecutionClaim(finalContent) && !hasExecutionSource(context.sourceRefs)) {
    flags.add("contains_action_plan");
  }
  if (plan.safetyPolicy.avoidExternalCommitment && isExternalAudience(plan.audience) && hasExternalCommitment(finalContent)) {
    flags.add("requires_user_confirmation");
  }
  if (isHighImpactAdvice(finalContent)) flags.add("high_impact_advice");
  return [...flags].sort();
}

/**
 * 将来源引用规范化并去重。
 *
 * 使用方法：
 * - createSpeakMessage 处理 input.sourceRefs 时调用。
 *
 * 作用：
 * - 保证同一个来源不会重复进入 SpeakMessage。
 *
 * @param sourceRefs 支撑表达内容的来源引用列表。
 */
function normalizeSourceRefs(sourceRefs: SpeakSourceRef[]): SpeakSourceRef[] {
  const output: SpeakSourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of sourceRefs.map((item) => coerceSpeakSourceRef(item))) {
    const key = `${ref.kind}:${ref.id || ""}:${ref.label}:${ref.uri || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(ref);
  }
  return output;
}

/**
 * 清理字符串数组。
 *
 * 使用方法：
 * - assumptions、uncertaintyFlags 和 riskFlags 进入 SpeakMessage 前调用。
 *
 * 作用：
 * - 去掉空字符串、重复项和非必要空白。
 *
 * @param values 需要批量归一化、去重、替换或格式化的值集合。
 */
function cleanStringArray(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const clean = cleanString(value);
    if (clean && !output.includes(clean)) output.push(clean);
  }
  return output;
}

/**
 * 清理可选字符串。
 *
 * 使用方法：
 * - 构造计划、消息和结果时处理 title、reason、blockedReason 等字段。
 *
 * 作用：
 * - 避免空字符串污染结构化记录。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 生成某个表达模式的兜底内容。
 *
 * 使用方法：
 * - createSpeakMessage 收到空 content 时调用。
 *
 * 作用：
 * - 避免 SpeakMessage 出现空内容，同时明确当前表达还缺少信息。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 */
function fallbackContentForMode(plan: SpeakPlan): string {
  if (plan.language === "zh-CN") {
    if (plan.mode === "ask") return "我需要再确认一个关键信息。";
    if (plan.mode === "warn") return "这里存在需要注意的风险。";
    if (plan.mode === "decline") return "这件事我不能直接执行。";
    return "我已经收到，并会按当前上下文处理。";
  }
  if (plan.mode === "ask") return "I need to confirm one key detail.";
  if (plan.mode === "warn") return "There is a risk to note here.";
  if (plan.mode === "decline") return "I cannot perform that directly.";
  return "I have received this and will handle it with the current context.";
}

/**
 * 对明显密钥做脱敏。
 *
 * 使用方法：
 * - applySpeakSafetyFilters 在 redactSecrets=true 时调用。
 *
 * 作用：
 * - 避免嘴巴把 API key、token、私钥等内容输出到用户或外部草稿中。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function maskSecrets(text: string): string {
  return text
    .replace(
      /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[private key redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[openai key redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[github token redacted]");
}

/**
 * 面向外部受众时弱化个人信息。
 *
 * 使用方法：
 * - applySpeakSafetyFilters 在外部受众且 redactPrivateData=true 时调用。
 *
 * 作用：
 * - 避免草稿默认包含本地绝对路径、邮箱、手机号等私密信息。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function maskPrivateDataForExternalAudience(text: string): string {
  return text
    .replace(/[A-Z]:\\[^\s`'"]+/g, "[local path redacted]")
    .replace(/\/Users\/[^\s`'"]+/g, "[local path redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(/\b(?:\+?\d[\d -]{7,}\d)\b/g, "[phone redacted]");
}

/**
 * 判断文本是否包含私人数据形态。
 *
 * 使用方法：
 * - detectSpeakRiskFlags 为 may_expose_private_data 打标时调用。
 *
 * 作用：
 * - 即使最终内容被脱敏，审计里仍能看到这次表达曾经碰到隐私风险。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function containsPrivateData(text: string): boolean {
  return (
    /[A-Z]:\\[^\s`'"]+/.test(text) ||
    /\/Users\/[^\s`'"]+/.test(text) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text) ||
    /\b(?:\+?\d[\d -]{7,}\d)\b/.test(text)
  );
}

/**
 * 判断内容是否声称已经执行动作。
 *
 * 使用方法：
 * - detectSpeakRiskFlags 在 avoidFalseExecutionClaim=true 时调用。
 *
 * 作用：
 * - 没有工具结果来源时，把“已运行/已提交/已发送”等表达标记为需谨慎。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function hasExecutionClaim(text: string): boolean {
  return /已运行|已经运行|运行了|已执行|已经执行|已提交|已经提交|已推送|已经推送|已发送|已经发送|\b(?:passed|completed|committed|pushed)\b|\b(?:I|we|it|message|email|draft)\s+(?:have\s+|has\s+|was\s+)?sent\b/i.test(text);
}

/**
 * 判断来源引用里是否有执行结果依据。
 *
 * 使用方法：
 * - detectSpeakRiskFlags 检测执行声称时调用。
 *
 * 作用：
 * - 有 tool_result 或 system_status 来源时，执行类汇报可信度更高。
 *
 * @param sourceRefs 支撑表达内容的来源引用列表。
 */
function hasExecutionSource(sourceRefs: SpeakSourceRef[]): boolean {
  return sourceRefs.some((ref) => ref.kind === "tool_result" || ref.kind === "system_status");
}

/**
 * 判断内容是否像外部承诺。
 *
 * 使用方法：
 * - detectSpeakRiskFlags 面向外部受众时调用。
 *
 * 作用：
 * - 将承诺、同意、付款、购买、签署等高影响表达标记为需要用户确认。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function hasExternalCommitment(text: string): boolean {
  return /我承诺|我们承诺|同意|确认购买|付款|支付|签署|接受条款|commit to|we agree|I agree|payment|purchase|sign/i.test(text);
}

/**
 * 判断内容是否属于高影响建议。
 *
 * 使用方法：
 * - detectSpeakRiskFlags 为 high_impact_advice 打标时调用。
 *
 * 作用：
 * - 医疗、法律、金融等建议后续可触发更严格的表达策略。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function isHighImpactAdvice(text: string): boolean {
  return /医疗|诊断|用药|法律|合同|诉讼|投资|股票|贷款|保险|税务|medical|legal|investment|loan|tax/i.test(text);
}

/**
 * 判断 unknown 是否是普通 JSON 对象。
 *
 * 使用方法：
 * - coerceSpeakSourceRef 解析 API 输入时调用。
 *
 * 作用：
 * - 缩小 TypeScript 类型，避免直接访问 unknown 字段。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
