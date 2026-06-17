import { loadConfig } from "./config.js";
import {
  addMessage,
  createToolRun,
  getRecentMessages,
  updateToolRun
} from "./store.js";
import { completeChat } from "./providers.js";
import { executeTool, executeToolRun, getTool, toolManifest } from "./tools.js";
import { analyzeAndRecordUserText } from "./listen.js";
import { createAndRecordSpeakInteraction, speakModeFromListenResult } from "./speak.js";
import type {
  AppConfig,
  ChatMessage,
  JsonObject,
  ListenEvent,
  ListenResult,
  Locale,
  Message,
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
}

interface AssistantMessageWithSpeak {
  message: Message;
  speakPlan: SpeakPlan;
  speakMessage: SpeakMessage;
  speakResult: SpeakResult;
}

interface AddSpokenAssistantMessageOptions {
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

function systemPrompt(config: AppConfig, locale: Locale): string {
  return [
    `You are ${config.app?.name || "DAX Agent"}, a local-first personal AI agent gateway.`,
    "You help the user operate this workspace safely and transparently.",
    `The user's interface locale is ${locale}. Reply in ${isZh(locale) ? "Chinese" : "English"} unless the user asks otherwise.`,
    "Use concise responses. When a task needs local data or command execution, request a tool instead of pretending you used it.",
    "",
    "Available tools:",
    JSON.stringify(toolManifest, null, 2),
    "",
    "To request tools, include exactly one fenced block like this:",
    "```tool_request",
    "[{\"tool\":\"workspace.list\",\"input\":{\"path\":\".\"}}]",
    "```",
    "Read-only tools may run automatically. shell.run always waits for explicit user approval."
  ].join("\n");
}

function extractToolRequests(content: string): Array<{ tool: string; input?: JsonObject }> {
  const block = content.match(/```tool_request\s*([\s\S]*?)```/i);
  if (!block) return [];
  try {
    const parsed = JSON.parse((block[1] || "[]").trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function cleanAssistantContent(content: string): string {
  return content.replace(/```tool_request\s*[\s\S]*?```/gi, "").trim();
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
  const speak = await createAndRecordSpeakInteraction({
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

async function createRunsFromAssistant(
  sessionId: string,
  assistantMessage: Message,
  config: AppConfig
): Promise<(ToolRun | null)[]> {
  const requests = extractToolRequests(assistantMessage.content);
  const runs = [];
  for (const request of requests) {
    const tool = getTool(request.tool);
    if (!tool) continue;
    const approvalRequired = Boolean(tool.approvalRequired);
    const run = await createToolRun(
      sessionId,
      assistantMessage.id,
      request.tool,
      request.input || {},
      approvalRequired
    );
    if (!approvalRequired && config.security?.autoRunReadTools) {
      runs.push(await executeToolRun(run.id));
    } else {
      runs.push(run);
    }
  }
  return runs;
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
      speakResult: slashResult.speakResult
    };
  }

  const history = await getRecentMessages(sessionId, 30);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(config, locale) },
    ...history.map((message) => ({
      role: message.role,
      content: message.content
    }))
  ];

  try {
    const completion = await completeChat(config, messages, locale);
    const rawContent = completion.content;
    const fallbackContent = isZh(locale)
      ? "我请求了一次工具运行，请在工具面板中查看。"
      : "I requested a tool run. Review the tool panel.";
    const displayContent = cleanAssistantContent(rawContent) || fallbackContent;
    const spoken = await addSpokenAssistantMessage(sessionId, displayContent, locale, {
      mode: speakModeFromListenResult(listenAnalysis.result),
      contentTypes: ["markdown"],
      sourceRefs: [
        { kind: "listen_result", id: listenAnalysis.result.id, label: listenAnalysis.result.primaryIntent },
        { kind: "user_message", id: userMessage.id, label: "current user message" }
      ],
      meta: {
        provider: completion.provider,
        model: completion.model,
        rawContent
      }
    });
    const toolRuns = await createRunsFromAssistant(
      sessionId,
      { ...spoken.message, content: rawContent },
      config
    );
    return {
      userMessage,
      assistantMessage: spoken.message,
      toolRuns,
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      speakPlan: spoken.speakPlan,
      speakMessage: spoken.speakMessage,
      speakResult: spoken.speakResult
    };
  } catch (error) {
    const content = isZh(locale)
      ? `模型错误：${error instanceof Error ? error.message : String(error)}\n\n你可以在设置中调整 Provider，或使用 /help 查看本地命令。`
      : `Model error: ${error instanceof Error ? error.message : String(error)}\n\nUse Settings to adjust the provider, or use /help for local commands.`;
    const spoken = await addSpokenAssistantMessage(
      sessionId,
      content,
      locale,
      {
        mode: "warn",
        sourceRefs: [{ kind: "system_status", label: "model provider error" }],
        riskFlags: ["contains_unverified_claim"],
        meta: { error: true }
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
      speakResult: spoken.speakResult
    };
  }
}
