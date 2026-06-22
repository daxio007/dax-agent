import { newId, nowIso } from "./ids.js";
import { createReadSource } from "./read.js";
import { recordListenAnalysis } from "./store.js";
import type {
  JsonObject,
  ListenConstraint,
  ListenContextNeed,
  ListenCorrection,
  ListenEvent,
  ListenEventKind,
  ListenIntent,
  ListenMemoryCandidate,
  ListenNextStep,
  ListenPrivacyLevel,
  ListenReference,
  ListenResult,
  ListenStateChange,
  ListenTrust,
  Message,
  ReadSource,
  ReadSourceKind,
  SpeechAct
} from "./types.js";

const MAX_STORED_TEXT_CHARS = 2000;

const listenEventKinds = new Set<ListenEventKind>([
  "user_text",
  "user_voice_transcript",
  "ui_control",
  "channel_message",
  "mcp_notification",
  "tool_result",
  "app_state",
  "timer",
  "system_event"
]);

const intentPriority: ListenIntent[] = [
  "stop",
  "pause",
  "continue",
  "correct",
  "approve",
  "reject",
  "commit",
  "push",
  "implement",
  "review",
  "design",
  "read",
  "inspect",
  "configure",
  "status",
  "explain",
  "ask",
  "remember",
  "forget",
  "chat",
  "unknown"
];

const secretLikePatterns = [
  /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/i,
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/
];

export interface CreateListenEventInput {
  kind?: ListenEventKind;
  channelId?: string;
  sessionId?: string;
  userId?: string;
  locale?: string;
  rawText?: string;
  payload?: JsonObject;
  sourceLabel?: string;
  privacyLevel?: ListenPrivacyLevel;
  trust?: ListenTrust;
  capturedAt?: string;
}

export interface ListenAnalysisOutput {
  event: ListenEvent;
  result: ListenResult;
  readSources: ReadSource[];
}

/**
 * 创建一个统一的听力输入事件。
 *
 * 使用方法：
 * - 用户文本进入 Agent 前调用 createListenEvent({ rawText, sessionId })。
 * - UI、MCP、工具结果等非文本事件也可以通过 payload 进入。
 * - 不传 kind 时默认当作 user_text。
 *
 * 作用：
 * - 把不同入口的输入统一成 ListenEvent。
 * - 在存储前对 rawText 做基础脱敏和长度限制。
 *
 * @param input 创建 ListenEvent 所需的结构化输入。
 */
export function createListenEvent(input: CreateListenEventInput): ListenEvent {
  const kind = coerceListenEventKind(input.kind || "user_text");
  const rawText = input.rawText === undefined ? undefined : sanitizeListenText(input.rawText);
  return {
    id: newId("lev"),
    kind,
    channelId: input.channelId || "local",
    sessionId: input.sessionId,
    userId: input.userId,
    locale: input.locale,
    rawText,
    payload: input.payload,
    sourceLabel: input.sourceLabel || defaultSourceLabel(kind),
    privacyLevel: input.privacyLevel || inferPrivacyLevel(rawText || payloadToText(input.payload)),
    trust: input.trust || defaultTrust(kind),
    capturedAt: input.capturedAt || nowIso()
  };
}

/**
 * 分析一个 ListenEvent 并生成结构化听力结果。
 *
 * 使用方法：
 * - 先调用 createListenEvent，再把事件交给 analyzeListenEvent。
 * - recentMessages 可选，用来帮助解析“刚才那个”“下一步”等指代。
 *
 * 作用：
 * - 将输入事件转成 intent、speechActs、constraints、corrections 和 contextNeeds。
 * - 这是 Agent Core 之前的第一层理解，不会执行任何动作。
 *
 * @param event 当前要分析、持久化或响应的事件对象。
 * @param recentMessages 当前会话最近的消息，用于解析指代和建立短期上下文。
 */
export function analyzeListenEvent(event: ListenEvent, recentMessages: Message[] = []): ListenResult {
  const text = normalizeText(event.rawText || payloadToText(event.payload));
  const riskFlags = detectListenRiskFlags(event, text);
  if (isNoiseEvent(event, text)) {
    return createListenResult(event, {
      primaryIntent: "unknown",
      intents: ["unknown"],
      speechActs: [],
      references: [],
      constraints: [],
      corrections: [],
      stateChanges: [],
      contextNeeds: [{ kind: "none", reason: "Input is empty, duplicated, or not relevant.", required: false }],
      memoryCandidates: [],
      riskFlags: [...riskFlags, "background_event"],
      confidence: 0.35,
      nextStep: "ignore_noise"
    });
  }

  const intents = classifyIntents(text, event);
  const primaryIntent = choosePrimaryIntent(intents);
  const speechActs = extractSpeechActs(text, primaryIntent);
  const constraints = detectConstraints(text);
  const corrections = detectCorrections(text);
  const stateChanges = detectStateChanges(text, primaryIntent, constraints);
  const references = resolveReferences(text, recentMessages);
  const contextNeeds = detectContextNeeds(text, primaryIntent, references);
  const memoryCandidates = detectMemoryCandidates(text, constraints, corrections, primaryIntent);
  const nextStep = chooseNextStep(primaryIntent, contextNeeds, corrections, stateChanges, memoryCandidates);
  const confidence = calculateConfidence(event, text, references, corrections, constraints, riskFlags);

  return createListenResult(event, {
    primaryIntent,
    intents,
    speechActs,
    target: inferTarget(text, references),
    references,
    constraints,
    corrections,
    stateChanges,
    contextNeeds,
    memoryCandidates,
    riskFlags,
    confidence,
    nextStep
  });
}

/**
 * 创建、分析并记录一次听力事件。
 *
 * 使用方法：
 * - API 层和 Agent 消息入口优先调用这个方法。
 * - input 是原始输入，recentMessages 用于辅助上下文指代解析。
 *
 * 作用：
 * - 一次性完成 ListenEvent、ListenResult、审计记录和 ReadSource 建议。
 * - 保证正式入口都会留下可复盘的听力轨迹。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param recentMessages 当前会话最近的消息，用于解析指代和建立短期上下文。
 */
export async function analyzeAndRecordListenEvent(
  input: CreateListenEventInput,
  recentMessages: Message[] = []
): Promise<ListenAnalysisOutput> {
  const event = createListenEvent(input);
  const result = analyzeListenEvent(event, recentMessages);
  await recordListenAnalysis(event, result);
  return {
    event,
    result,
    readSources: suggestReadSourcesFromListenResult(result)
  };
}

/**
 * 分析并记录一条用户文本消息。
 *
 * 使用方法：
 * - processUserMessage 收到用户输入后直接调用。
 * - 传入 sessionId、locale 和 recentMessages 可以提升结果可追踪性。
 *
 * 作用：
 * - 为最常见的 WebChat 用户输入提供简洁入口。
 * - 默认 channelId 为 webchat，sourceLabel 为 WebChat。
 *
 * @param rawText 模型或用户提供、尚未解析和清洗的原始文本。
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 * @param recentMessages 当前会话最近的消息，用于解析指代和建立短期上下文。
 */
export async function analyzeAndRecordUserText(
  rawText: string,
  options: Omit<CreateListenEventInput, "kind" | "rawText"> = {},
  recentMessages: Message[] = []
): Promise<ListenAnalysisOutput> {
  return analyzeAndRecordListenEvent(
    {
      ...options,
      kind: "user_text",
      rawText,
      channelId: options.channelId || "webchat",
      sourceLabel: options.sourceLabel || "WebChat"
    },
    recentMessages
  );
}

/**
 * 根据听力结果建议需要读取的来源。
 *
 * 使用方法：
 * - Agent Core 发现 result.nextStep 为 read_then_answer 时调用。
 * - 返回的 ReadSource 可直接用于 createReadPlan。
 *
 * 作用：
 * - 把耳朵判断出的 ContextNeed 映射成眼睛可以执行的 ReadSource。
 * - 让“先听，再读”的流程有明确连接点。
 *
 * @param result 当前要格式化、返回、审计或持久化的能力结果。
 */
export function suggestReadSourcesFromListenResult(result: ListenResult): ReadSource[] {
  const sources: ReadSource[] = [];
  for (const need of result.contextNeeds) {
    const kind = readKindForContextNeed(need.kind);
    if (!kind) continue;
    sources.push(
      createReadSource(
        kind,
        need.suggestedTarget || defaultReadTargetForNeed(need.kind),
        need.reason,
        need.required
      )
    );
  }
  return dedupeBy(sources, (source) => `${source.kind}:${source.target}:${source.purpose}`);
}

/**
 * 将不可信的事件类型收敛成 ListenEventKind。
 *
 * 使用方法：
 * - createListenEvent 处理外部输入时调用。
 *
 * 作用：
 * - 拒绝未定义的事件类型，避免输入层制造未知分支。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function coerceListenEventKind(kind: string): ListenEventKind {
  if (!listenEventKinds.has(kind as ListenEventKind)) {
    throw new Error(`Unsupported listen event kind: ${kind}`);
  }
  return kind as ListenEventKind;
}

/**
 * 为事件类型提供默认来源标签。
 *
 * 使用方法：
 * - createListenEvent 在 sourceLabel 缺失时调用。
 *
 * 作用：
 * - 让审计记录能显示事件来自 WebChat、UI、MCP 还是系统。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function defaultSourceLabel(kind: ListenEventKind): string {
  const labels: Record<ListenEventKind, string> = {
    user_text: "User text",
    user_voice_transcript: "Voice transcript",
    ui_control: "UI control",
    channel_message: "Channel message",
    mcp_notification: "MCP notification",
    tool_result: "Tool result",
    app_state: "Application state",
    timer: "Timer",
    system_event: "System event"
  };
  return labels[kind];
}

/**
 * 为事件类型提供默认可信度。
 *
 * 使用方法：
 * - createListenEvent 在 trust 缺失时调用。
 *
 * 作用：
 * - 用户主动输入默认可信度较高，外部通知和背景事件默认较低。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function defaultTrust(kind: ListenEventKind): ListenTrust {
  if (kind === "user_text" || kind === "ui_control") return "high";
  if (kind === "channel_message" || kind === "tool_result" || kind === "user_voice_transcript") return "medium";
  return "low";
}

/**
 * 把 payload 转成可分析的短文本。
 *
 * 使用方法：
 * - 非文本事件没有 rawText 时调用。
 *
 * 作用：
 * - 让工具结果、MCP 通知和系统事件也能走同一套规则分析。
 *
 * @param payload 需要返回、分析或写入的结构化载荷。
 */
function payloadToText(payload: JsonObject | undefined): string {
  if (!payload) return "";
  return JSON.stringify(payload);
}

/**
 * 对听到的文本做基础脱敏和截断。
 *
 * 使用方法：
 * - createListenEvent 存储 rawText 前调用。
 *
 * 作用：
 * - 避免把明显的 key、token、password 明文写进 listenEvents。
 * - 限制事件文本体积，长期保存只保留必要摘要。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function sanitizeListenText(text: string): string {
  const masked = text
    .replace(
      /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[private key redacted]");
  if (masked.length <= MAX_STORED_TEXT_CHARS) return masked;
  return `${masked.slice(0, MAX_STORED_TEXT_CHARS)}\n[...listen text truncated...]`;
}

/**
 * 推断听到内容的隐私等级。
 *
 * 使用方法：
 * - createListenEvent 在 privacyLevel 缺失时调用。
 *
 * 作用：
 * - 给后续记录、记忆沉淀和 UI 展示提供隐私提示。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function inferPrivacyLevel(text: string): ListenPrivacyLevel {
  if (!text.trim()) return "public";
  if (secretLikePatterns.some((pattern) => pattern.test(text))) return "sensitive";
  if (/私密|隐私|密码|凭证|token|secret|cookie|聊天记录|邮件|日历|联系人/i.test(text)) return "sensitive";
  if (/我的|我希望|我不想|个人|本机|电脑|项目/i.test(text)) return "personal";
  return "public";
}

/**
 * 规范化文本，方便规则匹配。
 *
 * 使用方法：
 * - analyzeListenEvent 的第一步调用。
 *
 * 作用：
 * - 合并空白字符并去掉首尾空格。
 * - 保留原始语言，不做翻译。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 判断事件是否可以忽略。
 *
 * 使用方法：
 * - analyzeListenEvent 在分类前调用。
 *
 * 作用：
 * - 过滤空输入、明显无内容的背景事件和低可信空事件。
 *
 * @param event 当前要分析、持久化或响应的事件对象。
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function isNoiseEvent(event: ListenEvent, text: string): boolean {
  if (!text.trim() && !event.payload) return true;
  if (event.trust === "low" && text.trim().length < 2) return true;
  return false;
}

/**
 * 识别听到内容中的风险标记。
 *
 * 使用方法：
 * - analyzeListenEvent 为 ListenResult 生成 riskFlags 时调用。
 *
 * 作用：
 * - 标记敏感文本、外部通道、背景事件、状态变化等风险。
 *
 * @param event 当前要分析、持久化或响应的事件对象。
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function detectListenRiskFlags(event: ListenEvent, text: string): string[] {
  const flags = new Set<string>();
  if (secretLikePatterns.some((pattern) => pattern.test(text))) flags.add("contains_secret_like_text");
  if (event.privacyLevel === "personal") flags.add("private_user_data");
  if (event.privacyLevel === "sensitive") flags.add("private_user_data");
  if (event.privacyLevel === "sensitive") flags.add("sensitive_instruction");
  if (event.kind === "channel_message" || event.kind === "mcp_notification") flags.add("external_channel");
  if (event.kind === "app_state" || event.kind === "timer" || event.kind === "system_event") flags.add("background_event");
  if (/暂停|继续|停止|stop|pause|continue|resume/i.test(text)) flags.add("state_change");
  if (/记住|以后|项目|决定|不要|只讨论|不使用|不用|偏好/i.test(text)) flags.add("memory_candidate");
  if (/这个|那个|刚才|下一步|上一步|按这个|this|that|next/i.test(text)) flags.add("ambiguous_reference");
  return [...flags].sort();
}

/**
 * 分类可能的意图。
 *
 * 使用方法：
 * - analyzeListenEvent 在文本规范化后调用。
 *
 * 作用：
 * - 用第一阶段规则识别 pause、continue、implement、ask、design 等基础意图。
 * - 返回多个候选意图，后续再按优先级选 primaryIntent。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param event 当前要分析、持久化或响应的事件对象。
 */
function classifyIntents(text: string, event: ListenEvent): ListenIntent[] {
  const intents = new Set<ListenIntent>();
  const lower = text.toLowerCase();
  const forbidsCodeWriting = /不要写代码|先不写代码|不写代码|别写代码/i.test(text);
  if (/^(停|停止|别继续|不用了|算了)\b|停止|结束这个|stop|cancel/.test(lower)) intents.add("stop");
  if (/先暂停|暂停|等一下|停一下|pause|hold on/.test(lower)) intents.add("pause");
  if (/^继续(?:$|[，,。.！!\s]|但是|但)|继续吧|接着|下一步|continue|resume/.test(lower)) intents.add("continue");
  if (/不对|不是|我没有|应该是|纠正|更正|not .* but|instead/i.test(text)) intents.add("correct");
  if (/批准|同意|可以|approve|approved/i.test(text)) intents.add("approve");
  if (/拒绝|不同意|不可以|reject|rejected/i.test(text)) intents.add("reject");
  if (/提交代码|提交一下|git commit|\bcommit\b/i.test(text)) intents.add("commit");
  if (/推送|push|github|远程仓库/i.test(text)) intents.add("push");
  if (!forbidsCodeWriting && /写代码|实现|开发|落地|把代码写出来|开始写|根据文档.*代码|implement|build/i.test(text)) intents.add("implement");
  if (/review|代码审查|评审|检查问题|找 bug|找bug/i.test(text)) intents.add("review");
  if (/设计|方案|架构|文档|规划|理念|能力|design|architecture/i.test(text)) intents.add("design");
  if (/读取|读一下|看看文件|看文档|read/i.test(text)) intents.add("read");
  if (/看看|检查|查看|inspect/i.test(text)) intents.add("inspect");
  if (/配置|设置|config|configure|provider|api key/i.test(text)) intents.add("configure");
  if (/走通了吗|状态|进度|现在怎样|status|progress|done|完成了吗/i.test(text)) intents.add("status");
  if (/解释|讲讲|说说|学习|为什么|是什么|explain|learn/i.test(text)) intents.add("explain");
  if (/[?？]|吗\b|什么|怎么|如何|能不能|有没有|你觉得|why|what|how|can you/i.test(text)) intents.add("ask");
  if (/记住|记录下来|以后都|remember/i.test(text)) intents.add("remember");
  if (/忘记|不要记|forget/i.test(text)) intents.add("forget");
  if (event.kind === "tool_result" || event.kind === "system_event" || event.kind === "timer") intents.add("status");
  if (!intents.size && text.trim()) intents.add("chat");
  if (!intents.size) intents.add("unknown");
  return sortIntents([...intents]);
}

/**
 * 按意图优先级排序。
 *
 * 使用方法：
 * - classifyIntents 返回前调用。
 *
 * 作用：
 * - 保证 stop、pause、correction 等控制信号排在普通聊天前面。
 *
 * @param intents 听能力识别出的候选意图列表。
 */
function sortIntents(intents: ListenIntent[]): ListenIntent[] {
  return intents.sort((left, right) => intentPriority.indexOf(left) - intentPriority.indexOf(right));
}

/**
 * 从候选意图中选择主意图。
 *
 * 使用方法：
 * - analyzeListenEvent 得到 intents 后调用。
 *
 * 作用：
 * - 当一句话既包含问题又包含约束时，优先保留更能控制行为的意图。
 *
 * @param intents 听能力识别出的候选意图列表。
 */
function choosePrimaryIntent(intents: ListenIntent[]): ListenIntent {
  return sortIntents(intents)[0] || "unknown";
}

/**
 * 识别话语动作。
 *
 * 使用方法：
 * - analyzeListenEvent 在 intent 分类后调用。
 *
 * 作用：
 * - 区分问题、请求、指令、纠正、约束、偏好和闲聊。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param primaryIntent 听能力为本轮输入选出的主要意图。
 */
function extractSpeechActs(text: string, primaryIntent: ListenIntent): SpeechAct[] {
  const acts = new Set<SpeechAct>();
  if (/[?？]|吗\b|什么|为什么|怎么|如何|能不能|有没有|你觉得|why|what|how/i.test(text)) acts.add("question");
  if (/请|帮我|麻烦|需要你|把|可以.*吗|can you|please/i.test(text)) acts.add("request");
  if (/开始|继续|暂停|停止|提交|实现|写|不要|必须|先|现在|请/i.test(text)) acts.add("instruction");
  if (/不要|只能|只|必须|不能|不需要|先.*再|全程|每个|默认/i.test(text)) acts.add("constraint");
  if (primaryIntent === "correct") acts.add("correction");
  if (/对|是的|没错|确认|可以|同意|yes|ok/i.test(text)) acts.add("confirmation");
  if (/不行|不要|拒绝|不是|no\b/i.test(text)) acts.add("rejection");
  if (/我希望|我想|我不想|我需要|偏好|喜欢|不喜欢/i.test(text)) acts.add("preference");
  if (primaryIntent === "status") acts.add("status_request");
  if (/讨论|聊|想想|探讨|大胆|你觉得/i.test(text)) acts.add("brainstorm");
  if (!acts.size) acts.add("casual");
  return [...acts];
}

/**
 * 提取用户给出的约束。
 *
 * 使用方法：
 * - analyzeListenEvent 在话语动作识别后调用。
 *
 * 作用：
 * - 记录“只讨论某个范围”“不要用某技术”“每个方法写 doc”等边界。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function detectConstraints(text: string): ListenConstraint[] {
  const constraints: ListenConstraint[] = [];
  addConstraintIfMatch(constraints, text, /只讨论|只设计|不要设计别的|先.*不要|当前只|先停/i, {
    kind: "scope",
    content: "Limit the current scope before expanding to other abilities.",
    duration: "session",
    strength: "hard"
  });
  addConstraintIfMatch(constraints, text, /不要写代码|先不写代码|只讨论设计/i, {
    kind: "process",
    content: "Do not implement code in the current phase.",
    duration: "session",
    strength: "hard"
  });
  addConstraintIfMatch(constraints, text, /全程.*你|我.*不会写.*代码|不写一行代码/i, {
    kind: "process",
    content: "Codex is responsible for development work in this project.",
    duration: "project",
    strength: "hard"
  });
  addConstraintIfMatch(constraints, text, /不用 python|不使用 python|不想用 python|typescript|node 20/i, {
    kind: "technology",
    content: "Use TypeScript/Node.js for this project, not Python.",
    duration: "project",
    strength: "hard"
  });
  addConstraintIfMatch(constraints, text, /中文|中文版本|用中文/i, {
    kind: "language",
    content: "Prefer Chinese for project explanation and learning documents.",
    duration: "project",
    strength: "soft"
  });
  addConstraintIfMatch(constraints, text, /详细|清晰明了|每个方法.*doc|每个方法.*解释|详细.*文档/i, {
    kind: "style",
    content: "Keep logic clear and document methods with usage and purpose.",
    duration: "session",
    strength: "hard"
  });
  addConstraintIfMatch(constraints, text, /不急|先.*设计|孩子.*不急/i, {
    kind: "pace",
    content: "Prefer careful design before rushing implementation.",
    duration: "session",
    strength: "soft"
  });
  return dedupeBy(constraints, (constraint) => `${constraint.kind}:${constraint.content}`);
}

/**
 * 在文本匹配时追加一条约束。
 *
 * 使用方法：
 * - detectConstraints 用它减少重复的 if 逻辑。
 *
 * 作用：
 * - 给约束保留 sourceText，后续审计能知道约束来自哪句话。
 *
 * @param constraints 本轮输入中识别出的约束集合。
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param pattern 用于识别、提取或匹配内容的规则表达式。
 * @param constraint 当前要应用、比较或写入的单条用户约束。
 */
function addConstraintIfMatch(
  constraints: ListenConstraint[],
  text: string,
  pattern: RegExp,
  constraint: Omit<ListenConstraint, "sourceText">
): void {
  if (!pattern.test(text)) return;
  constraints.push({ ...constraint, sourceText: truncateForSource(text) });
}

/**
 * 识别用户纠正。
 *
 * 使用方法：
 * - analyzeListenEvent 在约束提取后调用。
 *
 * 作用：
 * - 把“不是 X，是 Y”“我没有提到 X”等输入标记为对 Agent 的教学信号。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function detectCorrections(text: string): ListenCorrection[] {
  const corrections: ListenCorrection[] = [];
  const notBut = text.match(/不是\s*([^，。,；;]+)[，。,；;]?\s*(?:是|而是)\s*([^，。,；;]+)/);
  if (notBut) {
    corrections.push({
      wrong: notBut[1]?.trim(),
      correct: notBut[2]?.trim(),
      target: "terminology",
      shouldUpdateMemory: true,
      sourceText: truncateForSource(text)
    });
  }
  const notMentioned = text.match(/我没有提到\s*([^，。,；;]+)/);
  if (notMentioned) {
    corrections.push({
      wrong: notMentioned[1]?.trim(),
      target: "scope",
      shouldUpdateMemory: true,
      sourceText: truncateForSource(text)
    });
  }
  if (/不对|纠正|更正/i.test(text)) {
    corrections.push({
      target: /代码|实现|python|typescript|node/i.test(text) ? "implementation" : "assumption",
      shouldUpdateMemory: /项目|以后|当前|现在|不要|不是/i.test(text),
      sourceText: truncateForSource(text)
    });
  }
  if (/只讨论|不要设计别的|不是只有/i.test(text)) {
    corrections.push({
      target: "scope",
      shouldUpdateMemory: true,
      sourceText: truncateForSource(text)
    });
  }
  return dedupeBy(corrections, (correction) => `${correction.target}:${correction.wrong || ""}:${correction.correct || ""}:${correction.sourceText}`);
}

/**
 * 识别输入带来的状态变化。
 *
 * 使用方法：
 * - analyzeListenEvent 在纠正识别后调用。
 *
 * 作用：
 * - 把暂停、继续、停止、范围变化等控制信号显式输出给 Agent Core。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param primaryIntent 听能力为本轮输入选出的主要意图。
 * @param constraints 本轮输入中识别出的约束集合。
 */
function detectStateChanges(
  text: string,
  primaryIntent: ListenIntent,
  constraints: ListenConstraint[]
): ListenStateChange[] {
  const changes: ListenStateChange[] = [];
  if (primaryIntent === "pause") {
    changes.push({ kind: "pause", value: "Pause the current task.", appliesTo: "current_task" });
  }
  if (primaryIntent === "continue") {
    changes.push({ kind: "resume", value: "Resume the previous task.", appliesTo: "current_task" });
  }
  if (primaryIntent === "stop") {
    changes.push({ kind: "stop", value: "Stop the current task.", appliesTo: "current_task" });
  }
  if (constraints.some((constraint) => constraint.kind === "scope")) {
    changes.push({ kind: "scope_change", value: "User narrowed or changed the discussion scope.", appliesTo: "session" });
  }
  if (/优先|先|下一步/i.test(text)) {
    changes.push({ kind: "priority_change", value: "User changed the immediate priority.", appliesTo: "current_task" });
  }
  return dedupeBy(changes, (change) => `${change.kind}:${change.value}`);
}

/**
 * 解析“这个”“下一步”“刚才”等上下文指代。
 *
 * 使用方法：
 * - analyzeListenEvent 将 recentMessages 传入后调用。
 *
 * 作用：
 * - 把不完整指代标记出来，并尽可能解析到最近消息或当前项目上下文。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param recentMessages 当前会话最近的消息，用于解析指代和建立短期上下文。
 */
function resolveReferences(text: string, recentMessages: Message[]): ListenReference[] {
  const references: ListenReference[] = [];
  const recentAssistant = [...recentMessages].reverse().find((message) => message.role === "assistant");
  addReferenceIfPresent(references, text, "这个", recentAssistant ? "recent assistant message or current topic" : "current topic", 0.62, true);
  addReferenceIfPresent(references, text, "这个方案", "current design proposal", 0.78, true);
  addReferenceIfPresent(references, text, "这个项目", "current workspace project", 0.88, true);
  addReferenceIfPresent(references, text, "下一步", "next item in roadmap or current task", 0.72, true);
  addReferenceIfPresent(references, text, "刚才", "recent conversation turn", 0.7, true);
  addReferenceIfPresent(references, text, "文档", "current design documents", 0.82, true);
  addReferenceIfPresent(references, text, "代码", "current codebase", 0.78, true);
  addReferenceIfPresent(references, text, "this", "current topic", 0.55, true);
  addReferenceIfPresent(references, text, "next", "next step in current task", 0.6, true);
  return dedupeBy(references, (reference) => reference.text);
}

/**
 * 在文本包含指定词时追加指代。
 *
 * 使用方法：
 * - resolveReferences 用它保持规则声明清晰。
 *
 * 作用：
 * - 将指代词、解析目标、置信度和是否需要读取上下文放在一起。
 *
 * @param references 听能力识别出的上下文指代列表。
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param keyword 在 workspace 或文本内容中搜索的关键词。
 * @param resolvedTo 指代最终解析到的消息、文件或上下文对象标识。
 * @param confidence 当前判断的置信度数值，用于归一化或写入结果。
 * @param needsRead 该引用是否还需要通过读能力补充真实上下文。
 */
function addReferenceIfPresent(
  references: ListenReference[],
  text: string,
  keyword: string,
  resolvedTo: string,
  confidence: number,
  needsRead: boolean
): void {
  if (!text.toLowerCase().includes(keyword.toLowerCase())) return;
  references.push({ text: keyword, resolvedTo, confidence, needsRead });
}

/**
 * 判断当前输入是否需要眼睛去读上下文。
 *
 * 使用方法：
 * - analyzeListenEvent 在指代解析后调用。
 *
 * 作用：
 * - 输出 memory、workspace、document、web_page 等 ContextNeed。
 * - Agent Core 可以据此生成 ReadPlan。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param primaryIntent 听能力为本轮输入选出的主要意图。
 * @param references 听能力识别出的上下文指代列表。
 */
function detectContextNeeds(
  text: string,
  primaryIntent: ListenIntent,
  references: ListenReference[]
): ListenContextNeed[] {
  const needs: ListenContextNeed[] = [];
  const needsWorkspace = /项目|代码|实现|开发|提交|构建|build|workspace|code/i.test(text);
  const needsMemory = /继续|下一步|刚才|之前|项目记忆|路线图|文档|根据文档|按这个/i.test(text);
  if (needsMemory || primaryIntent === "continue") {
    addContextNeed(needs, "memory", "Need project memory or recent conversation context.", "docs/project-memory.md", true);
  }
  if (needsWorkspace || ["implement", "commit", "push", "review", "inspect", "read"].includes(primaryIntent)) {
    addContextNeed(needs, "workspace", "Need current workspace structure or files.", ".", true);
  }
  if (/文档|资料|pdf|word|markdown|readme/i.test(text)) {
    addContextNeed(needs, "document", "User referred to documents that may need reading.", "docs", true);
  }
  if (/网页|网站|链接|url|http|官网|web/i.test(text)) {
    addContextNeed(needs, "web_page", "User referred to a web page or online source.", extractFirstUrl(text) || "https://example.com", false);
  }
  if (/电脑配置|系统配置|node|npm|环境变量|本机|配置/i.test(text)) {
    addContextNeed(needs, "computer_config", "User referred to local computer or runtime configuration.", "system", false);
  }
  if (/mcp|resource|server/i.test(text)) {
    addContextNeed(needs, "mcp_resource", "User referred to MCP resources or servers.", "mcp://resources", false);
  }
  if (references.some((reference) => reference.needsRead) && !needs.length && primaryIntent !== "ask" && primaryIntent !== "explain") {
    addContextNeed(needs, "memory", "Reference resolution needs recent task context.", "docs/project-memory.md", true);
  }
  if (!needs.length) {
    addContextNeed(needs, "none", "No extra context is required for this input.", undefined, false);
  }
  return dedupeBy(needs, (need) => `${need.kind}:${need.suggestedTarget || ""}`);
}

/**
 * 追加一条上下文需求。
 *
 * 使用方法：
 * - detectContextNeeds 用它统一构造 ContextNeed。
 *
 * 作用：
 * - 避免在规则分支里重复写对象结构。
 *
 * @param needs 当前正在累计或判断的上下文需求集合。
 * @param kind 当前方法要解析、判断或创建的类别标识。
 * @param reason 拒绝、失败、风险判断或状态变化的原因说明。
 * @param suggestedTarget 上下文需求建议读取的文件、网页或资源目标。
 * @param required 该需求或条件是否必须满足。
 */
function addContextNeed(
  needs: ListenContextNeed[],
  kind: ListenContextNeed["kind"],
  reason: string,
  suggestedTarget: string | undefined,
  required: boolean
): void {
  needs.push({ kind, reason, suggestedTarget, required });
}

/**
 * 从文本中提取第一个 URL。
 *
 * 使用方法：
 * - detectContextNeeds 识别 web_page 时调用。
 *
 * 作用：
 * - 如果用户直接给了链接，就把它作为建议读取目标。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s)"']+/)?.[0];
}

/**
 * 识别应该进入记忆策略的候选信息。
 *
 * 使用方法：
 * - analyzeListenEvent 在上下文需求判断后调用。
 *
 * 作用：
 * - 发现项目偏好、技术约束、纠正和决策，但不直接写入长期记忆。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param constraints 本轮输入中识别出的约束集合。
 * @param corrections 用户对事实、术语或既有理解给出的纠正列表。
 * @param primaryIntent 听能力为本轮输入选出的主要意图。
 */
function detectMemoryCandidates(
  text: string,
  constraints: ListenConstraint[],
  corrections: ListenCorrection[],
  primaryIntent: ListenIntent
): ListenMemoryCandidate[] {
  const candidates: ListenMemoryCandidate[] = [];
  for (const constraint of constraints) {
    if (constraint.duration === "project" || constraint.duration === "permanent") {
      candidates.push({
        kind: constraint.kind === "technology" ? "project_constraint" : "workflow",
        content: constraint.content,
        importance: constraint.strength === "hard" ? "high" : "medium",
        suggestedStore: "project_memory"
      });
    }
  }
  for (const correction of corrections) {
    candidates.push({
      kind: correction.target === "terminology" ? "terminology" : "correction",
      content: correction.sourceText,
      importance: correction.shouldUpdateMemory ? "high" : "medium",
      suggestedStore: correction.shouldUpdateMemory ? "project_memory" : "conversation_log"
    });
  }
  if (/决定|确定|就往|按这个方案|采用|改成/i.test(text)) {
    candidates.push({
      kind: "decision",
      content: truncateForSource(text),
      importance: "medium",
      suggestedStore: "decision_log"
    });
  }
  if (primaryIntent === "remember") {
    candidates.push({
      kind: "user_preference",
      content: truncateForSource(text),
      importance: "high",
      suggestedStore: "project_memory"
    });
  }
  return dedupeBy(candidates, (candidate) => `${candidate.kind}:${candidate.content}:${candidate.suggestedStore}`);
}

/**
 * 选择听力分析后的下一步建议。
 *
 * 使用方法：
 * - analyzeListenEvent 在所有信号提取完成后调用。
 *
 * 作用：
 * - 将意图、上下文需求和状态变化压缩成 Agent Core 可以调度的 nextStep。
 *
 * @param primaryIntent 听能力为本轮输入选出的主要意图。
 * @param contextNeeds 听能力识别出的上下文需求列表。
 * @param corrections 用户对事实、术语或既有理解给出的纠正列表。
 * @param stateChanges 听能力识别出的暂停、继续、停止等状态变化。
 * @param memoryCandidates 本轮输入产生、尚待记忆策略判断的候选内容。
 */
function chooseNextStep(
  primaryIntent: ListenIntent,
  contextNeeds: ListenContextNeed[],
  corrections: ListenCorrection[],
  stateChanges: ListenStateChange[],
  memoryCandidates: ListenMemoryCandidate[]
): ListenNextStep {
  if (primaryIntent === "stop") return "pause";
  if (primaryIntent === "pause") return "pause";
  if (primaryIntent === "continue" || stateChanges.some((change) => change.kind === "resume")) return "resume";
  if (corrections.length || memoryCandidates.some((candidate) => candidate.importance === "high")) return "record_memory";
  if (contextNeeds.some((need) => need.kind !== "none" && need.required)) return "read_then_answer";
  if (primaryIntent === "implement") return "implement";
  if (primaryIntent === "design" || primaryIntent === "review" || primaryIntent === "configure") return "plan";
  if (primaryIntent === "commit" || primaryIntent === "push" || primaryIntent === "approve" || primaryIntent === "reject") return "agent_core";
  if (primaryIntent === "unknown") return "ask_clarifying_question";
  return "answer_directly";
}

/**
 * 计算本次听力判断的置信度。
 *
 * 使用方法：
 * - analyzeListenEvent 生成 ListenResult 前调用。
 *
 * 作用：
 * - 让 Agent Core 知道是否应该直接继续，还是需要澄清。
 *
 * @param event 当前要分析、持久化或响应的事件对象。
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param references 听能力识别出的上下文指代列表。
 * @param corrections 用户对事实、术语或既有理解给出的纠正列表。
 * @param constraints 本轮输入中识别出的约束集合。
 * @param riskFlags 风险检测阶段生成、用于推导最终风险等级的标记集合。
 */
function calculateConfidence(
  event: ListenEvent,
  text: string,
  references: ListenReference[],
  corrections: ListenCorrection[],
  constraints: ListenConstraint[],
  riskFlags: string[]
): number {
  let score = text.length > 0 ? 0.72 : 0.35;
  if (event.trust === "high") score += 0.08;
  if (event.trust === "low") score -= 0.15;
  if (references.some((reference) => reference.confidence < 0.65)) score -= 0.12;
  if (corrections.length) score += 0.06;
  if (constraints.length) score += 0.04;
  if (riskFlags.includes("ambiguous_reference")) score -= 0.05;
  if (riskFlags.includes("contains_secret_like_text")) score -= 0.1;
  return Math.max(0.05, Math.min(0.98, Number(score.toFixed(2))));
}

/**
 * 推断输入主要指向的目标。
 *
 * 使用方法：
 * - analyzeListenEvent 在创建 ListenResult 前调用。
 *
 * 作用：
 * - 给 UI 和 Agent Core 一个简短目标标签。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param references 听能力识别出的上下文指代列表。
 */
function inferTarget(text: string, references: ListenReference[]): string | undefined {
  const quoted = text.match(/[“"']([^”"']{2,80})[”"']/)?.[1];
  if (quoted) return quoted;
  if (references[0]?.resolvedTo) return references[0].resolvedTo;
  if (/听|耳朵/i.test(text)) return "listen capability";
  if (/读|眼睛/i.test(text)) return "read capability";
  if (/mcp/i.test(text)) return "MCP";
  if (/skill/i.test(text)) return "Skill";
  return undefined;
}

/**
 * 创建标准 ListenResult。
 *
 * 使用方法：
 * - analyzeListenEvent 的所有分支最终都调用它。
 *
 * 作用：
 * - 统一补齐 id、eventId、createdAt 和默认数组字段。
 *
 * @param event 当前要分析、持久化或响应的事件对象。
 * @param partial 用于补齐默认字段并创建完整结构的部分对象。
 */
function createListenResult(
  event: ListenEvent,
  partial: Omit<ListenResult, "id" | "eventId" | "createdAt">
): ListenResult {
  return {
    ...partial,
    id: newId("lrs"),
    eventId: event.id,
    createdAt: nowIso()
  };
}

/**
 * 将 ContextNeed 类型映射为 ReadSource 类型。
 *
 * 使用方法：
 * - suggestReadSourcesFromListenResult 构造 ReadSource 时调用。
 *
 * 作用：
 * - 明确哪些听力上下文需求能交给眼睛执行。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function readKindForContextNeed(kind: ListenContextNeed["kind"]): ReadSourceKind | null {
  const map: Partial<Record<ListenContextNeed["kind"], ReadSourceKind>> = {
    workspace: "workspace",
    memory: "memory",
    document: "document",
    web_page: "web_page",
    computer_config: "computer_config",
    app_content: "app_content",
    mcp_resource: "mcp_resource"
  };
  return map[kind] || null;
}

/**
 * 为上下文需求提供默认读取目标。
 *
 * 使用方法：
 * - suggestReadSourcesFromListenResult 在 suggestedTarget 缺失时调用。
 *
 * 作用：
 * - 让 ReadSource 始终有可执行的 target。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function defaultReadTargetForNeed(kind: ListenContextNeed["kind"]): string {
  const targets: Record<ListenContextNeed["kind"], string> = {
    workspace: ".",
    memory: "docs/project-memory.md",
    document: "docs",
    web_page: "https://example.com",
    computer_config: "system",
    app_content: "current",
    mcp_resource: "mcp://resources",
    none: ""
  };
  return targets[kind];
}

/**
 * 截断来源文本，便于放入约束、纠正和记忆候选。
 *
 * 使用方法：
 * - detectConstraints、detectCorrections、detectMemoryCandidates 调用。
 *
 * 作用：
 * - 保留用户原话的关键片段，但避免把长文本原样塞入结构化结果。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function truncateForSource(text: string): string {
  const clean = text.trim();
  return clean.length <= 180 ? clean : `${clean.slice(0, 180)}...`;
}

/**
 * 按 key 去重数组。
 *
 * 使用方法：
 * - 多个识别器可能生成重复 constraint、need 或 candidate 时调用。
 *
 * 作用：
 * - 保持 ListenResult 简洁，避免同一信号重复出现。
 *
 * @param items 需要查找、去重、更新或转换的项目集合。
 * @param keyFor 把列表项转换为稳定去重键的回调函数。
 */
function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}
