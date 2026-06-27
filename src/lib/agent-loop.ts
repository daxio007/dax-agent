import { completeChat } from "./providers.js";
import { createReadPlan, executeAndRecordReadPlan } from "./read.js";
import { getRuntimeTimeContext } from "./time.js";
import type {
  AppConfig,
  ChatMessage,
  ContextBlock,
  JsonObject,
  ListenResult,
  Locale,
  Message,
  ReadResult,
  ReadSourceKind
} from "./types.js";

const MAX_LOOP_STEPS = 5;
const OBSERVATION_LIMIT = 6000;
const ANSWER_LIMIT = 10000;

type AgentLoopToolName = "web_search" | "web_read" | "workspace_search" | "workspace_read";

type AgentLoopAction =
  | { action: "web_search"; query: string; reason?: string }
  | { action: "web_read"; url: string; reason?: string }
  | { action: "workspace_search"; query: string; reason?: string }
  | { action: "workspace_read"; path: string; reason?: string }
  | { action: "finish"; answer: string; reason?: string };

interface AgentLoopInput {
  sessionId: string;
  userMessageId: string;
  userText: string;
  locale: Locale;
  listenResult: ListenResult;
  recentMessages: Message[];
  config: AppConfig;
}

interface AgentLoopObservation {
  tool: AgentLoopToolName;
  input: JsonObject;
  ok: boolean;
  summary: string;
  contextBlockIds: string[];
  readResultIds: string[];
}

interface AgentLoopStep {
  index: number;
  action: AgentLoopAction["action"];
  reason: string;
  rawModelText: string;
}

export interface AgentLoopResult {
  answer: string;
  reason: string;
  steps: AgentLoopStep[];
  observations: AgentLoopObservation[];
  contextBlocks: ContextBlock[];
  readResults: ReadResult[];
  warnings: string[];
}

/**
 * 使用方法：processUserMessage() 在普通自然语言消息进入旧 Agent Core 前调用。
 * 作用：判断本轮是否适合交给只读工具循环处理，避免写入和命令类任务绕过既有审批。
 * @param text 当前用户输入的原始文本。
 * @param listenResult 听力层对当前文本生成的结构化分析结果。
 */
export function shouldUseAgentLoopForMessage(text: string, listenResult: ListenResult): boolean {
  const unsafeOrActionLike =
    /(?:提交|推送|修改|实现|安装|构建|运行|启动|停止|删除|覆盖|迁移|重置|发布|部署|命令|终端|脚本|进程|git|npm|pnpm|yarn|shell|cmd|powershell|c\s*盘|磁盘|占用|空间)/i.test(
      text
    );
  if (unsafeOrActionLike) return false;
  const deterministicDate =
    /(?:几月几[日号]|几号|星期几|周几|节日|纪念日|什么日子|current date|what day is it)/i.test(text);
  if (deterministicDate) return false;
  const asksSearchCapability =
    /(?:有没有|没有|具备|支持|能不能|可以|是否有).{0,12}(?:直接)?(?:联网|上网|网络)?搜索.{0,12}(?:能力|功能)?|只能.{0,12}(?:发|给).{0,8}(?:链接|网址)|搜索.{0,8}(?:能力|功能)/i.test(
      text
    );
  if (asksSearchCapability) return false;
  if (listenResult.contextNeeds.some((need) => need.kind === "web_search" || need.kind === "web_page")) {
    return true;
  }
  return ["chat", "ask", "explain", "read", "inspect", "design", "unknown"].includes(listenResult.primaryIntent);
}

/**
 * 使用方法：普通问答消息决定走新循环后调用。
 * 作用：让模型按“计划一步、执行只读工具、观察结果、继续计划”的方式完成回答。
 * @param input 当前 agent loop 需要的会话、用户文本、听力结果、历史消息和配置。
 */
export async function executeAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const steps: AgentLoopStep[] = [];
  const observations: AgentLoopObservation[] = [];
  const contextBlocks: ContextBlock[] = [];
  const readResults: ReadResult[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < MAX_LOOP_STEPS; index += 1) {
    const completion = await completeChat(input.config, loopMessages(input, observations), input.locale);
    let action = parseLoopAction(completion.content);
    if (action.action === "finish" && observations.length === 0 && requiresToolUse(input)) {
      const fallback = fallbackToolAction(input);
      if (fallback) action = fallback;
    }
    steps.push({
      index,
      action: action.action,
      reason: action.reason || "",
      rawModelText: truncateText(completion.content, 2000)
    });

    if (action.action === "finish") {
      return {
        answer: truncateText(action.answer, ANSWER_LIMIT) || defaultEmptyAnswer(input.locale),
        reason: action.reason || "The model produced a final answer.",
        steps,
        observations,
        contextBlocks,
        readResults,
        warnings
      };
    }

    const toolResult = await executeReadOnlyAction(input, action);
    observations.push(toolResult.observation);
    contextBlocks.push(...toolResult.contextBlocks);
    readResults.push(...toolResult.readResults);
    if (!toolResult.observation.ok) warnings.push(toolResult.observation.summary);
  }

  const finalCompletion = await completeChat(input.config, loopMessages(input, observations, true), input.locale);
  const finalAction = parseLoopAction(finalCompletion.content);
  const answer = finalAction.action === "finish"
    ? finalAction.answer
    : usablePlainText(finalCompletion.content);
  return {
    answer: truncateText(answer, ANSWER_LIMIT) || defaultEmptyAnswer(input.locale),
    reason: finalAction.reason || "The loop reached its step limit and asked the model to synthesize from observations.",
    steps,
    observations,
    contextBlocks,
    readResults,
    warnings
  };
}

/**
 * 使用方法：每次模型规划前传入当前输入和已获得的观察结果。
 * 作用：生成要求模型只返回 JSON action 的消息列表。
 * @param input 当前 agent loop 输入。
 * @param observations 已执行工具返回的观察结果。
 * @param forceFinish 是否要求模型停止调用工具并输出最终答案。
 */
function loopMessages(
  input: AgentLoopInput,
  observations: AgentLoopObservation[],
  forceFinish = false
): ChatMessage[] {
  const currentTime = getRuntimeTimeContext(String(input.locale || "zh-CN"));
  const payload = {
    currentTime,
    locale: input.locale,
    userText: input.userText,
    listen: {
      primaryIntent: input.listenResult.primaryIntent,
      intents: input.listenResult.intents,
      contextNeeds: input.listenResult.contextNeeds,
      riskFlags: input.listenResult.riskFlags
    },
    recentMessages: input.recentMessages.slice(-8).map((message) => ({
      role: message.role,
      content: truncateText(message.content, 500)
    })),
    observations: observations.map((observation) => ({
      tool: observation.tool,
      input: observation.input,
      ok: observation.ok,
      summary: truncateText(observation.summary, OBSERVATION_LIMIT),
      contextBlockIds: observation.contextBlockIds,
      readResultIds: observation.readResultIds
    })),
    forceFinish
  };
  return [
    { role: "system", content: loopSystemPrompt(forceFinish) },
    { role: "user", content: JSON.stringify(payload, null, 2) }
  ];
}

/**
 * 使用方法：构造 loopMessages() 的 system message 时调用。
 * 作用：定义只读工具循环协议和模型必须输出的 JSON action schema。
 * @param forceFinish 是否要求模型只输出 finish action。
 */
function loopSystemPrompt(forceFinish: boolean): string {
  return [
    "You are DAX Agent's read-only tool-using loop.",
    "Return exactly one JSON object and no markdown.",
    "The host currentTime is authoritative for today's date, weekday, year, and timezone.",
    "You can use these read-only tools:",
    '{"action":"web_search","query":"keywords","reason":"why"} - search the public web and read top results.',
    '{"action":"web_read","url":"https://...","reason":"why"} - read one public web page.',
    '{"action":"workspace_search","query":"keywords","reason":"why"} - search text inside the local workspace.',
    '{"action":"workspace_read","path":"relative/or/absolute/path","reason":"why"} - read a local workspace/document path.',
    '{"action":"finish","answer":"final user-facing answer","reason":"why enough"} - answer the user.',
    "Use tools proactively for current facts, news, public web info, source-specific claims, and local workspace questions.",
    "Do not ask the user for a link when a web_search can find likely sources.",
    "If a tool result is weak or empty, try a better query or read another source before giving up.",
    "Never claim a search, page read, file read, command, or modification happened unless it appears in observations.",
    "Do not request write, shell, install, git, delete, or deployment actions in this loop.",
    "When answering from web observations, summarize the bounded evidence and include useful source URLs.",
    "Use the requested locale for the answer.",
    forceFinish ? "You must now output finish. Do not call another tool." : "Choose exactly one next action."
  ].join("\n");
}

/**
 * 使用方法：模型返回文本后调用。
 * 作用：把严格 JSON 或夹杂文本中的首个 JSON 对象解析成循环 action。
 * @param text 模型输出的原始文本。
 */
function parseLoopAction(text: string): AgentLoopAction {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as Partial<Record<string, unknown>>;
    const action = typeof parsed.action === "string" ? parsed.action : "";
    const answer =
      stringField(parsed.answer) ||
      stringField(parsed.finalAnswer) ||
      stringField(parsed.final_answer) ||
      stringField(parsed.content) ||
      stringField(parsed.userVisibleSummary);
    if (action === "web_search") {
      return { action, query: stringField(parsed.query), reason: stringField(parsed.reason) };
    }
    if (action === "web_read") {
      return { action, url: stringField(parsed.url), reason: stringField(parsed.reason) };
    }
    if (action === "workspace_search") {
      return { action, query: stringField(parsed.query), reason: stringField(parsed.reason) };
    }
    if (action === "workspace_read") {
      return { action, path: stringField(parsed.path), reason: stringField(parsed.reason) };
    }
    if (action === "finish" || action === "final" || action === "answer") {
      return { action: "finish", answer, reason: stringField(parsed.reason) };
    }
    if (answer) {
      return { action: "finish", answer, reason: stringField(parsed.reason) || "Model returned an answer field without the exact finish action." };
    }
  } catch {
    return { action: "finish", answer: usablePlainText(text), reason: "Model returned plain text instead of JSON." };
  }
  return { action: "finish", answer: usablePlainText(text), reason: "Model returned an unsupported loop action." };
}

/**
 * 使用方法：parseLoopAction() 需要从模型文本中取 JSON 对象时调用。
 * 作用：兼容模型偶尔在 JSON 前后加说明文字的情况。
 * @param text 模型输出的原始文本。
 */
function extractJsonObject(text: string): string {
  const trimmed = String(text || "").trim();
  const fence = trimmed.match(/^```json\s*([\s\S]*?)```\s*$/i);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found.");
  return trimmed.slice(start, end + 1);
}

/**
 * 使用方法：parseLoopAction() 读取可选字符串字段时调用。
 * 作用：把 unknown 字段安全收敛成去空白字符串。
 * @param value 需要读取的未知字段值。
 */
function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 使用方法：executeAgentLoop() 判断模型是否过早 finish 时调用。
 * 作用：确保明显需要外部或本地上下文的问题至少执行一次只读工具。
 * @param input 当前 agent loop 输入。
 */
function requiresToolUse(input: AgentLoopInput): boolean {
  return input.listenResult.contextNeeds.some((need) =>
    ["web_search", "web_page", "workspace", "document", "memory"].includes(need.kind)
  );
}

/**
 * 使用方法：模型未主动用工具但听力层已经识别上下文需求时调用。
 * 作用：把 ListenContextNeed 转成第一步兜底工具 action。
 * @param input 当前 agent loop 输入。
 */
function fallbackToolAction(input: AgentLoopInput): AgentLoopAction | null {
  const need = input.listenResult.contextNeeds.find((item) => item.kind !== "none");
  if (!need) return null;
  const target = need.suggestedTarget || input.userText;
  if (need.kind === "web_page" && /^https?:\/\//i.test(target)) {
    return { action: "web_read", url: target, reason: need.reason };
  }
  if (need.kind === "web_search") {
    return { action: "web_search", query: target, reason: need.reason };
  }
  if (need.kind === "workspace" || need.kind === "document" || need.kind === "memory") {
    return { action: "workspace_read", path: target, reason: need.reason };
  }
  return null;
}

/**
 * 使用方法：循环拿到非 finish action 后调用。
 * 作用：执行一个只读工具，并把读取结果转换成后续模型可消费的观察。
 * @param input 当前 agent loop 输入。
 * @param action 本轮模型选择的只读工具 action。
 */
async function executeReadOnlyAction(
  input: AgentLoopInput,
  action: Exclude<AgentLoopAction, { action: "finish" }>
): Promise<{ observation: AgentLoopObservation; contextBlocks: ContextBlock[]; readResults: ReadResult[] }> {
  const source = sourceFromAction(action);
  if (!source.target) {
    return {
      observation: {
        tool: action.action,
        input: actionInput(action),
        ok: false,
        summary: "Tool input was empty.",
        contextBlockIds: [],
        readResultIds: []
      },
      contextBlocks: [],
      readResults: []
    };
  }
  try {
    const output = await executeAndRecordReadPlan(
      createReadPlan(
        {
          goal: "Agent loop read-only tool call.",
          reason: action.reason || `Agent loop requested ${action.action}.`,
          sources: [source],
          maxBytes: 120000,
          maxFiles: action.action === "web_search" ? 8 : 20,
          allowNetwork: source.kind === "web_search" || source.kind === "web_page",
          expectedSignals: [action.action]
        },
        input.config
      ),
      input.config
    );
    const summary = output.contextBlocks
      .map((block) => `[${block.title}]\n${truncateText(block.content, OBSERVATION_LIMIT)}`)
      .join("\n\n");
    return {
      observation: {
        tool: action.action,
        input: actionInput(action),
        ok: true,
        summary: summary || "Tool completed without readable content.",
        contextBlockIds: output.contextBlocks.map((block) => block.id),
        readResultIds: output.results.map((result) => result.id)
      },
      contextBlocks: output.contextBlocks,
      readResults: output.results
    };
  } catch (error) {
    return {
      observation: {
        tool: action.action,
        input: actionInput(action),
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        contextBlockIds: [],
        readResultIds: []
      },
      contextBlocks: [],
      readResults: []
    };
  }
}

/**
 * 使用方法：执行工具前传入模型 action。
 * 作用：把循环 action 转换成 ReadPlan 可执行的 ReadSource。
 * @param action 本轮模型选择的只读工具 action。
 */
function sourceFromAction(action: Exclude<AgentLoopAction, { action: "finish" }>): {
  kind: ReadSourceKind;
  target: string;
  purpose: string;
  required: boolean;
} {
  if (action.action === "web_search") {
    return { kind: "web_search", target: action.query, purpose: action.reason || "Agent loop web search.", required: true };
  }
  if (action.action === "web_read") {
    return { kind: "web_page", target: action.url, purpose: action.reason || "Agent loop web page read.", required: true };
  }
  if (action.action === "workspace_search") {
    return { kind: "search", target: action.query, purpose: action.reason || "Agent loop workspace search.", required: true };
  }
  return { kind: "workspace", target: action.path, purpose: action.reason || "Agent loop workspace read.", required: true };
}

/**
 * 使用方法：记录观察结果时传入模型 action。
 * 作用：生成可审计且不含多余字段的工具输入对象。
 * @param action 本轮模型选择的只读工具 action。
 */
function actionInput(action: Exclude<AgentLoopAction, { action: "finish" }>): JsonObject {
  if (action.action === "web_search") return { query: action.query };
  if (action.action === "web_read") return { url: action.url };
  if (action.action === "workspace_search") return { query: action.query };
  return { path: action.path };
}

/**
 * 使用方法：模型输出非 JSON 时作为最终答案兜底。
 * 作用：去掉空白和过长内容，避免把结构化残片直接透给用户。
 * @param text 模型输出的原始文本。
 */
function usablePlainText(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed || /^[{[]/.test(trimmed)) return "";
  return truncateText(trimmed.replace(/^```[\s\S]*?```$/g, ""), ANSWER_LIMIT);
}

/**
 * 使用方法：需要把工具观察或模型文本限制长度时调用。
 * 作用：保留开头内容并标注截断，控制模型上下文和消息体积。
 * @param text 需要截断的文本。
 * @param maxChars 允许保留的最大字符数。
 */
function truncateText(text: string, maxChars: number): string {
  const value = String(text || "");
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[...truncated...]`;
}

/**
 * 使用方法：循环没有拿到有效最终答案时调用。
 * 作用：按当前语言返回明确的失败说明。
 * @param locale 当前用户界面或消息语言。
 */
function defaultEmptyAnswer(locale: Locale): string {
  return String(locale || "").toLowerCase().startsWith("zh")
    ? "我这轮没有拿到足够可靠的结果。可以换一个更具体的问题，我会继续用搜索和读取工具查。"
    : "I could not gather enough reliable information in this turn. Try a more specific question and I will continue with search and read tools.";
}
