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
import type { AppConfig, ChatMessage, JsonObject, ListenEvent, ListenResult, Locale, Message, ToolRun } from "./types.js";

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
): Promise<{ message: Message; toolRuns: (ToolRun | null)[] }> {
  if (slash.kind === "help") {
    return {
      message: await addMessage(sessionId, "assistant", helpText(locale), { source: "local-command" }),
      toolRuns: []
    };
  }

  if (slash.kind === "unknown") {
    const content = isZh(locale)
      ? `未知命令：${slash.command}。可以试试 /help。`
      : `Unknown command: ${slash.command}. Try /help.`;
    return {
      message: await addMessage(sessionId, "assistant", content, {
        source: "local-command"
      }),
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
      const message = await addMessage(
        sessionId,
        "assistant",
        content,
        { source: "local-command", toolRunId: run.id }
      );
      return { message, toolRuns: [run] };
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
    const message = await addMessage(sessionId, "assistant", `${prefix}\n\n${output}`, {
      source: "local-command",
      toolRunId: completed?.id || run.id
    });
    return { message, toolRuns: [completed] };
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
      listenResult: listenAnalysis.result
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
    const assistantMessage = await addMessage(sessionId, "assistant", displayContent, {
      provider: completion.provider,
      model: completion.model,
      rawContent
    });
    const toolRuns = await createRunsFromAssistant(
      sessionId,
      { ...assistantMessage, content: rawContent },
      config
    );
    return {
      userMessage,
      assistantMessage,
      toolRuns,
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result
    };
  } catch (error) {
    const assistantMessage = await addMessage(
      sessionId,
      "assistant",
      isZh(locale)
        ? `模型错误：${error instanceof Error ? error.message : String(error)}\n\n你可以在设置中调整 Provider，或使用 /help 查看本地命令。`
        : `Model error: ${error instanceof Error ? error.message : String(error)}\n\nUse Settings to adjust the provider, or use /help for local commands.`,
      { error: true }
    );
    return {
      userMessage,
      assistantMessage,
      toolRuns: [],
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result
    };
  }
}
