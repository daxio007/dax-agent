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
import { executeTool, getTool } from "./tools.js";
import { analyzeAndRecordUserText } from "./listen.js";
import {
  createAndRecordSpeakInteraction,
  createSpeakMessage,
  createSpeakResult
} from "./speak.js";
import type {
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
 */
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
