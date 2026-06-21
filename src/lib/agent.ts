import { loadConfig } from "./config.js";
import {
  addMessage,
  createToolRun,
  getRecentMessages,
  listToolRuns,
  recordSpeakInteraction,
  updateToolRun
} from "./store.js";
import { createAgentCoreInput, decideNextStep, recordAgentCoreFailure } from "./core.js";
import { executeAndRecordReadPlan } from "./read.js";
import { executeTool, executeToolRun, getTool } from "./tools.js";
import { analyzeAndRecordUserText } from "./listen.js";
import {
  createAndRecordSpeakInteraction,
  createSpeakMessage,
  createSpeakResult
} from "./speak.js";
import type {
  ActionProposal,
  AgentCoreResult,
  ContextBlock,
  JsonObject,
  ListenEvent,
  ListenResult,
  Locale,
  Message,
  ReadResult,
  SpeakAudience,
  SpeakChannel,
  SpeakContentType,
  SpeakIdentity,
  SpeakMessage,
  SpeakMode,
  SpeakPlan,
  SpeakResult,
  SpeakSourceRef,
  ToolRun
} from "./types.js";

type SlashCommand =
  | { kind: "help" }
  | {
      kind: "tool";
      tool: string;
      input: JsonObject;
      approvalRequired: boolean;
    }
  | { kind: "unknown"; command: string };

interface ProcessUserMessageResult {
  userMessage: Message;
  assistantMessage: Message;
  toolRuns: (ToolRun | null)[];
  listenEvent: ListenEvent;
  listenResult: ListenResult;
  speakPlan: SpeakPlan;
  speakMessage: SpeakMessage;
  speakResult: SpeakResult;
  agentCoreResult?: AgentCoreResult;
  agentCoreResults: AgentCoreResult[];
  contextBlocks: ContextBlock[];
  readResults: ReadResult[];
}

interface AssistantMessageWithSpeak {
  message: Message;
  speakPlan: SpeakPlan;
  speakMessage: SpeakMessage;
  speakResult: SpeakResult;
}

interface AddSpokenAssistantMessageOptions {
  plan?: SpeakPlan;
  mode?: SpeakMode;
  audience?: SpeakAudience;
  channel?: SpeakChannel;
  identity?: SpeakIdentity;
  contentTypes?: SpeakContentType[];
  sourceRefs?: SpeakSourceRef[];
  assumptions?: string[];
  uncertaintyFlags?: string[];
  riskFlags?: string[];
  draft?: boolean;
  title?: string;
  goal?: string;
  reason?: string;
  meta?: JsonObject;
}

/**
 * 使用方法：传入当前界面 Locale，供消息流程选择中文或英文默认文案。
 * 作用：统一判断 zh-CN、zh-TW 等中文 locale，避免各分支重复字符串判断。
 * 边界：只判断语言前缀，不翻译内容，也不修改会话状态。
 *
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function isZh(locale: Locale): boolean {
  return String(locale || "").toLowerCase().startsWith("zh");
}

/**
 * 通过“嘴巴”能力创建 assistant 消息并写入会话。
 *
 * 使用方法：
 * - 所有 assistant 可见输出都应调用这个方法，而不是直接 addMessage。
 * - content 是准备表达的原始文本，options 描述表达模式、来源、草稿和额外 meta。
 * - 返回值包含 session message 以及对应 SpeakPlan、SpeakMessage、SpeakResult。
 *
 * 作用：
 * - 把普通回复、工具结果、状态说明和模型错误统一纳入 Speak Capability。
 * - 让每条 assistant 输出都有受众、Channel、风险标记和审计记录。
 *
 * @param sessionId 当前聊天会话的唯一标识，用于隔离消息、工具和审计记录。
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 */
async function addSpokenAssistantMessage(
  sessionId: string,
  content: string,
  locale: Locale,
  options: AddSpokenAssistantMessageOptions = {}
): Promise<AssistantMessageWithSpeak> {
  let speak: { plan: SpeakPlan; message: SpeakMessage; result: SpeakResult };
  if (options.plan) {
    const message = createSpeakMessage(options.plan, {
      content,
      title: options.title,
      sourceRefs: options.sourceRefs,
      assumptions: options.assumptions,
      uncertaintyFlags: options.uncertaintyFlags,
      riskFlags: options.riskFlags,
      draft: options.draft
    });
    const result = createSpeakResult(options.plan, message);
    speak = await recordSpeakInteraction(options.plan, message, result, sessionId);
  } else {
    speak = await createAndRecordSpeakInteraction({
        sessionId,
        content,
        locale: String(locale),
        mode: options.mode || "answer",
        audience: options.audience || "user",
        channel: options.channel || "local_chat",
        identity: options.identity,
        contentTypes: options.contentTypes,
        sourceRefs: options.sourceRefs,
        assumptions: options.assumptions,
        uncertaintyFlags: options.uncertaintyFlags,
        riskFlags: options.riskFlags,
        draft: options.draft,
        title: options.title,
        goal: options.goal,
        reason: options.reason
      });
  }
  const meta: JsonObject = {
    ...(options.meta || {}),
    speakPlanId: speak.plan.id,
    speakMessageId: speak.message.id,
    speakResultId: speak.result.id,
    speakMode: speak.plan.mode,
    speakAudience: speak.plan.audience,
    speakChannel: speak.plan.channel,
    speakDraft: speak.message.draft,
    speakRiskFlags: speak.message.riskFlags
  };
  const message = await addMessage(sessionId, "assistant", speak.message.content, meta);
  return {
    message,
    speakPlan: speak.plan,
    speakMessage: speak.message,
    speakResult: speak.result
  };
}

/**
 * 使用方法：把用户原始文本传入，返回 help、tool、unknown 或 null。
 * 作用：将 `/help`、`/read`、`/run` 等显式命令转换成稳定的本地命令结构。
 * 边界：只解析命令，不创建 ToolRun、不执行工具，也不处理普通自然语言。
 *
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 */
function parseSlashCommand(content: string): SlashCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand || "";
  const arg = rest.join(" ").trim();
  switch (command.toLowerCase()) {
    case "/help":
      return {
        kind: "help"
      };
    case "/list":
      return {
        kind: "tool",
        tool: "workspace.list",
        input: { path: arg || "." },
        approvalRequired: false
      };
    case "/read":
      return {
        kind: "tool",
        tool: "workspace.read",
        input: { path: arg },
        approvalRequired: false
      };
    case "/search":
      return {
        kind: "tool",
        tool: "workspace.search",
        input: { query: arg, path: "." },
        approvalRequired: false
      };
    case "/run":
      return {
        kind: "tool",
        tool: "shell.run",
        input: { command: arg, cwd: "." },
        approvalRequired: true
      };
    default:
      return {
        kind: "unknown",
        command
      };
  }
}

function actionProposalReplyIntent(content: string): "approve" | "reject" | null {
  const text = content.trim().toLowerCase();
  if (/^(需要|可以|执行|确认|同意|批准|好|好的|开始|yes|y|ok|approve|run|execute)$/i.test(text)) {
    return "approve";
  }
  if (/^(不要|不用|取消|否|不需要|先不|no|n|reject|cancel|stop)$/i.test(text)) {
    return "reject";
  }
  return null;
}

function storedActionProposal(value: unknown): ActionProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proposal = value as Partial<ActionProposal>;
  return typeof proposal.id === "string" &&
    (proposal.kind === "foot" || proposal.kind === "hand") &&
    typeof proposal.title === "string"
    ? (proposal as ActionProposal)
    : null;
}

function latestActionProposal(messages: Message[]): { proposal: ActionProposal; message: Message } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const proposal = storedActionProposal(message.meta?.actionProposal);
    if (proposal) return { proposal, message };
  }
  return null;
}

function commandFromActionProposal(proposal: ActionProposal): {
  command: string;
  cwd: string;
  timeoutMs?: number;
} | null {
  if (proposal.kind !== "foot") return null;
  const action = proposal.suggestedFootPlan?.actions?.[0];
  if (!action?.command) return null;
  return {
    command: action.command,
    cwd: action.cwd || ".",
    timeoutMs: action.timeoutMs
  };
}

/**
 * 使用方法：处理 `/help` 时传入 locale，返回可以交给嘴巴能力的 Markdown 文本。
 * 作用：集中维护中英文内置命令说明。
 * 边界：只生成说明文本，不检查工具状态，也不执行任何命令。
 *
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function helpText(locale: Locale = "zh-CN"): string {
  if (isZh(locale)) {
    return [
      "可用的本地命令：",
      "",
      "`/help` - 查看帮助",
      "`/list .` - 列出工作区文件",
      "`/read README.md` - 读取工作区文件",
      "`/search agent` - 在工作区文本中搜索",
      "`/run node --version` - 创建一个等待审批的 shell 命令",
      "",
      "当你想使用自然语言 Agent 能力时，可以在设置中配置模型 Provider。"
    ].join("\n");
  }
  return [
    "Available local commands:",
    "",
    "`/help` - show this help",
    "`/list .` - list workspace files",
    "`/read README.md` - read a workspace file",
    "`/search agent` - search text inside the workspace",
    "`/run node --version` - create a pending shell command for approval",
    "",
    "Configure a model provider in Settings when you want natural language agent behavior."
  ].join("\n");
}

/**
 * 使用方法：processUserMessage() 识别到 SlashCommand 后调用，并传入会话和用户消息。
 * 作用：处理帮助、未知命令、只读工具自动运行和 shell 待审批流程。
 * 边界：只处理显式 slash command；自然语言必须进入 Agent Core。
 *
 * @param sessionId 当前聊天会话的唯一标识，用于隔离消息、工具和审计记录。
 * @param userMessage 已经持久化并触发后续 Agent 流程的用户消息。
 * @param slash 已经解析出的 Slash Command 名称和参数。
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
async function handleSlash(
  sessionId: string,
  userMessage: Message,
  slash: SlashCommand,
  locale: Locale
): Promise<AssistantMessageWithSpeak & { toolRuns: (ToolRun | null)[] }> {
  if (slash.kind === "help") {
    const spoken = await addSpokenAssistantMessage(sessionId, helpText(locale), locale, {
      mode: "explain",
      contentTypes: ["markdown"],
      sourceRefs: [{ kind: "system_status", label: "local help command" }],
      meta: { source: "local-command" }
    });
    return {
      ...spoken,
      toolRuns: []
    };
  }

  if (slash.kind === "unknown") {
    const content = isZh(locale)
      ? `未知命令：${slash.command}。可以试试 /help。`
      : `Unknown command: ${slash.command}. Try /help.`;
    const spoken = await addSpokenAssistantMessage(sessionId, content, locale, {
      mode: "warn",
      sourceRefs: [{ kind: "user_message", id: userMessage.id, label: "unknown slash command" }],
      meta: {
        source: "local-command"
      }
    });
    return {
      ...spoken,
      toolRuns: []
    };
  }

  if (slash.kind === "tool") {
    const tool = getTool(slash.tool);
    if (!tool) throw new Error(`Unknown tool: ${slash.tool}`);
    const run = await createToolRun(sessionId, userMessage.id, slash.tool, slash.input, slash.approvalRequired);
    if (slash.approvalRequired) {
      const content = isZh(locale)
        ? `已创建一个待审批的 ${slash.tool} 请求。请在工具面板中查看并批准。`
        : `Created a pending ${slash.tool} request. Review and approve it in the tool panel.`;
      const spoken = await addSpokenAssistantMessage(sessionId, content, locale, {
        mode: "status",
        sourceRefs: [{ kind: "system_status", id: run.id, label: `${slash.tool} pending approval` }],
        meta: { source: "local-command", toolRunId: run.id }
      });
      return { ...spoken, toolRuns: [run] };
    }

    const output = await executeTool(slash.tool, slash.input);
    const completed = await updateToolRun(
      run.id,
      {
        status: "completed",
        output,
        completedAt: new Date().toISOString()
      },
      "tool.completed"
    );
    const prefix = isZh(locale) ? `${slash.tool} 的工具结果：` : `Tool result from ${slash.tool}:`;
    const spoken = await addSpokenAssistantMessage(sessionId, `${prefix}\n\n${output}`, locale, {
      mode: "report",
      contentTypes: ["markdown"],
      sourceRefs: [{ kind: "tool_result", id: completed?.id || run.id, label: slash.tool }],
      meta: {
        source: "local-command",
        toolRunId: completed?.id || run.id
      }
    });
    return { ...spoken, toolRuns: [completed] };
  }

  throw new Error("Unsupported slash command.");
}

/**
 * 处理一条用户消息，并返回听、脑、读和说四层的结构化结果。
 *
 * 使用方法：
 * - HTTP 消息入口调用 processUserMessage(sessionId, content, locale)。
 * - slash command 继续走显式本地命令路径。
 * - 普通自然语言会先经过 ListenResult，再进入 Agent Core；如果大脑要求上下文，最多自动执行一次 ReadPlan。
 *
 * 作用：
 * - 把原来的“听完直接调用模型”升级为“听 -> 大脑 -> 按需读 -> 再决策 -> 嘴巴表达”。
 * - 把 AgentCoreResult、ContextBlock 和 ReadResult 一起返回给 API，方便调试和未来前端展示。
 *
 * 边界：
 * - Agent Core 不会在这里自动调用手或脚。
 * - ActionProposal 只会作为建议进入消息 meta，不会写文件或执行命令。
 * - slash command 的现有审批和工具行为保持不变。
 *
 * @param sessionId 接收这条用户消息的会话唯一标识。
 * @param content 用户在当前会话中发送的原始消息正文。
 * @param locale 本轮消息使用的界面语言，默认使用中文。
 */
async function handleActionProposalReply(
  sessionId: string,
  userMessage: Message,
  content: string,
  locale: Locale,
  recentMessages: Message[]
): Promise<(AssistantMessageWithSpeak & { toolRuns: (ToolRun | null)[] }) | null> {
  const intent = actionProposalReplyIntent(content);
  if (!intent) return null;
  const latest = latestActionProposal(recentMessages);
  if (!latest) return null;

  if (intent === "reject") {
    const spoken = await addSpokenAssistantMessage(
      sessionId,
      isZh(locale)
        ? `好的，本次不会执行“${latest.proposal.title}”。你可以继续输入新的需求或命令。`
        : `Understood. I will not execute "${latest.proposal.title}". You can continue with a new request or command.`,
      locale,
      {
        mode: "acknowledge",
        sourceRefs: [{ kind: "inference", id: latest.proposal.id, label: latest.proposal.title }],
        meta: {
          source: "action-proposal-reply",
          actionProposalId: latest.proposal.id,
          actionProposalStatus: "rejected"
        }
      }
    );
    return { ...spoken, toolRuns: [] };
  }

  const command = commandFromActionProposal(latest.proposal);
  if (!command) {
    const spoken = await addSpokenAssistantMessage(
      sessionId,
      isZh(locale)
        ? `我找到了上一条动作建议“${latest.proposal.title}”，但里面没有可执行命令。你可以点“我自己输入”，或者使用 /run 明确写出要运行的命令。`
        : `I found the previous action proposal "${latest.proposal.title}", but it does not contain an executable command. Use the custom input option, or write an explicit /run command.`,
      locale,
      {
        mode: "warn",
        sourceRefs: [{ kind: "inference", id: latest.proposal.id, label: latest.proposal.title }],
        riskFlags: ["action_proposal_missing_command"],
        meta: {
          source: "action-proposal-reply",
          actionProposalId: latest.proposal.id,
          actionProposalStatus: "missing_command"
        }
      }
    );
    return { ...spoken, toolRuns: [] };
  }

  const input: JsonObject = {
    command: command.command,
    cwd: command.cwd,
    actionProposalId: latest.proposal.id,
    actionProposalTitle: latest.proposal.title
  };
  if (command.timeoutMs) input.timeoutMs = command.timeoutMs;
  const run = await createToolRun(sessionId, userMessage.id, "shell.run", input, true);
  await updateToolRun(
    run.id,
    { status: "approved", approvedAt: new Date().toISOString() },
    "tool.approved"
  );
  const completed = await executeToolRun(run.id);
  const output = completed?.output || completed?.error || "";
  const succeeded = completed?.status === "completed";
  const spoken = await addSpokenAssistantMessage(
    sessionId,
    isZh(locale)
      ? `${succeeded ? "已按你的确认执行建议命令。" : "已按你的确认尝试执行建议命令，但执行未成功。"}\n\n${output}`
      : `${succeeded ? "I executed the proposed command after your confirmation." : "I tried to execute the proposed command after your confirmation, but it did not succeed."}\n\n${output}`,
    locale,
    {
      mode: succeeded ? "report" : "warn",
      contentTypes: ["markdown"],
      sourceRefs: [
        { kind: "inference", id: latest.proposal.id, label: latest.proposal.title },
        { kind: "tool_result", id: completed?.id || run.id, label: "shell.run" }
      ],
      riskFlags: succeeded ? [] : ["tool_run_failed"],
      meta: {
        source: "action-proposal-reply",
        actionProposalId: latest.proposal.id,
        actionProposalStatus: succeeded ? "executed" : "failed",
        toolRunId: completed?.id || run.id
      }
    }
  );
  return { ...spoken, toolRuns: [completed || run] };
}

export async function processUserMessage(
  sessionId: string,
  content: string,
  locale: Locale = "zh-CN"
): Promise<ProcessUserMessageResult> {
  const config = await loadConfig();
  const recentBeforeListen = await getRecentMessages(sessionId, 30);
  const listenAnalysis = await analyzeAndRecordUserText(
    content,
    {
      sessionId,
      locale,
      channelId: "webchat",
      sourceLabel: "WebChat"
    },
    recentBeforeListen
  );
  const userMessage = await addMessage(sessionId, "user", content, {
    listenEventId: listenAnalysis.event.id,
    listenResultId: listenAnalysis.result.id,
    primaryIntent: listenAnalysis.result.primaryIntent,
    nextStep: listenAnalysis.result.nextStep,
    listenConfidence: listenAnalysis.result.confidence
  });
  const slash = parseSlashCommand(content);
  if (slash) {
    const slashResult = await handleSlash(sessionId, userMessage, slash, locale);
    return {
      userMessage,
      assistantMessage: slashResult.message,
      toolRuns: slashResult.toolRuns,
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      speakPlan: slashResult.speakPlan,
      speakMessage: slashResult.speakMessage,
      speakResult: slashResult.speakResult,
      agentCoreResults: [],
      contextBlocks: [],
      readResults: []
    };
  }

  const proposalReplyResult = await handleActionProposalReply(
    sessionId,
    userMessage,
    content,
    locale,
    recentBeforeListen
  );
  if (proposalReplyResult) {
    return {
      userMessage,
      assistantMessage: proposalReplyResult.message,
      toolRuns: proposalReplyResult.toolRuns,
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      speakPlan: proposalReplyResult.speakPlan,
      speakMessage: proposalReplyResult.speakMessage,
      speakResult: proposalReplyResult.speakResult,
      agentCoreResults: [],
      contextBlocks: [],
      readResults: []
    };
  }

  const history = await getRecentMessages(sessionId, 30);
  const pendingToolRuns = (await listToolRuns(sessionId)).filter((run) =>
    ["pending", "approved", "running"].includes(run.status)
  );
  const agentCoreResults: AgentCoreResult[] = [];
  let contextBlocks: ContextBlock[] = [];
  let readResults: ReadResult[] = [];

  try {
    const firstInput = createAgentCoreInput({
      sessionId,
      userMessageId: userMessage.id,
      userText: content,
      locale,
      listenResult: listenAnalysis.result,
      recentMessages: history,
      pendingToolRuns,
      config
    });
    const firstResult = await decideNextStep(firstInput);
    agentCoreResults.push(firstResult);
    let finalResult = firstResult;

    if (
      firstResult.route.capability === "read" &&
      firstResult.route.mode === "execute" &&
      firstResult.policyGate.allowed &&
      firstResult.decision.readPlan
    ) {
      let readFailure: string | undefined;
      try {
        const readOutput = await executeAndRecordReadPlan(firstResult.decision.readPlan, config);
        contextBlocks = readOutput.contextBlocks;
        readResults = readOutput.results;
      } catch (error) {
        readFailure = error instanceof Error ? error.message : String(error);
      }

      const secondInput = createAgentCoreInput({
        sessionId,
        userMessageId: userMessage.id,
        userText: content,
        locale,
        listenResult: listenAnalysis.result,
        recentMessages: history,
        contextBlocks,
        pendingToolRuns,
        config,
        readAttempted: true,
        readFailure
      });
      finalResult = await decideNextStep(secondInput);
      agentCoreResults.push(finalResult);
    }

    const sourceRefs: SpeakSourceRef[] = [
      { kind: "listen_result", id: listenAnalysis.result.id, label: listenAnalysis.result.primaryIntent },
      { kind: "user_message", id: userMessage.id, label: "current user message" },
      { kind: "inference", id: finalResult.decision.id, label: `AgentDecision:${finalResult.decision.type}` },
      ...contextBlocks.map((block) => ({
        kind: "context_block" as const,
        id: block.id,
        label: block.title
      }))
    ];
    const riskFlags = [
      ...listenAnalysis.result.riskFlags,
      ...(finalResult.policyGate.allowed ? [] : ["agent_policy_blocked"]),
      ...(finalResult.decision.actionProposal ? ["action_proposal_not_executed"] : []),
      ...finalResult.warnings.map(() => "agent_core_warning")
    ];
    const spoken = await addSpokenAssistantMessage(
      sessionId,
      finalResult.decision.userVisibleSummary,
      locale,
      {
        plan: finalResult.decision.speakPlan,
        contentTypes: ["markdown"],
        sourceRefs,
        riskFlags,
        uncertaintyFlags: finalResult.warnings,
        reason: finalResult.decision.reason,
        meta: {
          agentCoreResultId: finalResult.id,
          agentDecisionId: finalResult.decision.id,
          agentDecisionType: finalResult.decision.type,
          agentDecisionSource: finalResult.decision.source,
          policyGateResultId: finalResult.policyGate.id,
          capabilityRouteId: finalResult.route.id,
          capability: finalResult.route.capability,
          routeMode: finalResult.route.mode,
          actionProposalId: finalResult.decision.actionProposal?.id || "",
          ...(finalResult.decision.actionProposal
            ? { actionProposal: finalResult.decision.actionProposal }
            : {}),
          memoryDecisionId: finalResult.decision.memoryDecision?.id || "",
          contextBlockIds: contextBlocks.map((block) => block.id)
        }
      }
    );
    return {
      userMessage,
      assistantMessage: spoken.message,
      toolRuns: [],
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      speakPlan: spoken.speakPlan,
      speakMessage: spoken.speakMessage,
      speakResult: spoken.speakResult,
      agentCoreResult: finalResult,
      agentCoreResults,
      contextBlocks,
      readResults
    };
  } catch (error) {
    await recordAgentCoreFailure(sessionId, error);
    const errorContent = isZh(locale)
      ? `Agent Core 错误：${error instanceof Error ? error.message : String(error)}\n\n本轮没有执行修改或命令。你可以重试，或使用 /help 查看显式本地命令。`
      : `Agent Core error: ${error instanceof Error ? error.message : String(error)}\n\nNo modification or command was executed in this turn. Retry, or use /help for explicit local commands.`;
    const spoken = await addSpokenAssistantMessage(sessionId, errorContent, locale, {
      mode: "warn",
      sourceRefs: [
        { kind: "listen_result", id: listenAnalysis.result.id, label: listenAnalysis.result.primaryIntent },
        { kind: "system_status", label: "agent core failure" }
      ],
      riskFlags: ["agent_core_failed"],
      meta: {
        error: true
      }
    });
    return {
      userMessage,
      assistantMessage: spoken.message,
      toolRuns: [],
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      speakPlan: spoken.speakPlan,
      speakMessage: spoken.speakMessage,
      speakResult: spoken.speakResult,
      agentCoreResults,
      contextBlocks,
      readResults
    };
  }
}
