import { newId, nowIso } from "./ids.js";
import { suggestReadSourcesFromListenResult } from "./listen.js";
import { completeChat } from "./providers.js";
import { createReadPlan } from "./read.js";
import { createSpeakPlan } from "./speak.js";
import {
  recordAgentCoreFailure as persistAgentCoreFailure,
  recordAgentCoreResult as persistAgentCoreResult
} from "./store.js";
import type {
  ActionProposal,
  AgentCoreInput,
  AgentCoreResult,
  AgentDecision,
  AgentDecisionCandidate,
  AgentDecisionType,
  AgentRiskLevel,
  AppConfig,
  CapabilityRoute,
  ContextBlock,
  FootAction,
  Locale,
  MemoryDecision,
  Message,
  ModelReasoningInput,
  ModelReasoningResult,
  PolicyGateResult,
  ReadPlan,
  ReadSource,
  SkillDecision,
  SpeakMode,
  SpeakPlan,
  ToolRun,
  WorkingMemory
} from "./types.js";

const MODEL_TEXT_LIMIT = 8000;
const CONTEXT_SUMMARY_LIMIT = 6000;
const MESSAGE_SUMMARY_LIMIT = 2400;

const agentDecisionTypes = new Set<AgentDecisionType>([
  "answer_directly",
  "ask_user",
  "read_context",
  "store_memory",
  "recall_skill",
  "propose_hand_action",
  "propose_foot_action",
  "wait_for_approval",
  "pause",
  "stop"
]);

const memoryKinds = new Set<MemoryDecision["kind"]>([
  "raw",
  "episodic",
  "semantic",
  "procedural"
]);

const riskLevels = new Set<AgentRiskLevel>(["low", "medium", "high"]);

const supportedAutomaticReadKinds = new Set<ReadSource["kind"]>([
  "local_file",
  "document",
  "workspace",
  "web_page",
  "computer_config",
  "memory",
  "search",
  "runtime"
]);

const secretLikePatterns = [
  /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
];

export interface CreateAgentCoreInputOptions {
  sessionId: string;
  userMessageId: string;
  userText: string;
  locale: Locale;
  listenResult: AgentCoreInput["listenResult"];
  recentMessages?: Message[];
  contextBlocks?: ContextBlock[];
  pendingToolRuns?: ToolRun[];
  config: AppConfig;
  readAttempted?: boolean;
  readFailure?: string;
}

export interface DecideNextStepOptions {
  record?: boolean;
}

/**
 * 使用方法：由 processUserMessage() 或 /api/core/decide 在完成听力分析后调用。
 * 作用：把本轮用户文本、ListenResult、短消息历史、上下文块和待处理工具请求组装成稳定的 AgentCoreInput。
 * 边界：该方法只复制和规范化输入，不调用模型、不读取文件、不写入 store，也不执行任何能力。
 *
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 */
export function createAgentCoreInput(options: CreateAgentCoreInputOptions): AgentCoreInput {
  return {
    sessionId: options.sessionId,
    userMessageId: options.userMessageId,
    userText: String(options.userText || "").trim(),
    locale: options.locale || "zh-CN",
    listenResult: options.listenResult,
    recentMessages: [...(options.recentMessages || [])],
    contextBlocks: [...(options.contextBlocks || [])],
    pendingToolRuns: [...(options.pendingToolRuns || [])],
    config: options.config,
    readAttempted: Boolean(options.readAttempted),
    readFailure: cleanOptionalText(options.readFailure, 1000)
  };
}

/**
 * 使用方法：decideNextStep() 收到 AgentCoreInput 后首先调用。
 * 作用：创建本轮短期工作记忆，集中保存目标、约束、意图、上下文摘要、待追问事项和记忆候选。
 * 边界：WorkingMemory 只服务当前决策，不会自动写入长期记忆，也不会读取 Skill 或执行行动。
 *
 * @param input 创建 WorkingMemory 所需的结构化输入。
 */
export function createWorkingMemory(input: AgentCoreInput): WorkingMemory {
  const memoryCandidates = input.listenResult.memoryCandidates.map((candidate) =>
    createMemoryDecision(input, candidate.content, {
      shouldStore: candidate.suggestedStore !== "none" && candidate.importance !== "low",
      kind: candidate.kind === "workflow" ? "procedural" : "semantic",
      reason: `ListenResult marked this as ${candidate.kind} with ${candidate.importance} importance.`
    })
  );
  return {
    id: newId("wm"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    userGoal: cleanText(input.listenResult.target || input.userText, 600) || "Understand the current request.",
    activeConstraints: uniqueStrings(
      input.listenResult.constraints.map((constraint) => `${constraint.strength}:${constraint.kind}:${constraint.content}`)
    ),
    recentIntentLabels: uniqueStrings(input.listenResult.intents),
    contextSummary: summarizeContextBlocks(input.contextBlocks),
    contextBlockIds: input.contextBlocks.map((block) => block.id),
    pendingQuestions:
      input.listenResult.nextStep === "ask_clarifying_question"
        ? [isZh(input.locale) ? "需要向用户确认缺失信息。" : "Missing information needs user confirmation."]
        : [],
    pendingActionProposalIds: [],
    memoryCandidates
  };
}

/**
 * 使用方法：Agent Core 完成一次 ReadPlan 后，把原 WorkingMemory 和新 ContextBlock[] 传入。
 * 作用：生成包含最新上下文摘要和 source ids 的新工作记忆，供第二次决策使用。
 * 边界：该方法会做摘要和脱敏，不会保留无限长度原文，也不会修改传入的 WorkingMemory。
 *
 * @param memory 当前 Agent Core 的短期工作记忆快照。
 * @param contextBlocks 读能力生成并可加入工作记忆的结构化上下文块。
 */
export function updateWorkingMemoryWithContext(
  memory: WorkingMemory,
  contextBlocks: ContextBlock[]
): WorkingMemory {
  const contextSummary = summarizeContextBlocks(contextBlocks);
  return {
    ...memory,
    id: newId("wm"),
    createdAt: nowIso(),
    contextSummary: contextSummary || memory.contextSummary,
    contextBlockIds: uniqueStrings([...memory.contextBlockIds, ...contextBlocks.map((block) => block.id)])
  };
}

/**
 * 使用方法：decideNextStep() 在调用模型前传入当前输入和工作记忆。
 * 作用：优先处理 stop、pause 和纯 resume 等必须服从的控制信号，并在“只讨论、不写代码”约束下阻止实现型决策。
 * 边界：该方法不调用模型，不执行 read/hand/foot，也不会让模型覆盖用户已经明确给出的硬控制信号。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param _memory 当前工作记忆快照；保留在控制器签名中供规则扩展使用，当前分支不直接读取。
 */
export function applyHardControl(
  input: AgentCoreInput,
  _memory: WorkingMemory
): AgentDecision | null {
  const changes = input.listenResult.stateChanges;
  if (changes.some((change) => change.kind === "stop") || input.listenResult.primaryIntent === "stop") {
    return createDecision(input, {
      type: "stop",
      source: "rule",
      reason: "The user explicitly asked the current task to stop.",
      confidence: 1,
      userVisibleSummary: isZh(input.locale)
        ? "好的，我会停止当前任务，不再继续读取、修改或执行。"
        : "Understood. I will stop the current task and will not continue reading, modifying, or executing."
    });
  }

  if (changes.some((change) => change.kind === "pause") || input.listenResult.primaryIntent === "pause") {
    return createDecision(input, {
      type: "pause",
      source: "rule",
      reason: "The user explicitly asked the current task to pause.",
      confidence: 1,
      userVisibleSummary: isZh(input.locale)
        ? "好的，当前任务已暂停。我不会继续调用后续能力。"
        : "Understood. The current task is paused and I will not call further capabilities."
    });
  }

  const substantiveIntents = input.listenResult.intents.filter(
    (intent) => !["continue", "chat", "unknown"].includes(intent)
  );
  if (
    changes.some((change) => change.kind === "resume") &&
    substantiveIntents.length === 0
  ) {
    return createDecision(input, {
      type: "answer_directly",
      source: "rule",
      reason: "The user explicitly resumed the task without adding a new substantive request.",
      confidence: 0.98,
      userVisibleSummary: isZh(input.locale)
        ? "好的，我会继续之前的任务，并继续遵守已经记录的范围和安全约束。"
        : "Understood. I will resume the previous task while keeping the recorded scope and safety constraints."
    });
  }

  const forbidsImplementation = input.listenResult.constraints.some(
    (constraint) =>
      constraint.strength === "hard" &&
      constraint.kind === "process" &&
      /do not implement code/i.test(constraint.content)
  );
  if (forbidsImplementation && input.listenResult.intents.includes("implement")) {
    return createDecision(input, {
      type: "answer_directly",
      source: "rule",
      reason: "A hard process constraint forbids implementation in the current phase.",
      confidence: 0.99,
      userVisibleSummary: isZh(input.locale)
        ? "我会保持在讨论和设计阶段，不会写入代码或执行实现动作。"
        : "I will stay in the discussion and design phase without writing code or executing implementation actions."
    });
  }

  if (input.listenResult.primaryIntent === "status") {
    const pendingCount = input.pendingToolRuns.filter((run) =>
      ["pending", "approved", "running"].includes(run.status)
    ).length;
    return createDecision(input, {
      type: "answer_directly",
      source: "rule",
      reason: "Status can be answered deterministically from current runtime state.",
      confidence: 0.96,
      userVisibleSummary: isZh(input.locale)
        ? `当前会话有 ${pendingCount} 个待处理或运行中的工具请求。Agent Core 已收到本轮状态询问。`
        : `This session has ${pendingCount} pending or running tool requests. Agent Core received the status request.`
    });
  }

  return null;
}

/**
 * 使用方法：在 hard control 没有直接给出决策后调用。
 * 作用：根据 ListenResult.contextNeeds、是否已经读过和当前 ContextBlock 判断是否应进入一次 read round。
 * 边界：该方法只返回布尔判断，不创建计划、不读取内容；同一轮最多允许一次自动读取。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
export function shouldReadContext(input: AgentCoreInput): boolean {
  if (input.readAttempted || input.contextBlocks.length > 0) return false;
  return automaticReadSources(input).length > 0;
}

/**
 * 使用方法：当 shouldReadContext() 返回 true 时调用，并把返回的 ReadPlan 交给 executeAndRecordReadPlan()。
 * 作用：把听力层建议的 ContextNeed 收敛成受限、可审计的一次读取计划。
 * 边界：该方法不执行读取；不支持的 connector source 会被过滤；第一阶段最多保留三个来源。
 *
 * @param input 创建 ReadPlanFromDecision 所需的结构化输入。
 */
export function createReadPlanFromDecision(input: AgentCoreInput): ReadPlan | null {
  const sources = automaticReadSources(input);
  if (!sources.length) return null;
  return createReadPlan(
    {
      goal: isZh(input.locale) ? "为当前 Agent Core 决策补充必要上下文。" : "Read context required for the Agent Core decision.",
      reason: input.listenResult.contextNeeds
        .filter((need) => need.kind !== "none")
        .map((need) => need.reason)
        .join(" "),
      sources,
      maxBytes: Math.min(input.config.security.maxReadBytes || 120000, 120000),
      maxFiles: Math.min(input.config.security.maxSearchResults || 20, 20),
      allowNetwork: sources.some(
        (source) => source.kind === "web_page" && /^https?:\/\//i.test(source.target)
      ),
      expectedSignals: uniqueStrings([
        ...input.listenResult.intents,
        ...input.listenResult.constraints.map((constraint) => constraint.kind)
      ])
    },
    input.config
  );
}

/**
 * 使用方法：reasonWithModel() 调用前传入当前输入和工作记忆。
 * 作用：把复杂运行时对象压缩成模型可消费的最小摘要，并明确允许的 decision types。
 * 边界：不会传入 AppConfig、API key、完整 store 或无限长度上下文。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param memory 当前 Agent Core 的短期工作记忆快照。
 */
export function buildModelReasoningInput(
  input: AgentCoreInput,
  memory: WorkingMemory
): ModelReasoningInput {
  return {
    locale: input.locale,
    userText: cleanText(input.userText, 3000),
    listenSummary: summarizeListenResult(input),
    workingMemorySummary: cleanText(
      JSON.stringify({
        goal: memory.userGoal,
        constraints: memory.activeConstraints,
        intents: memory.recentIntentLabels,
        pendingQuestions: memory.pendingQuestions,
        pendingToolRuns: input.pendingToolRuns.map((run) => ({
          id: run.id,
          tool: run.tool,
          status: run.status
        })),
        recentMessages: summarizeRecentMessages(input.recentMessages)
      }),
      MESSAGE_SUMMARY_LIMIT
    ),
    contextSummary: cleanText(memory.contextSummary, CONTEXT_SUMMARY_LIMIT),
    readFailure: cleanOptionalText(input.readFailure, 1000),
    allowedDecisionTypes: allowedDecisionTypesForInput(input)
  };
}

/**
 * 使用方法：decideNextStep() 在需要语义推理且 provider 不是 echo 时调用。
 * 作用：使用现有 Provider 请求严格 JSON 的候选决策，并把原始文本、解析结果或解析错误包装成 ModelReasoningResult。
 * 边界：模型结果只是候选，不会直接执行；echo、请求失败和非法 JSON 都会返回 parseError，由 fallback 接管。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param memory 当前 Agent Core 的短期工作记忆快照。
 */
export async function reasonWithModel(
  input: AgentCoreInput,
  memory: WorkingMemory
): Promise<ModelReasoningResult> {
  const provider = input.config.model.provider || "echo";
  const model = input.config.model.model || "unknown";
  if (provider === "echo") {
    return {
      id: newId("mrs"),
      createdAt: nowIso(),
      rawText: "",
      parseError: "Model reasoning is unavailable in echo mode.",
      provider,
      model: "local-echo"
    };
  }

  const reasoningInput = buildModelReasoningInput(input, memory);
  try {
    const completion = await completeChat(
      input.config,
      [
        { role: "system", content: modelReasoningSystemPrompt(reasoningInput.allowedDecisionTypes) },
        { role: "user", content: JSON.stringify(reasoningInput, null, 2) }
      ],
      input.locale
    );
    try {
      const parsedDecision = parseModelDecision(completion.content);
      return {
        id: newId("mrs"),
        createdAt: nowIso(),
        rawText: sanitizeStoredText(completion.content, MODEL_TEXT_LIMIT),
        parsedDecision,
        provider: completion.provider,
        model: completion.model
      };
    } catch (error) {
      return {
        id: newId("mrs"),
        createdAt: nowIso(),
        rawText: sanitizeStoredText(completion.content, MODEL_TEXT_LIMIT),
        parseError: errorMessage(error),
        provider: completion.provider,
        model: completion.model
      };
    }
  } catch (error) {
    return {
      id: newId("mrs"),
      createdAt: nowIso(),
      rawText: "",
      parseError: errorMessage(error),
      provider,
      model
    };
  }
}

/**
 * 使用方法：reasonWithModel() 收到模型文本后调用，也可以在单元测试中直接传入 JSON 字符串验证解析。
 * 作用：提取 fenced JSON 或普通 JSON 对象，并只保留 AgentDecisionCandidate 允许的字段。
 * 边界：该方法不信任模型字段、不补全决策、不应用 Policy Gate；非法 JSON 会抛错交给 fallback。
 *
 * @param rawText 模型或用户提供、尚未解析和清洗的原始文本。
 */
export function parseModelDecision(rawText: string): AgentDecisionCandidate {
  const text = String(rawText || "").trim();
  if (!text) throw new Error("Model reasoning returned empty content.");
  const candidateText = extractDecisionJson(text);
  const parsed = JSON.parse(candidateText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Model decision must be a JSON object.");
  }

  const type = optionalDecisionType(parsed.type);
  const memoryKind = optionalMemoryKind(parsed.memoryKind);
  const actionRisk = optionalRiskLevel(parsed.actionRisk);
  return {
    type,
    reason: optionalString(parsed.reason),
    confidence: optionalNumber(parsed.confidence),
    userVisibleSummary: optionalString(parsed.userVisibleSummary),
    memoryKind,
    memoryValue: optionalString(parsed.memoryValue),
    skillQuery: optionalString(parsed.skillQuery),
    actionTitle: optionalString(parsed.actionTitle),
    actionReason: optionalString(parsed.actionReason),
    actionRisk,
    actionCommand: optionalString(parsed.actionCommand),
    actionCwd: optionalString(parsed.actionCwd),
    actionTimeoutMs: optionalNumber(parsed.actionTimeoutMs),
    actionExpectedEffect: optionalString(parsed.actionExpectedEffect)
  };
}

/**
 * 使用方法：模型 JSON 解析成功后，把候选和原始 AgentCoreInput 传入。
 * 作用：校验 decision type、置信度、用户可见内容和当前阶段边界，并补全 id、时间、read plan、memory、skill 或 action proposal。
 * 边界：该方法不会执行决策，也不会写入 store；不在白名单或违反当前硬约束的候选会抛错。
 *
 * @param candidate 模型或规则生成、尚待校验的候选结构。
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
export function validateAgentDecision(
  candidate: AgentDecisionCandidate,
  input: AgentCoreInput
): AgentDecision {
  if (!candidate.type || !agentDecisionTypes.has(candidate.type)) {
    throw new Error("Model decision type is missing or unsupported.");
  }
  if (!allowedDecisionTypesForInput(input).includes(candidate.type)) {
    throw new Error(`Model decision type ${candidate.type} is blocked by current user constraints.`);
  }
  const userVisibleSummary = cleanText(candidate.userVisibleSummary || "", MODEL_TEXT_LIMIT);
  if (!userVisibleSummary) {
    throw new Error("Model decision must include userVisibleSummary.");
  }

  let decision = createDecision(input, {
    type: candidate.type,
    source: "model",
    reason: cleanText(candidate.reason || "Model selected the next step.", 1200),
    confidence: clampConfidence(candidate.confidence),
    userVisibleSummary
  });

  if (decision.type === "read_context") {
    const readPlan = createReadPlanFromDecision(input);
    if (!readPlan) throw new Error("Model requested read_context but no supported read source is available.");
    decision = { ...decision, readPlan };
  }
  if (decision.type === "store_memory") {
    decision = {
      ...decision,
      memoryDecision: createMemoryDecision(
        input,
        candidate.memoryValue || input.userText,
        {
          shouldStore: true,
          kind: candidate.memoryKind || "semantic",
          reason: decision.reason
        }
      )
    };
  }
  if (decision.type === "recall_skill") {
    decision = {
      ...decision,
      skillDecision: createSkillDecision(input, candidate.skillQuery || input.userText)
    };
  }
  if (decision.type === "propose_hand_action" || decision.type === "propose_foot_action") {
    decision = {
      ...decision,
      actionProposal: createActionProposalFromDecision(decision, input, candidate)
    };
  }
  return decision;
}

/**
 * 使用方法：模型不可用、模型解析失败或候选校验失败时调用。
 * 作用：根据 ListenResult、是否已读取、读取失败和 provider 原始文本生成保守但可用的本地决策。
 * 边界：fallback 永远不会直接写文件、执行命令或声称行动已经完成。
 *
 * @param input 创建 FallbackDecision 所需的结构化输入。
 * @param modelReasoning 模型推理阶段的结果和失败信息，用于生成回退决策。
 */
export function createFallbackDecision(
  input: AgentCoreInput,
  modelReasoning?: ModelReasoningResult
): AgentDecision {
  const plainModelText = usablePlainModelText(modelReasoning?.rawText || "");
  if (plainModelText) {
    return createDecision(input, {
      type: "answer_directly",
      source: "fallback",
      reason: "The model returned useful plain text instead of the requested JSON decision.",
      confidence: 0.55,
      userVisibleSummary: plainModelText
    });
  }

  if (input.readFailure) {
    return createDecision(input, {
      type: "ask_user",
      source: "fallback",
      reason: `The required context read failed: ${input.readFailure}`,
      confidence: 0.82,
      userVisibleSummary: isZh(input.locale)
        ? `读取必要上下文时遇到问题：${cleanText(input.readFailure, 500)}。请确认目标是否存在，或提供更具体的文件和范围。`
        : `Reading the required context failed: ${cleanText(input.readFailure, 500)}. Please confirm the target or provide a more specific file and scope.`
    });
  }

  const intent = input.listenResult.primaryIntent;
  const noAction = forbidsRealWorldAction(input);
  if (intent === "implement") {
    if (noAction) {
      return createDecision(input, {
        type: "answer_directly",
        source: "fallback",
        reason: "The user requested implementation but also forbade real-world action.",
        confidence: 0.9,
        userVisibleSummary: isZh(input.locale)
          ? "我会整理实现方案和修改范围，但不会写入文件或执行命令。"
          : "I will outline the implementation and change scope without writing files or running commands."
      });
    }
    const decision = createDecision(input, {
      type: "propose_hand_action",
      source: "fallback",
      reason: "Implementation requires changing workspace objects, so the first-stage brain creates a hand proposal.",
      confidence: 0.88,
      userVisibleSummary: isZh(input.locale)
        ? "我已经理解实现目标。按照第一阶段安全边界，现在只生成修改建议；真正写入前仍需由手能力生成预览并经过确认。"
        : "I understand the implementation goal. Under the first-stage safety boundary I will create a modification proposal; the hand capability must still generate a preview and receive confirmation before writing."
    });
    return {
      ...decision,
      actionProposal: createActionProposalFromDecision(decision, input)
    };
  }

  if (intent === "commit" || intent === "push") {
    if (noAction) {
      return createDecision(input, {
        type: "answer_directly",
        source: "fallback",
        reason: "The user mentioned an execution action while real-world action is forbidden.",
        confidence: 0.9,
        userVisibleSummary: isZh(input.locale)
          ? "我可以说明提交或推送步骤，但不会实际运行命令。"
          : "I can explain the commit or push steps without running commands."
      });
    }
    const decision = createDecision(input, {
      type: "propose_foot_action",
      source: "fallback",
      reason: `${intent} requires a controlled execution process.`,
      confidence: 0.9,
      userVisibleSummary: isZh(input.locale)
        ? `我已生成“${intent === "push" ? "推送" : "提交"}”执行建议，但尚未运行任何命令。执行前需要脚能力预览和用户确认。`
        : `I created a ${intent} execution proposal, but no command has run. The foot capability must preview it and receive user confirmation first.`
    });
    return {
      ...decision,
      actionProposal: createActionProposalFromDecision(decision, input)
    };
  }

  if (intent === "remember") {
    const decision = createDecision(input, {
      type: "store_memory",
      source: "fallback",
      reason: "The user explicitly asked the agent to remember information.",
      confidence: 0.92,
      userVisibleSummary: isZh(input.locale)
        ? "我已把这条信息识别为记忆候选。第一阶段只记录候选，不会自动写入长期记忆文档。"
        : "I identified this as a memory candidate. The first stage records the candidate without automatically writing long-term memory documents."
    });
    return {
      ...decision,
      memoryDecision: createMemoryDecision(input, input.userText, {
        shouldStore: true,
        kind: "semantic",
        reason: decision.reason
      })
    };
  }

  if (intent === "approve" || intent === "reject") {
    return createDecision(input, {
      type: input.pendingToolRuns.length ? "wait_for_approval" : "ask_user",
      source: "fallback",
      reason: input.pendingToolRuns.length
        ? "Approval intent was detected, but the first-stage brain does not select a tool run implicitly."
        : "Approval intent was detected without a pending tool run.",
      confidence: 0.86,
      userVisibleSummary: isZh(input.locale)
        ? input.pendingToolRuns.length
          ? "我识别到了审批意图。请在工具面板中选择具体请求，避免批准错误的动作。"
          : "当前没有可审批的工具请求，请说明要确认的具体动作。"
        : input.pendingToolRuns.length
          ? "I detected approval intent. Select the exact request in the tool panel to avoid approving the wrong action."
          : "There is no pending tool request. Please identify the exact action you want to confirm."
    });
  }

  if (input.contextBlocks.length > 0) {
    const titles = input.contextBlocks.map((block) => block.title).slice(0, 5).join("、");
    return createDecision(input, {
      type: "answer_directly",
      source: "fallback",
      reason: "Required context was read, but no model decision was available.",
      confidence: 0.62,
      userVisibleSummary: isZh(input.locale)
        ? `我已经读取了相关上下文（${titles || "已读取来源"}），但当前模型不可用，无法可靠生成更深入的语义回答。结构化上下文已保留在本轮工作记忆中。`
        : `I read the relevant context (${titles || "available sources"}), but the model is unavailable, so I cannot reliably produce a deeper semantic answer. The structured context remains in working memory for this turn.`
    });
  }

  if (["unknown", "chat"].includes(intent) && !input.userText.trim()) {
    return createDecision(input, {
      type: "ask_user",
      source: "fallback",
      reason: "The request has no actionable or answerable content.",
      confidence: 0.8,
      userVisibleSummary: isZh(input.locale)
        ? "请告诉我你希望我理解、读取、设计或处理什么。"
        : "Please tell me what you want me to understand, read, design, or handle."
    });
  }

  return createDecision(input, {
    type: "answer_directly",
    source: "fallback",
    reason: "No validated model decision was available, so the brain returned a local conservative response.",
    confidence: 0.5,
    userVisibleSummary: isZh(input.locale)
      ? [
          "DAX Agent 当前无法使用模型思考器，因此本轮由 Agent Core 的本地 fallback 处理。",
          "",
          `我已识别到主要意图：${intent}。`,
          "可以在设置中配置 OpenAI-compatible 或 Ollama-compatible Provider，以获得更完整的语义推理。"
        ].join("\n")
      : [
          "DAX Agent cannot use a model reasoner right now, so this turn was handled by the Agent Core fallback.",
          "",
          `Detected primary intent: ${intent}.`,
          "Configure an OpenAI-compatible or Ollama-compatible provider for richer semantic reasoning."
        ].join("\n")
  });
}

/**
 * 使用方法：AgentDecision 完成后、CapabilityRoute 创建前调用。
 * 作用：评估决策风险、用户硬约束、审批要求和第一阶段被禁止的能力，并返回结构化策略结果。
 * 边界：Policy Gate 只判断和记录；不会替代 hand/foot 自身的 preview、approval 和安全检查。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
export function applyPolicyGate(
  decision: AgentDecision,
  input: AgentCoreInput
): PolicyGateResult {
  const reasons: string[] = [];
  const requiredApprovals: string[] = [];
  const blockedCapabilities: string[] = [];
  let allowed = true;
  let risk: AgentRiskLevel = "low";

  if (decision.type === "read_context") {
    risk = decision.readPlan?.sources.some((source) =>
      ["web_page", "computer_config", "memory", "runtime"].includes(source.kind)
    )
      ? "medium"
      : "low";
    if (!decision.readPlan || input.readAttempted) {
      allowed = false;
      reasons.push("Read was requested without a valid plan or after the single automatic read round.");
      blockedCapabilities.push("read.execute");
    } else {
      reasons.push("One bounded read round is allowed by the first-stage read policy.");
    }
  } else if (decision.type === "propose_hand_action") {
    risk = decision.actionProposal?.risk || "medium";
    reasons.push("A hand proposal may be created, but workspace changes cannot be applied by Agent Core.");
    requiredApprovals.push("user_confirmation_before_hand_apply");
    blockedCapabilities.push("hand.apply");
  } else if (decision.type === "propose_foot_action") {
    risk = decision.actionProposal?.risk || "medium";
    reasons.push("A foot proposal may be created, but commands cannot be executed by Agent Core.");
    requiredApprovals.push("user_confirmation_before_foot_execute");
    blockedCapabilities.push("foot.execute");
  } else if (decision.type === "store_memory") {
    risk = decision.memoryDecision?.sensitivity || "medium";
    reasons.push("Only a memory candidate may be recorded in the first stage.");
    blockedCapabilities.push("memory.long_term_write");
  } else if (decision.type === "recall_skill") {
    allowed = false;
    risk = "low";
    reasons.push("Skill Runtime is not implemented in the first stage.");
    blockedCapabilities.push("skill.runtime");
  } else if (decision.type === "wait_for_approval") {
    reasons.push("The decision intentionally waits for explicit user approval.");
    requiredApprovals.push("explicit_target_selection");
  } else {
    reasons.push("This decision only affects local reasoning or expression.");
  }

  if (
    forbidsRealWorldAction(input) &&
    (decision.type === "propose_hand_action" || decision.type === "propose_foot_action")
  ) {
    allowed = false;
    reasons.push("The user explicitly prohibited writing or execution in the current request.");
    blockedCapabilities.push(decision.type === "propose_hand_action" ? "hand.propose" : "foot.propose");
  }

  if (
    input.listenResult.riskFlags.includes("contains_secret_like_text") ||
    input.listenResult.riskFlags.includes("sensitive_instruction")
  ) {
    risk = "high";
    reasons.push("The input contains sensitive or secret-like content.");
    blockedCapabilities.push("memory.store_sensitive_raw_text");
  }

  return {
    id: newId("pgr"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    allowed,
    decisionType: decision.type,
    risk,
    reasons: uniqueStrings(reasons),
    requiredApprovals: uniqueStrings(requiredApprovals),
    blockedCapabilities: uniqueStrings(blockedCapabilities)
  };
}

/**
 * 使用方法：Policy Gate 完成后传入最终决策和策略结果。
 * 作用：把抽象 AgentDecision 映射为 read、speak、hand、foot、memory、skill 或 none 的统一 CapabilityRoute。
 * 边界：该方法只描述路由，不执行能力；hand/foot 在第一阶段永远只能使用 propose 模式。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param policyGate Policy Gate 对当前决策给出的允许、阻止和风险结果。
 */
export function routeAgentDecision(
  decision: AgentDecision,
  policyGate: PolicyGateResult
): CapabilityRoute {
  let capability: CapabilityRoute["capability"] = "speak";
  let mode: CapabilityRoute["mode"] = "execute";
  let reason = "The decision will be expressed to the local user.";

  if (!policyGate.allowed) {
    capability = "speak";
    mode = "execute";
    reason = "The requested route was blocked, so the mouth explains the boundary.";
  } else {
    switch (decision.type) {
      case "read_context":
        capability = "read";
        mode = "execute";
        reason = "The decision needs one bounded context read.";
        break;
      case "propose_hand_action":
        capability = "hand";
        mode = "propose";
        reason = "The decision creates a hand proposal without applying changes.";
        break;
      case "propose_foot_action":
        capability = "foot";
        mode = "propose";
        reason = "The decision creates a foot proposal without running commands.";
        break;
      case "store_memory":
        capability = "memory";
        mode = "record";
        reason = "The decision records a memory candidate only.";
        break;
      case "recall_skill":
        capability = "skill";
        mode = "skip";
        reason = "Skill Runtime is not implemented yet.";
        break;
      case "pause":
      case "stop":
        capability = "none";
        mode = "skip";
        reason = "The task state changes without invoking another capability.";
        break;
      default:
        capability = "speak";
        mode = "execute";
        reason = "The decision is presented through the local mouth capability.";
    }
  }

  return {
    id: newId("cpr"),
    sessionId: decision.sessionId,
    createdAt: nowIso(),
    decisionId: decision.id,
    capability,
    mode,
    reason
  };
}

/**
 * 使用方法：AgentDecision 和 PolicyGateResult 已确定后调用，并把返回值交给 speak.ts 生成用户可见消息。
 * 作用：根据回答、追问、行动建议、暂停、停止或策略阻止选择正确的 SpeakMode 和安全策略。
 * 边界：该方法只创建 SpeakPlan，不生成消息、不对外发送，也不暴露完整内部 reasoning。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param input 创建 SpeakPlanFromDecision 所需的结构化输入。
 * @param policyGate Policy Gate 对当前决策给出的允许、阻止和风险结果。
 */
export function createSpeakPlanFromDecision(
  decision: AgentDecision,
  input: AgentCoreInput,
  policyGate: PolicyGateResult
): SpeakPlan {
  const mode = speakModeForDecision(decision, policyGate);
  return createSpeakPlan({
    goal: isZh(input.locale) ? "向用户表达 Agent Core 的本轮判断。" : "Present the Agent Core decision to the user.",
    reason: cleanText(decision.reason, 600),
    audience: "user",
    channel: "local_chat",
    mode,
    contentTypes: ["markdown"],
    tone: mode === "warn" || mode === "decline" ? "direct" : "calm",
    detailLevel: input.listenResult.constraints.some((constraint) => /document methods/i.test(constraint.content))
      ? "detailed"
      : "normal",
    locale: String(input.locale),
    identity: "assistant",
    safetyPolicy: {
      redactSecrets: true,
      redactPrivateData: true,
      avoidExternalCommitment: true,
      avoidFalseExecutionClaim: true,
      requireDraftLabel: true
    },
    requiresApprovalBeforeDelivery: false
  });
}

/**
 * 使用方法：decision.type 为 propose_hand_action 或 propose_foot_action 时调用。
 * 作用：把抽象行动意图收敛为可审计的 ActionProposal，并为未来 HandPlan/FootPlan 留下最小建议字段。
 * 边界：ActionProposal 不是计划预览和执行结果；该方法不会写文件、生成完整命令或调用 hand/foot。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param input 创建 ActionProposalFromDecision 所需的结构化输入。
 * @param candidate 模型或规则生成、尚待校验的候选结构。
 */
export function createActionProposalFromDecision(
  decision: AgentDecision,
  input: AgentCoreInput,
  candidate: AgentDecisionCandidate = {}
): ActionProposal {
  const kind = decision.type === "propose_foot_action" ? "foot" : "hand";
  const risk = candidate.actionRisk || inferProposalRisk(input, kind);
  const footCommand = kind === "foot" ? cleanOptionalText(candidate.actionCommand, 2000) || inferFootCommand(input) : undefined;
  const footAction = footCommand ? createSuggestedFootAction(input, candidate, footCommand) : undefined;
  const title =
    cleanText(candidate.actionTitle || "", 200) ||
    (isZh(input.locale)
      ? kind === "hand"
        ? "修改当前工作区"
        : "执行受控命令"
      : kind === "hand"
        ? "Modify the current workspace"
        : "Run a controlled command");
  const reason = cleanText(candidate.actionReason || decision.reason, 1000);
  return {
    id: newId("act"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    kind,
    title,
    reason,
    risk,
    requiresApproval: true,
    suggestedHandPlan:
      kind === "hand"
        ? {
            goal: cleanText(input.userText, 500),
            reason,
            riskLevel: risk === "high" ? "H3" : "H2",
            requiresPreview: true,
            requiresApproval: true,
            expectedOutcome: title
          }
        : undefined,
    suggestedFootPlan:
      kind === "foot"
        ? {
            goal: cleanText(input.userText, 500),
            reason,
            riskLevel: risk === "high" ? "F3" : "F2",
            requiresPreview: true,
            requiresApproval: true,
            expectedOutcome: title,
            actions: footAction ? [footAction] : undefined
          }
        : undefined
  };
}

/**
 * 使用方法：processUserMessage() 和 /api/core/decide 把完整 AgentCoreInput 交给此入口。
 * 作用：依次执行 WorkingMemory、硬控制、读判断、模型候选、fallback、Policy Gate、能力路由和 SpeakPlan 创建。
 * 边界：该方法不会执行 read/hand/foot；默认只记录结构化大脑结果。自动读取由上层根据 read route 最多执行一次。
 *
 * @param input 汇总听、读、会话、配置和待处理工具状态的 Agent Core 输入。
 * @param options 可选依赖注入和推理配置，主要供测试或替换模型调用。
 */
function createSuggestedFootAction(
  input: AgentCoreInput,
  candidate: AgentDecisionCandidate,
  command: string
): FootAction {
  const normalizedCommand = normalizeFootCommand(command);
  const timeoutMs =
    typeof candidate.actionTimeoutMs === "number" && Number.isFinite(candidate.actionTimeoutMs)
      ? Math.min(Math.max(Math.floor(candidate.actionTimeoutMs), 1000), 120000)
      : inferFootCommandTimeout(normalizedCommand);
  return {
    id: newId("fct"),
    kind: "run_command",
    targetKind: "workspace",
    command: normalizedCommand,
    cwd: cleanOptionalText(candidate.actionCwd, 200) || ".",
    reason: cleanText(candidate.actionReason || input.userText, 800),
    expectedEffect:
      cleanOptionalText(candidate.actionExpectedEffect, 500) ||
      "Produce command output for the current user request.",
    inputSummary: normalizedCommand.slice(0, 160),
    timeoutMs
  };
}

function inferFootCommand(input: AgentCoreInput): string | undefined {
  const asksForCDrive =
    /(c\s*盘|c:\\|c drive|system drive)/i.test(input.userText) &&
    /(占用|空间|最大|容量|largest|space|usage|size)/i.test(input.userText);
  if (!asksForCDrive) return undefined;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    "Get-ChildItem -LiteralPath 'C:\\' -Force |",
    "ForEach-Object {",
    "$size = if ($_.PSIsContainer) {",
    "(Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum",
    "} else { $_.Length };",
    "[PSCustomObject]@{ SizeGB = [math]::Round(($size / 1GB), 2); Path = $_.FullName }",
    "} | Sort-Object SizeGB -Descending | Select-Object -First 20 | Format-Table -AutoSize"
  ].join(" ");
  return powerShellEncodedCommand(script);
}

function inferFootCommandTimeout(command: string): number {
  return /Get-ChildItem[\s\S]*-Recurse|Measure-Object/i.test(command) ? 120000 : 30000;
}

function normalizeFootCommand(command: string): string {
  const trimmed = command.trim();
  if (/^(powershell|pwsh|cmd|node|npm|pnpm|yarn|git)\b/i.test(trimmed)) return trimmed;
  if (/\b(Get-ChildItem|Where-Object|ForEach-Object|Sort-Object|Select-Object|Measure-Object|Format-Table)\b/i.test(trimmed)) {
    return powerShellEncodedCommand(trimmed);
  }
  return trimmed;
}

function powerShellEncodedCommand(script: string): string {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; ${script}`;
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(wrapped, "utf16le").toString("base64")}`;
}

export async function decideNextStep(
  input: AgentCoreInput,
  options: DecideNextStepOptions = {}
): Promise<AgentCoreResult> {
  let workingMemory = createWorkingMemory(input);
  if (input.contextBlocks.length) {
    workingMemory = updateWorkingMemoryWithContext(workingMemory, input.contextBlocks);
  }

  const warnings: string[] = [];
  let modelReasoning: ModelReasoningResult | undefined;
  let decision = applyHardControl(input, workingMemory);

  if (!decision && shouldReadContext(input)) {
    const readPlan = createReadPlanFromDecision(input);
    if (readPlan) {
      decision = createDecision(input, {
        type: "read_context",
        source: "rule",
        reason: "ListenResult identified required context that can be read by the first-stage read capability.",
        confidence: 0.94,
        userVisibleSummary: isZh(input.locale)
          ? "我需要先读取一次必要上下文，再形成最终判断。"
          : "I need one bounded context read before forming the final decision."
      });
      decision = { ...decision, readPlan };
    }
  }

  if (!decision) {
    modelReasoning = await reasonWithModel(input, workingMemory);
    if (modelReasoning.parsedDecision) {
      try {
        decision = validateAgentDecision(modelReasoning.parsedDecision, input);
      } catch (error) {
        warnings.push(`Model decision validation failed: ${errorMessage(error)}`);
      }
    }
    if (!decision) {
      if (modelReasoning.parseError) {
        warnings.push(`Model reasoning fallback: ${modelReasoning.parseError}`);
      }
      decision = createFallbackDecision(input, modelReasoning);
    }
  }

  if (!decision.memoryDecision && workingMemory.memoryCandidates.length > 0) {
    decision = {
      ...decision,
      memoryDecision: workingMemory.memoryCandidates[0]
    };
  }

  const policyGate = applyPolicyGate(decision, input);
  const decisionWithPolicy: AgentDecision = {
    ...decision,
    userVisibleSummary: policyGate.allowed
      ? decision.userVisibleSummary
      : policyBlockedSummary(decision, policyGate, input),
    policyGate
  };
  const route = routeAgentDecision(decisionWithPolicy, policyGate);
  const speakPlan = createSpeakPlanFromDecision(decisionWithPolicy, input, policyGate);
  const finalDecision: AgentDecision = {
    ...decisionWithPolicy,
    speakPlan
  };

  if (finalDecision.actionProposal) {
    workingMemory = {
      ...workingMemory,
      pendingActionProposalIds: uniqueStrings([
        ...workingMemory.pendingActionProposalIds,
        finalDecision.actionProposal.id
      ])
    };
  }

  const result: AgentCoreResult = {
    id: newId("acr"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    inputSummary: summarizeCoreInput(input),
    workingMemory,
    decision: finalDecision,
    route,
    policyGate,
    modelReasoning,
    warnings
  };

  if (options.record !== false) {
    await recordAgentCoreResult(result);
  }
  return result;
}

/**
 * 使用方法：已有完整 AgentCoreResult、但 decideNextStep({ record: false }) 未自动保存时调用。
 * 作用：把完整结果交给 store 原子记录，供 API、审计和未来反思查询。
 * 边界：该方法只持久化结构化结果，不执行 CapabilityRoute。
 *
 * @param result 需要持久化并写入审计的 AgentCoreResult。
 */
export async function recordAgentCoreResult(result: AgentCoreResult): Promise<AgentCoreResult> {
  return persistAgentCoreResult(result);
}

/**
 * 使用方法：上层在 Agent Core 尚未生成结构化结果前捕获意外异常时调用。
 * 作用：保留 agent.core.failed 审计轨迹，避免大脑失败变成不可见错误。
 * 边界：只记录短错误摘要，不吞掉异常，也不负责生成用户回复。
 *
 * @param sessionId 当前聊天会话的唯一标识，用于隔离消息、工具和审计记录。
 * @param error 捕获到的未知错误或进程错误对象。
 */
export async function recordAgentCoreFailure(
  sessionId: string,
  error: unknown
): Promise<void> {
  await persistAgentCoreFailure(sessionId, errorMessage(error));
}

/**
 * 使用方法：createWorkingMemory() 根据 ListenMemoryCandidate 构造候选，store_memory 决策也会调用。
 * 作用：统一生成带 session、敏感度、来源和 shouldStore 标记的 MemoryDecision。
 * 边界：MemoryDecision 只是候选，不会自动修改 docs/project-memory.md 或其他长期存储。
 *
 * @param input 创建 MemoryDecision 所需的结构化输入。
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 */
function createMemoryDecision(
  input: AgentCoreInput,
  value: string,
  options: {
    shouldStore: boolean;
    kind: MemoryDecision["kind"];
    reason: string;
  }
): MemoryDecision {
  const sensitive = input.listenResult.riskFlags.some((flag) =>
    ["contains_secret_like_text", "private_user_data", "sensitive_instruction"].includes(flag)
  );
  return {
    id: newId("mem"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    kind: options.kind,
    value: sanitizeStoredText(value, 1200),
    reason: cleanText(options.reason, 800),
    shouldStore: options.shouldStore && !sensitive,
    sensitivity: sensitive ? "high" : "low",
    sourceListenResultId: input.listenResult.id
  };
}

/**
 * 使用方法：recall_skill 候选通过校验后调用。
 * 作用：记录未来 Skill Index 应该搜索什么，以及第一阶段不创建 Skill 的明确边界。
 * 边界：不会读取磁盘 Skill、安装插件或调用 MCP。
 *
 * @param input 创建 SkillDecision 所需的结构化输入。
 * @param query 用于模型、Skill、搜索或过滤流程的查询文本。
 */
function createSkillDecision(input: AgentCoreInput, query: string): SkillDecision {
  return {
    id: newId("skd"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    shouldRecall: true,
    shouldCreateCandidate: false,
    skillQuery: cleanText(query, 500),
    reason: "The model suggested Skill recall, but the first-stage Skill Runtime is not implemented."
  };
}

/**
 * 使用方法：规则、模型校验和 fallback 需要创建基础 AgentDecision 时调用。
 * 作用：统一补全 id、sessionId、createdAt、置信度和经过脱敏的用户可见内容。
 * 边界：只创建基础决策，不添加 Policy Gate、route、SpeakPlan 或真实能力结果。
 *
 * @param input 创建 Decision 所需的结构化输入。
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function createDecision(
  input: AgentCoreInput,
  value: {
    type: AgentDecisionType;
    source: AgentDecision["source"];
    reason: string;
    confidence: number;
    userVisibleSummary: string;
  }
): AgentDecision {
  return {
    id: newId("agd"),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    type: value.type,
    reason: cleanText(value.reason, 1200),
    confidence: clampConfidence(value.confidence),
    userVisibleSummary: sanitizeStoredText(value.userVisibleSummary, MODEL_TEXT_LIMIT),
    source: value.source
  };
}

/**
 * 使用方法：shouldReadContext() 和 createReadPlanFromDecision() 共用。
 * 作用：把 ListenResult 建议来源过滤到第一阶段可执行集合，去重并限制最多三个来源。
 * 边界：不会返回 communication、app_content、MCP resource 等尚无 connector 的来源。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function automaticReadSources(input: AgentCoreInput): ReadSource[] {
  const seen = new Set<string>();
  const sources: ReadSource[] = [];
  for (const source of suggestReadSourcesFromListenResult(input.listenResult)) {
    if (!supportedAutomaticReadKinds.has(source.kind)) continue;
    const key = `${source.kind}:${source.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
    if (sources.length >= 3) break;
  }
  return sources;
}

/**
 * 使用方法：buildModelReasoningInput() 和 validateAgentDecision() 调用。
 * 作用：根据用户“不写、不执行、不记忆”等显式边界收窄模型可以选择的决策类型。
 * 边界：返回白名单副本，模型不能通过输出额外字符串扩展能力。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function allowedDecisionTypesForInput(input: AgentCoreInput): AgentDecisionType[] {
  let allowed = [...agentDecisionTypes].filter((type) => type !== "recall_skill");
  if (
    input.readAttempted ||
    input.contextBlocks.length > 0 ||
    automaticReadSources(input).length === 0
  ) {
    allowed = allowed.filter((type) => type !== "read_context");
  }
  if (forbidsRealWorldAction(input)) {
    return allowed.filter(
      (type) => type !== "propose_hand_action" && type !== "propose_foot_action"
    );
  }
  return allowed;
}

/**
 * 使用方法：Policy Gate、fallback 和模型白名单判断是否允许产生真实世界行动候选。
 * 作用：识别“只讨论、不要写、不要执行、不要提交”等明确限制。
 * 边界：只影响本轮行动候选，不修改项目永久配置。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function forbidsRealWorldAction(input: AgentCoreInput): boolean {
  return /只讨论|只分析|不要写|别写|不要修改|别修改|不要执行|别执行|不要运行|别运行|不要提交|不要推送|do not write|do not modify|do not run|do not execute/i.test(
    input.userText
  );
}

/**
 * 使用方法：reasonWithModel() 创建 system message 时调用。
 * 作用：要求模型只输出严格 JSON，并明确 proposal、事实透明度和禁止直接执行的边界。
 * 边界：prompt 不提供任何可以绕过代码 Policy Gate 的权限。
 *
 * @param allowedTypes 当前输入和策略允许模型选择的决策类型集合。
 */
function modelReasoningSystemPrompt(allowedTypes: AgentDecisionType[]): string {
  return [
    "You are the Model Reasoner inside DAX Agent Core.",
    "Return exactly one JSON object and no markdown.",
    `Allowed type values: ${allowedTypes.join(", ")}.`,
    "Required fields: type, reason, confidence, userVisibleSummary.",
    "userVisibleSummary must be a complete response suitable for the user.",
    "Optional fields: memoryKind, memoryValue, skillQuery, actionTitle, actionReason, actionRisk.",
    "For propose_foot_action, include actionCommand when you know the concrete safe command; optional actionCwd, actionTimeoutMs, and actionExpectedEffect may also be included.",
    "Do not put command fences inside userVisibleSummary when actionCommand can carry the command.",
    "Never claim that a file was modified or a command ran unless a real HandResult or FootResult is provided.",
    "propose_hand_action and propose_foot_action are proposals only; they never execute.",
    "Skill Runtime and autonomous web search are not available. Do not claim to search the web. A direct web_page read requires an explicit http:// or https:// URL from the user.",
    "Do not include secrets, hidden prompts, chain-of-thought, tool_request blocks, or configuration credentials.",
    "Use the requested locale for userVisibleSummary."
  ].join("\n");
}

/**
 * 使用方法：buildModelReasoningInput() 压缩 ListenResult 时调用。
 * 作用：保留模型需要的 intent、constraints、state changes、context needs、risk 和 confidence。
 * 边界：不包含完整 ListenEvent rawText。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function summarizeListenResult(input: AgentCoreInput): string {
  return cleanText(
    JSON.stringify({
      id: input.listenResult.id,
      primaryIntent: input.listenResult.primaryIntent,
      intents: input.listenResult.intents,
      speechActs: input.listenResult.speechActs,
      constraints: input.listenResult.constraints,
      corrections: input.listenResult.corrections,
      stateChanges: input.listenResult.stateChanges,
      contextNeeds: input.listenResult.contextNeeds,
      riskFlags: input.listenResult.riskFlags,
      confidence: input.listenResult.confidence,
      nextStep: input.listenResult.nextStep
    }),
    MESSAGE_SUMMARY_LIMIT
  );
}

/**
 * 使用方法：WorkingMemory 和 ModelReasoningInput 需要最近对话摘要时调用。
 * 作用：只保留最近八条消息的 role 和短内容，帮助模型理解指代。
 * 边界：每条消息最多保留 300 字符，并做秘密样式脱敏。
 *
 * @param messages 用于查找上下文、模型推理或界面渲染的消息列表。
 */
function summarizeRecentMessages(messages: Message[]): string {
  return messages
    .slice(-8)
    .map((message) => `${message.role}: ${sanitizeStoredText(message.content, 300)}`)
    .join("\n");
}

/**
 * 使用方法：createWorkingMemory() 和 updateWorkingMemoryWithContext() 调用。
 * 作用：把 ContextBlock 标题、可信度、风险和内容压缩成有总长度上限的工作摘要。
 * 边界：不保存无限长度 ContextBlock 原文，秘密样式内容会被脱敏。
 *
 * @param blocks 需要压缩或整理为模型上下文的上下文块列表。
 */
function summarizeContextBlocks(blocks: ContextBlock[]): string {
  if (!blocks.length) return "";
  const summary = blocks
    .slice(0, 8)
    .map((block) =>
      [
        `[${block.title}] trust=${block.trust} freshness=${block.freshness}`,
        block.riskFlags.length ? `risk=${block.riskFlags.join(",")}` : "",
        sanitizeStoredText(block.content, 1400)
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
  return cleanText(summary, CONTEXT_SUMMARY_LIMIT);
}

/**
 * 使用方法：decideNextStep() 创建 AgentCoreResult.inputSummary 时调用。
 * 作用：保存足够复盘本轮输入的短摘要，而不是持久化完整 AgentCoreInput。
 * 边界：不包含 AppConfig、API key、完整消息历史或完整 ContextBlock。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function summarizeCoreInput(input: AgentCoreInput): string {
  return sanitizeStoredText(
    JSON.stringify({
      userText: cleanText(input.userText, 500),
      primaryIntent: input.listenResult.primaryIntent,
      contextBlockIds: input.contextBlocks.map((block) => block.id),
      pendingToolRunIds: input.pendingToolRuns.map((run) => run.id),
      readAttempted: input.readAttempted,
      readFailure: input.readFailure
    }),
    1600
  );
}

/**
 * 使用方法：parseModelDecision() 在没有 fenced JSON 时调用。
 * 作用：从普通模型文本中截取第一个完整外层 JSON 对象。
 * 边界：这不是宽松修复器；找不到对象时直接抛错，让 fallback 接管。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Model reasoning did not return a JSON object.");
  }
  return text.slice(start, end + 1);
}

function extractDecisionJson(text: string): string {
  const trimmed = text.trim();
  const jsonFence = trimmed.match(/^```json\s*([\s\S]*?)```\s*$/i);
  if (jsonFence?.[1]) return jsonFence[1].trim();
  return extractFirstJsonObject(trimmed);
}

/**
 * 使用方法：createFallbackDecision() 判断非法 JSON 是否仍是可展示的普通模型回答。
 * 作用：保留兼容旧模型的纯文本回答，同时拒绝半截 JSON 和旧 tool_request 控制块。
 * 边界：返回文本仍会脱敏和截断；结构化残片不会直接展示给用户。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function usablePlainModelText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || /^[{[]/.test(trimmed) || /```(?:json|tool_request)?/i.test(trimmed)) return "";
  return sanitizeStoredText(trimmed, MODEL_TEXT_LIMIT);
}

/**
 * 使用方法：createSpeakPlanFromDecision() 选择表达方式时调用。
 * 作用：把 AgentDecisionType 和 Policy Gate 状态映射为嘴巴已有的 SpeakMode。
 * 边界：只选择表达模式，不生成用户内容。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param policyGate Policy Gate 对当前决策给出的允许、阻止和风险结果。
 */
function speakModeForDecision(
  decision: AgentDecision,
  policyGate: PolicyGateResult
): SpeakMode {
  if (!policyGate.allowed) return "warn";
  switch (decision.type) {
    case "ask_user":
      return "ask";
    case "read_context":
    case "wait_for_approval":
      return "status";
    case "propose_hand_action":
    case "propose_foot_action":
      return "plan";
    case "pause":
    case "stop":
      return "acknowledge";
    case "store_memory":
    case "recall_skill":
      return "report";
    default:
      return "answer";
  }
}

/**
 * 使用方法：decideNextStep() 发现 Policy Gate.allowed=false 时调用。
 * 作用：把可能带有行动承诺的模型文案替换成清晰的阻止说明、原因和被阻止能力。
 * 边界：只改变用户可见摘要，不改变原始内部 reason，也不会尝试绕过策略寻找其他执行路径。
 *
 * @param decision 已经生成并待校验、路由、表达或持久化的 Agent 决策。
 * @param policyGate Policy Gate 对当前决策给出的允许、阻止和风险结果。
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 */
function policyBlockedSummary(
  decision: AgentDecision,
  policyGate: PolicyGateResult,
  input: AgentCoreInput
): string {
  const reasons = policyGate.reasons.join(" ");
  const blocked = policyGate.blockedCapabilities.join(", ");
  if (isZh(input.locale)) {
    return [
      `这一步没有被 Agent Core 的 Policy Gate 允许，因此不会执行“${decision.type}”。`,
      reasons ? `原因：${reasons}` : "",
      blocked ? `被阻止的能力：${blocked}。` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    `Agent Core Policy Gate did not allow "${decision.type}", so it will not be executed.`,
    reasons ? `Reason: ${reasons}` : "",
    blocked ? `Blocked capabilities: ${blocked}.` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 使用方法：createActionProposalFromDecision() 在模型没有给出风险时调用。
 * 作用：根据 push、删除、覆盖、依赖安装和外部访问等词语给 proposal 一个保守风险等级。
 * 边界：启发式风险只服务 proposal，不能替代 HandPreview 或 FootPreview 的正式风险判断。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param kind 当前方法要解析、判断或创建的类别标识。
 */
function inferProposalRisk(input: AgentCoreInput, kind: ActionProposal["kind"]): AgentRiskLevel {
  if (/删除|覆盖|迁移|重置|push|发布|部署|生产|凭证|密钥|delete|overwrite|reset|deploy|production/i.test(input.userText)) {
    return "high";
  }
  if (kind === "foot" || /修改|写入|实现|安装|更新|modify|write|install|update/i.test(input.userText)) {
    return "medium";
  }
  return "low";
}

/**
 * 使用方法：parseModelDecision() 对 unknown JSON 做对象判定时调用。
 * 作用：排除 null、数组和基础值，保证后续字段访问安全。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 使用方法：parseModelDecision() 读取可选字符串字段时调用。
 * 作用：只接受 string，并去掉首尾空白。
 *
 * @param value 需要尝试解析为 String 的未知可选值；无法识别时返回 undefined。
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 使用方法：parseModelDecision() 读取 confidence 时调用。
 * 作用：只接受有限数值，其他值交给默认置信度处理。
 *
 * @param value 需要尝试解析为 Number 的未知可选值；无法识别时返回 undefined。
 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 使用方法：parseModelDecision() 校验模型给出的 type。
 * 作用：把 unknown 收窄为 AgentDecisionType。
 * 边界：不在白名单的值返回 undefined，后续 validate 会拒绝。
 *
 * @param value 需要尝试解析为 DecisionType 的未知可选值；无法识别时返回 undefined。
 */
function optionalDecisionType(value: unknown): AgentDecisionType | undefined {
  return typeof value === "string" && agentDecisionTypes.has(value as AgentDecisionType)
    ? (value as AgentDecisionType)
    : undefined;
}

/**
 * 使用方法：parseModelDecision() 校验 memoryKind。
 * 作用：把 unknown 收窄为 MemoryDecision.kind。
 *
 * @param value 需要尝试解析为 MemoryKind 的未知可选值；无法识别时返回 undefined。
 */
function optionalMemoryKind(value: unknown): MemoryDecision["kind"] | undefined {
  return typeof value === "string" && memoryKinds.has(value as MemoryDecision["kind"])
    ? (value as MemoryDecision["kind"])
    : undefined;
}

/**
 * 使用方法：parseModelDecision() 校验 actionRisk。
 * 作用：把 unknown 收窄为 low、medium 或 high。
 *
 * @param value 需要尝试解析为 RiskLevel 的未知可选值；无法识别时返回 undefined。
 */
function optionalRiskLevel(value: unknown): AgentRiskLevel | undefined {
  return typeof value === "string" && riskLevels.has(value as AgentRiskLevel)
    ? (value as AgentRiskLevel)
    : undefined;
}

/**
 * 使用方法：创建或校验 AgentDecision 时传入任意 confidence。
 * 作用：把非有限值变成 0.5，并把正常数值限制在 0 到 1。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * 使用方法：所有进入工作记忆、审计摘要和用户可见结果的文本都可调用。
 * 作用：做秘密样式脱敏、空白整理和长度限制。
 * 边界：这是基础防护，不代替 Speak Capability 的最终安全过滤。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 * @param maxChars 输出允许保留的最大字符数。
 */
function cleanText(value: string, maxChars: number): string {
  return sanitizeStoredText(value, maxChars).replace(/\r\n/g, "\n").trim();
}

/**
 * 使用方法：可选错误和可选字段需要清理时调用。
 * 作用：空值返回 undefined，非空文本走 cleanText()。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 * @param maxChars 输出允许保留的最大字符数。
 */
function cleanOptionalText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const cleaned = cleanText(value, maxChars);
  return cleaned || undefined;
}

/**
 * 使用方法：准备把模型文本、用户摘要或上下文摘要放进持久化对象前调用。
 * 作用：替换明显凭据并限制最大字符数。
 * 边界：不会尝试识别所有隐私数据，后续嘴巴和记忆层仍需执行各自策略。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 * @param maxChars 输出允许保留的最大字符数。
 */
function sanitizeStoredText(value: string, maxChars: number): string {
  let text = String(value || "");
  for (const pattern of secretLikePatterns) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted]");
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[...truncated...]`;
}

/**
 * 使用方法：组装 constraints、ids、reasons 和 blocked capabilities 时调用。
 * 作用：去掉空字符串并保持首次出现顺序去重。
 *
 * @param values 需要批量归一化、去重、替换或格式化的值集合。
 */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * 使用方法：所有 catch 分支需要把 unknown 转成可审计错误文本时调用。
 * 作用：优先返回 Error.message，否则安全转成字符串。
 *
 * @param error 捕获到的未知错误或进程错误对象。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 使用方法：需要根据 locale 选择中文或英文默认文案时调用。
 * 作用：兼容 zh-CN、zh-TW 等以 zh 开头的 locale。
 *
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function isZh(locale: Locale): boolean {
  return String(locale || "").toLowerCase().startsWith("zh");
}
