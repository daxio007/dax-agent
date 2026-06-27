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
  if (isWeatherQuestion(text)) return true;
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

  if (isWeatherQuestion(input.userText) && !hasWeatherLocation(input.userText)) {
    return {
      answer: weatherLocationPrompt(input.locale),
      reason: "Weather queries need a city or region before fresh weather data can be searched.",
      steps,
      observations,
      contextBlocks,
      readResults,
      warnings
    };
  }

  if (isWeatherQuestion(input.userText) && hasWeatherLocation(input.userText)) {
    return executeWeatherLookup(input);
  }

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
 * 使用方法：executeAgentLoop() 收到有地点的天气问题时调用。
 * 作用：用少量确定性的 web_search 获取天气上下文，再交给模型总结，避免通用循环反复搜索。
 * @param input 当前 agent loop 输入。
 */
async function executeWeatherLookup(input: AgentLoopInput): Promise<AgentLoopResult> {
  const steps: AgentLoopStep[] = [];
  const observations: AgentLoopObservation[] = [];
  const contextBlocks: ContextBlock[] = [];
  const readResults: ReadResult[] = [];
  const warnings: string[] = [];
  for (const query of weatherSearchQueries(input.userText)) {
    steps.push({
      index: steps.length,
      action: "web_search",
      reason: "Weather answers require fresh public weather data.",
      rawModelText: `deterministic weather lookup: ${query}`
    });
    const toolResult = await executeReadOnlyAction(input, {
      action: "web_search",
      query,
      reason: "Weather answers require fresh public weather data."
    });
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
  steps.push({
    index: steps.length,
    action: finalAction.action === "finish" ? "finish" : finalAction.action,
    reason: finalAction.reason || "Weather lookup synthesized from fresh observations.",
    rawModelText: truncateText(finalCompletion.content, 2000)
  });
  return {
    answer: truncateText(answer, ANSWER_LIMIT) || defaultEmptyAnswer(input.locale),
    reason: finalAction.reason || "Weather lookup synthesized from fresh observations.",
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
    "For weather, temperature, rain, air-quality, and forecast questions with a location, search fresh weather data before answering.",
    "If a weather question has no usable location, ask for the location instead of inventing one.",
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
  return (isWeatherQuestion(input.userText) && hasWeatherLocation(input.userText)) || input.listenResult.contextNeeds.some((need) =>
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
  if (!need && isWeatherQuestion(input.userText) && hasWeatherLocation(input.userText)) {
    return {
      action: "web_search",
      query: weatherSearchQuery(input.userText),
      reason: "Weather answers require fresh public weather data."
    };
  }
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

/**
 * 使用方法：executeAgentLoop() 收到无地点天气查询时调用。
 * 作用：用确定性话术向用户索要城市或地区，避免执行没有目标的天气搜索。
 * @param locale 当前用户界面或消息语言。
 */
function weatherLocationPrompt(locale: Locale): string {
  return String(locale || "").toLowerCase().startsWith("zh")
    ? "可以查天气。你想查哪个城市或地区？例如“上海今天的天气怎么样”。"
    : "I can check the weather. Which city or region should I use?";
}

/**
 * 使用方法：路由和兜底工具选择需要识别天气类问题时调用。
 * 作用：将天气、气温、降雨、空气质量等当前信息问题纳入强制只读工具流程。
 * @param text 当前用户输入文本。
 */
function isWeatherQuestion(text: string): boolean {
  if (/(?:能不能|可以|是否|支持|具备|有没有).{0,12}(?:查|查询|搜索|获取).{0,6}(?:天气|气温|温度|空气质量|AQI|weather)/i.test(text)) {
    return false;
  }
  return /天气|天气预报|气温|温度|几度|多少度|下雨|降雨|雨量|空气质量|AQI|雾霾|紫外线|weather|forecast/i.test(text);
}

/**
 * 使用方法：requiresToolUse() 和 fallbackToolAction() 判断天气查询是否能直接搜索时调用。
 * 作用：没有城市或地区时允许模型追问地点，不强制执行无目标搜索。
 * @param text 当前用户输入文本。
 */
function hasWeatherLocation(text: string): boolean {
  return Boolean(extractWeatherLocation(text));
}

/**
 * 使用方法：天气问题缺少听力层 web_search 需求时作为兜底搜索词。
 * 作用：返回最高命中的天气搜索词，避免模型第一步直接回答或使用过宽搜索词。
 * @param text 当前用户输入文本。
 */
function weatherSearchQuery(text: string): string {
  return weatherSearchQueries(text)[0] || text;
}

/**
 * 使用方法：executeWeatherLookup() 需要确定性天气搜索词列表时调用。
 * 作用：用少量高命中查询覆盖官方天气站和实时天气摘要，避免通用循环反复试探。
 * @param text 当前用户输入文本。
 */
function weatherSearchQueries(text: string): string[] {
  const context = getRuntimeTimeContext("zh-CN");
  const location = extractWeatherLocation(text) || text;
  const primary = /[A-Za-z]/.test(location)
    ? `${location} weather forecast today`
    : `${location}天气预报15天`;
  const queries = [
    primary,
    `${location} 天气预报 今日 实时 气温`,
    `${location} ${context.localDate} ${context.weekday} 天气预报`
  ].map((query) => query.replace(/\s+/g, " ").trim());
  return [...new Set(queries)].slice(0, 2);
}

/**
 * 使用方法：hasWeatherLocation() 和 weatherSearchQuery() 需要地点关键词时调用。
 * 作用：从自然语言天气问题中去掉天气、时间和问句词，得到更稳定的城市/地区搜索目标。
 * @param text 当前用户输入文本。
 */
function extractWeatherLocation(text: string): string {
  const cleaned = text
    .replace(/天气预报|天气|气温|温度|几度|多少度|会不会|下雨|降雨|雨量|空气质量|AQI|雾霾|紫外线|weather|forecast/gi, " ")
    .replace(/今天|今日|明天|后天|现在|当前|实时|这几天|最近|本周|周末|早上|上午|下午|晚上|今晚/gi, " ")
    .replace(/怎么样|如何|多少|吗|呢|吧|啊|呀|么|请|帮我|麻烦|查一下|查询|查查|看看|看下|告诉我|一下|的|在|本地|这里|当前位置/gi, " ")
    .replace(/[，。！？?、,.;；:：()[\]{}"'`~!@#$%^&*_+=|\\/<>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (/^(?:today|tomorrow|now|current|local|here)$/i.test(cleaned)) return "";
  return cleaned.length >= 2 ? cleaned.slice(0, 60) : "";
}
