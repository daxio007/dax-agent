import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, maskConfig, saveLocalConfig } from "./lib/config.js";
import {
  createSession,
  deleteSession,
  getRecentMessages,
  getSession,
  listAgentCoreResults,
  listAgentDecisions,
  listAudit,
  listCapabilityRoutes,
  listFootPlans,
  listFootPreviews,
  listFootResults,
  listHandPlans,
  listHandPreviews,
  listHandResults,
  recordHandResult,
  listListenEvents,
  listListenResults,
  listPolicyGateResults,
  listReadEvents,
  listSessions,
  listSpeakMessages,
  listSpeakPlans,
  listSpeakResults,
  listToolRuns,
  updateToolRun
} from "./lib/store.js";
import { processUserMessage } from "./lib/agent.js";
import { completeChat } from "./lib/providers.js";
import {
  createAgentCoreInput,
  decideNextStep,
  recordAgentCoreFailure
} from "./lib/core.js";
import { executeToolRun } from "./lib/tools.js";
import {
  coerceFootAction,
  coerceFootPlan,
  createFootPlan,
  createFootPreview,
  executeAndRecordFootPlan,
  type CreateFootPlanInput
} from "./lib/foot.js";
import {
  coerceHandAction,
  coerceHandPlan,
  applyHandPlan,
  createHandPlan,
  createHandPreview,
  executeAndRecordHandPlan,
  type ApplyHandPlanOptions,
  type CreateHandPlanInput
} from "./lib/hand.js";
import { coerceReadSource, createReadPlan, executeAndRecordReadPlan } from "./lib/read.js";
import { analyzeAndRecordListenEvent } from "./lib/listen.js";
import {
  coerceSpeakAudience,
  coerceSpeakChannel,
  coerceSpeakContentType,
  coerceSpeakIdentity,
  coerceSpeakMode,
  coerceSpeakSourceRef,
  coerceSpeakTone,
  createAndRecordSpeakInteraction,
  createSpeakPlan,
  type CreateSpeakPlanInput
} from "./lib/speak.js";
import type {
  AgentCoreResult,
  AppConfig,
  ContextBlock,
  DeepPartial,
  FootPlan,
  HandPlan,
  HandPreview,
  JsonObject,
  ListenEventKind,
  ListenPrivacyLevel,
  ListenTrust,
  ReadPlan,
  ReadResult,
  ReadSource,
  SpeakMessage,
  SpeakPlan,
  SpeakSafetyPolicy,
  SpeakSourcePolicy,
  SpeakSourceRef
} from "./lib/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

interface HttpError extends Error {
  statusCode?: number;
}

function parseArgs(argv: string[]): DeepPartial<AppConfig["app"]> {
  const args: DeepPartial<AppConfig["app"]> = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--port" && argv[index + 1]) {
      args.port = Number(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error: HttpError = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

/**
 * 创建一个带 HTTP 状态码的错误。
 *
 * 使用方法：
 * - API 参数校验失败时调用 createHttpError("message", 400)。
 * - handleRequest 会读取 statusCode 并返回对应 JSON 响应。
 *
 * 作用：
 * - 避免每个路由重复创建 Error 并手动挂 statusCode。
 * - 让新增的 read API 和现有错误处理保持同一风格。
 */
function createHttpError(message: string, statusCode = 400): HttpError {
  const error: HttpError = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * 从 unknown 中读取可选字符串。
 *
 * 使用方法：
 * - read API 从 JSON body 中提取 goal、reason 等字段时调用。
 *
 * 作用：
 * - 避免把 undefined、null 或对象误当成字符串。
 * - 保持 API 入参处理简单清楚。
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 从 unknown 中读取可选正数。
 *
 * 使用方法：
 * - read API 处理 maxBytes、maxFiles 这类边界参数时调用。
 *
 * 作用：
 * - 保证读取计划中的数量参数不会变成 NaN、负数或 0。
 */
function optionalPositiveNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : undefined;
}

/**
 * 将设置 API 传入的 Provider 收敛为当前运行时支持的值。
 *
 * 使用方法：
 * - PUT /api/config 保存设置前调用。
 * - 未传值时使用当前 Provider，传入未知值时返回 400。
 *
 * 作用：
 * - 避免把拼写错误或前端未知选项写入 config/local.json。
 *
 * 边界：
 * - 当前只支持 echo、openai 和 ollama。
 */
function coerceModelProvider(value: unknown, fallback: string): string {
  const provider = optionalString(value) || fallback;
  if (!["echo", "openai", "ollama"].includes(provider)) {
    throw createHttpError("Provider must be echo, openai, or ollama.");
  }
  return provider;
}

/**
 * 校验保存后真正会生效的模型配置。
 *
 * 使用方法：
 * - PUT /api/config 在写入本地配置前调用。
 * - 测试连接 API 在发出模型请求前也调用。
 *
 * 作用：
 * - 阻止“选择真实 Provider，但 Base URL、模型名或 API key 缺失”的无效设置。
 * - 提前给设置面板返回可理解的 400 错误，而不是等到聊天时才报模型错误。
 *
 * 边界：
 * - echo 不需要外部配置。
 * - Ollama 允许空 API key；当前 openai Provider 与 providers.ts 保持一致，要求 API key。
 */
function validateModelConfig(config: AppConfig): void {
  if (config.model.provider === "echo") return;
  if (!config.model.baseUrl.trim()) {
    throw createHttpError("Base URL is required for a non-echo provider.");
  }
  let parsed: URL;
  try {
    parsed = new URL(config.model.baseUrl);
  } catch {
    throw createHttpError("Base URL must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createHttpError("Base URL must use http:// or https://.");
  }
  if (!config.model.model.trim()) {
    throw createHttpError("Model name is required for a non-echo provider.");
  }
  if (config.model.provider === "openai" && !config.model.apiKey) {
    throw createHttpError("API key is required for the OpenAI-compatible provider.");
  }
}

/**
 * 判断设置 API 收到的 API key 是否只是 GET /api/config 返回的脱敏展示值。
 *
 * 使用方法：
 * - PUT /api/config 处理 apiKey 字段前调用。
 *
 * 作用：
 * - 防止 API 客户端把 `sk-a...b0b7` 或星号掩码误当成新密钥写回本地配置。
 *
 * 边界：
 * - 空字符串由“留空保留当前密钥”规则处理。
 * - 真正的新密钥只有在不是掩码时才会覆盖旧值。
 */
function isMaskedApiKey(value: string): boolean {
  return value.includes("*") || /^.{4}\.\.\..{4}$/.test(value);
}

/**
 * 从 unknown 中读取字符串数组。
 *
 * 使用方法：
 * - read API 处理 expectedSignals 时调用。
 *
 * 作用：
 * - 让调用方既可以不传 expectedSignals，也可以传字符串数组。
 * - 自动过滤空字符串和非字符串值。
 */
function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

/**
 * 从请求 body 中解析 ReadSource 列表。
 *
 * 使用方法：
 * - /api/read/plan 和 /api/read/execute 都调用它。
 *
 * 作用：
 * - 统一校验 sources 必须是非空数组。
 * - 复用 read.ts 中的 coerceReadSource，保证 API 和内部代码同一套来源结构。
 */
function readSourcesFromBody(body: JsonObject): ReadSource[] {
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw createHttpError("Read request requires a non-empty sources array.");
  }
  return body.sources.map((source) => coerceReadSource(source));
}

/**
 * 从请求 body 中构造 ReadPlan。
 *
 * 使用方法：
 * - API 收到读取请求后，把 body 和当前 config 传入。
 * - 如果 body 带有 id 或 createdAt，会保留它们，方便先 plan 后 execute。
 *
 * 作用：
 * - 让 /api/read/plan 和 /api/read/execute 使用同一套计划创建逻辑。
 * - 固定 no_per_read_approval、风险推断和读取边界。
 */
function readPlanFromBody(body: JsonObject, config: AppConfig): ReadPlan {
  const plan = createReadPlan(
    {
      goal: optionalString(body.goal) || "Read context for the current task.",
      reason: optionalString(body.reason) || "The task needs additional context.",
      sources: readSourcesFromBody(body),
      maxBytes: optionalPositiveNumber(body.maxBytes),
      maxFiles: optionalPositiveNumber(body.maxFiles),
      allowNetwork: body.allowNetwork === undefined ? undefined : Boolean(body.allowNetwork),
      expectedSignals: optionalStringArray(body.expectedSignals)
    },
    config
  );
  if (typeof body.id === "string" && body.id.trim()) plan.id = body.id.trim();
  if (typeof body.createdAt === "string" && body.createdAt.trim()) plan.createdAt = body.createdAt.trim();
  return plan;
}

/**
 * 从 unknown 中读取可选 JSON 对象。
 *
 * 使用方法：
 * - listen API 处理 payload 字段时调用。
 *
 * 作用：
 * - 保证 payload 只接收普通对象，避免数组、字符串或 null 混入结构化事件。
 */
function optionalJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

/**
 * 从请求 body 中读取听力事件类型。
 *
 * 使用方法：
 * - /api/listen/analyze 接收 kind 时调用。
 *
 * 作用：
 * - 让 API 层只做轻量转换，真正的类型合法性由 listen.ts 校验。
 */
function optionalListenEventKind(value: unknown): ListenEventKind | undefined {
  return typeof value === "string" ? (value as ListenEventKind) : undefined;
}

/**
 * 从请求 body 中读取隐私等级。
 *
 * 使用方法：
 * - /api/listen/analyze 接收 privacyLevel 时调用。
 *
 * 作用：
 * - 允许调用方显式标记 public、personal 或 sensitive。
 */
function optionalListenPrivacyLevel(value: unknown): ListenPrivacyLevel | undefined {
  return value === "public" || value === "personal" || value === "sensitive" ? value : undefined;
}

/**
 * 从请求 body 中读取来源可信度。
 *
 * 使用方法：
 * - /api/listen/analyze 接收 trust 时调用。
 *
 * 作用：
 * - 允许 Channel Adapter 对输入来源给出 high、medium 或 low 评级。
 */
function optionalListenTrust(value: unknown): ListenTrust | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

/**
 * 从 unknown 中读取可选布尔值。
 *
 * 使用方法：
 * - speak API 处理 draft、requiresApprovalBeforeDelivery 等字段时调用。
 *
 * 作用：
 * - 区分“未传入”和“传入 false”，避免默认策略被错误覆盖。
 */
function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : Boolean(value);
}

/**
 * 从请求 body 中读取脚部动作列表。
 *
 * 使用方法：
 * - /api/foot/plan、/api/foot/preview 和 /api/foot/execute 都通过它读取 actions。
 *
 * 作用：
 * - 统一要求 actions 必须是非空数组。
 * - 复用 foot.ts 的 coerceFootAction，确保 API 和核心模块使用同一套动作结构。
 */
function footActionsFromBody(body: JsonObject): ReturnType<typeof coerceFootAction>[] {
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    throw createHttpError("Foot request requires a non-empty actions array.");
  }
  return body.actions.map((action) => coerceFootAction(action));
}

/**
 * 从请求 body 中读取脚部计划输入。
 *
 * 使用方法：
 * - /api/foot/plan 创建新 FootPlan 时调用。
 * - /api/foot/preview 和 /api/foot/execute 在没有传入 plan 对象时也调用。
 *
 * 作用：
 * - 把外部 JSON 收敛成 createFootPlan 可以消费的结构。
 * - API 层只负责轻量字段转换，风险推断仍由 foot.ts 完成。
 */
function footPlanInputFromBody(body: JsonObject): CreateFootPlanInput {
  return {
    goal: optionalString(body.goal),
    reason: optionalString(body.reason),
    actions: footActionsFromBody(body),
    expectedOutcome: optionalString(body.expectedOutcome)
  };
}

/**
 * 从请求 body 中得到 FootPlan。
 *
 * 使用方法：
 * - 调用方可以传完整 plan，也可以传 goal/reason/actions。
 * - 传完整 plan 时使用 coerceFootPlan 保留 id，便于先 plan 后 execute。
 *
 * 作用：
 * - 让 foot API 支持三段式调用，也支持一次 execute 的简化调用。
 */
function footPlanFromBody(body: JsonObject): FootPlan {
  const plan = optionalJsonObject(body.plan);
  return plan ? coerceFootPlan(plan) : createFootPlan(footPlanInputFromBody(body));
}

/**
 * 从请求 body 中读取脚部执行选项。
 *
 * 使用方法：
 * - /api/foot/execute 读取 approved 和 dryRun 时调用。
 *
 * 作用：
 * - 明确 approved=true 表示调用方已经完成审批。
 * - dryRun=true 会生成 skipped result，不启动真实进程。
 */
function footExecutionOptionsFromBody(body: JsonObject): { approved?: boolean; dryRun?: boolean } {
  return {
    approved: optionalBoolean(body.approved),
    dryRun: optionalBoolean(body.dryRun)
  };
}

/**
 * 从请求 body 中读取手部动作列表。
 *
 * 使用方法：
 * - /api/hand/plan、/api/hand/preview、/api/hand/apply 和 /api/hand/execute 都通过它读取 actions。
 *
 * 作用：
 * - 统一要求 actions 必须是非空数组。
 * - 复用 hand.ts 的 coerceHandAction，确保 API 和核心模块使用同一套动作结构。
 */
function handActionsFromBody(body: JsonObject): ReturnType<typeof coerceHandAction>[] {
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    throw createHttpError("Hand request requires a non-empty actions array.");
  }
  return body.actions.map((action) => coerceHandAction(action));
}

/**
 * 从请求 body 中读取手部计划输入。
 *
 * 使用方法：
 * - /api/hand/plan 创建新 HandPlan 时调用。
 * - /api/hand/preview、/api/hand/apply 和 /api/hand/execute 在没有传入 plan 对象时也调用。
 *
 * 作用：
 * - 把外部 JSON 收敛成 createHandPlan 可以消费的结构。
 * - API 层只负责轻量字段转换，风险推断仍由 hand.ts 完成。
 */
function handPlanInputFromBody(body: JsonObject): CreateHandPlanInput {
  return {
    goal: optionalString(body.goal),
    reason: optionalString(body.reason),
    actions: handActionsFromBody(body),
    expectedOutcome: optionalString(body.expectedOutcome)
  };
}

/**
 * 从请求 body 中得到 HandPlan。
 *
 * 使用方法：
 * - 调用方可以传完整 plan，也可以传 goal/reason/actions。
 * - 传完整 plan 时使用 coerceHandPlan 保留 id，便于先 plan 后 preview/apply。
 *
 * 作用：
 * - 让 hand API 支持三段式调用，也支持一次 execute 的简化调用。
 */
function handPlanFromBody(body: JsonObject): HandPlan {
  const plan = optionalJsonObject(body.plan);
  return plan ? coerceHandPlan(plan) : createHandPlan(handPlanInputFromBody(body));
}

/**
 * 从请求 body 中读取 HandPreview。
 *
 * 使用方法：
 * - /api/hand/apply 接收调用方传回的 preview 时调用。
 *
 * 作用：
 * - 将外部 JSON 收敛成 applyHandPlan 需要的最小稳定结构。
 * - 避免缺失 planId、actionPreviews 或 diff 的 preview 进入写入链路。
 */
function coerceHandPreviewFromBody(value: JsonObject): HandPreview {
  if (!Array.isArray(value.actionPreviews)) {
    throw createHttpError("Hand preview actionPreviews must be an array.");
  }
  const id = optionalString(value.id);
  const planId = optionalString(value.planId);
  if (!id || !planId) {
    throw createHttpError("Hand preview requires id and planId.");
  }
  return {
    id,
    planId,
    summary: optionalString(value.summary) || "Hand preview.",
    affectedTargets: optionalStringArray(value.affectedTargets) || [],
    actionPreviews: value.actionPreviews.map((item) => {
      const preview = optionalJsonObject(item);
      if (!preview) throw createHttpError("Hand action preview must be an object.");
      const actionId = optionalString(preview.actionId);
      const target = optionalString(preview.target);
      if (!actionId || !target) throw createHttpError("Hand action preview requires actionId and target.");
      return {
        actionId,
        target,
        beforeHash: optionalString(preview.beforeHash),
        afterHash: optionalString(preview.afterHash),
        beforeBytes: optionalPositiveNumber(preview.beforeBytes) || 0,
        afterBytes: optionalPositiveNumber(preview.afterBytes) || 0,
        diff: optionalString(preview.diff) || "",
        riskFlags: optionalStringArray(preview.riskFlags) || [],
        reversible: Boolean(preview.reversible),
        rollbackStrategy:
          preview.rollbackStrategy === "snapshot" ||
          preview.rollbackStrategy === "reverse_patch" ||
          preview.rollbackStrategy === "external_revision" ||
          preview.rollbackStrategy === "adapter_defined"
            ? preview.rollbackStrategy
            : "none",
        summary: optionalString(preview.summary) || target
      };
    }),
    diff: optionalString(value.diff) || "",
    reversible: Boolean(value.reversible),
    rollbackStrategy:
      value.rollbackStrategy === "snapshot" ||
      value.rollbackStrategy === "reverse_patch" ||
      value.rollbackStrategy === "external_revision" ||
      value.rollbackStrategy === "adapter_defined"
        ? value.rollbackStrategy
        : "none",
    riskLevel:
      value.riskLevel === "H0" || value.riskLevel === "H1" || value.riskLevel === "H2" || value.riskLevel === "H3"
        ? value.riskLevel
        : "H3",
    riskFlags: optionalStringArray(value.riskFlags) || [],
    requiresApproval: Boolean(value.requiresApproval),
    createdAt: optionalString(value.createdAt) || new Date().toISOString()
  };
}

/**
 * 从请求 body 中读取手部执行选项。
 *
 * 使用方法：
 * - /api/hand/apply 和 /api/hand/execute 读取 approved 和 dryRun 时调用。
 *
 * 作用：
 * - 明确 approved=true 表示调用方已经完成审批。
 * - dryRun=true 会生成 skipped result，不写入文件。
 */
function handApplyOptionsFromBody(body: JsonObject): ApplyHandPlanOptions {
  return {
    approved: optionalBoolean(body.approved),
    dryRun: optionalBoolean(body.dryRun)
  };
}

/**
 * 从请求 body 中读取 SpeakPlan 的输入。
 *
 * 使用方法：
 * - /api/speak/plan 和 /api/speak/compose 共用它。
 *
 * 作用：
 * - 将外部 JSON 收敛成 createSpeakPlan 可以消费的结构。
 * - 保持受众、Channel、模式、语气和身份的校验都走 speak.ts。
 */
function speakPlanInputFromBody(body: JsonObject): CreateSpeakPlanInput {
  return {
    goal: optionalString(body.goal),
    reason: optionalString(body.reason),
    audience: body.audience === undefined ? undefined : coerceSpeakAudience(body.audience),
    channel: body.channel === undefined ? undefined : coerceSpeakChannel(body.channel),
    mode: body.mode === undefined ? undefined : coerceSpeakMode(body.mode),
    contentTypes: optionalSpeakContentTypes(body.contentTypes),
    tone: body.tone === undefined ? undefined : coerceSpeakTone(body.tone),
    detailLevel: optionalSpeakDetailLevel(body.detailLevel),
    language: optionalSpeakLanguage(body.language),
    locale: optionalString(body.locale),
    identity: body.identity === undefined ? undefined : coerceSpeakIdentity(body.identity),
    sourcePolicy: optionalSpeakSourcePolicy(body.sourcePolicy),
    safetyPolicy: optionalSpeakSafetyPolicy(body.safetyPolicy),
    requiresApprovalBeforeDelivery: optionalBoolean(body.requiresApprovalBeforeDelivery)
  };
}

/**
 * 从 unknown 中读取 SpeakContentType 数组。
 *
 * 使用方法：
 * - speakPlanInputFromBody 处理 contentTypes 时调用。
 *
 * 作用：
 * - 允许调用方声明 markdown、json、draft_message 等内容形态。
 * - 自动过滤空数组；非法类型会抛错。
 */
function optionalSpeakContentTypes(value: unknown): CreateSpeakPlanInput["contentTypes"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw createHttpError("contentTypes must be an array.");
  return value.map((item) => coerceSpeakContentType(item));
}

/**
 * 从 unknown 中读取 SpeakPlan 详细程度。
 *
 * 使用方法：
 * - speakPlanInputFromBody 处理 detailLevel 时调用。
 *
 * 作用：
 * - 保证详细程度只会是 brief、normal 或 detailed。
 */
function optionalSpeakDetailLevel(value: unknown): SpeakPlan["detailLevel"] | undefined {
  if (value === undefined) return undefined;
  if (value === "brief" || value === "normal" || value === "detailed") return value;
  throw createHttpError("detailLevel must be brief, normal, or detailed.");
}

/**
 * 从 unknown 中读取 SpeakPlan 语言。
 *
 * 使用方法：
 * - speakPlanInputFromBody 处理 language 时调用。
 *
 * 作用：
 * - 保证表达语言只会是 zh-CN、en 或 mixed。
 */
function optionalSpeakLanguage(value: unknown): SpeakPlan["language"] | undefined {
  if (value === undefined) return undefined;
  if (value === "zh-CN" || value === "en" || value === "mixed") return value;
  throw createHttpError("language must be zh-CN, en, or mixed.");
}

/**
 * 从 unknown 中读取 SpeakMessage 格式。
 *
 * 使用方法：
 * - /api/speak/compose 处理 format 时调用。
 *
 * 作用：
 * - 保证输出格式只会是 text、markdown、json 或 yaml。
 */
function optionalSpeakFormat(value: unknown): SpeakMessage["format"] | undefined {
  if (value === undefined) return undefined;
  if (value === "text" || value === "markdown" || value === "json" || value === "yaml") return value;
  throw createHttpError("format must be text, markdown, json, or yaml.");
}

/**
 * 从 unknown 中读取 SpeakSourcePolicy。
 *
 * 使用方法：
 * - speakPlanInputFromBody 处理 sourcePolicy 时调用。
 *
 * 作用：
 * - 允许 API 调用方覆盖是否引用本地文件、网页来源和未验证警告。
 */
function optionalSpeakSourcePolicy(value: unknown): Partial<SpeakSourcePolicy> | undefined {
  const policy = optionalJsonObject(value);
  if (!policy) return undefined;
  return {
    citeLocalFiles: optionalBoolean(policy.citeLocalFiles),
    citeWebSources: optionalBoolean(policy.citeWebSources),
    distinguishFactsFromInferences: optionalBoolean(policy.distinguishFactsFromInferences),
    includeUnverifiedWarning: optionalBoolean(policy.includeUnverifiedWarning)
  };
}

/**
 * 从 unknown 中读取 SpeakSafetyPolicy。
 *
 * 使用方法：
 * - speakPlanInputFromBody 处理 safetyPolicy 时调用。
 *
 * 作用：
 * - 允许 API 调用方显式调整脱敏、草稿标签和外部承诺策略。
 */
function optionalSpeakSafetyPolicy(value: unknown): Partial<SpeakSafetyPolicy> | undefined {
  const policy = optionalJsonObject(value);
  if (!policy) return undefined;
  return {
    redactSecrets: optionalBoolean(policy.redactSecrets),
    redactPrivateData: optionalBoolean(policy.redactPrivateData),
    avoidExternalCommitment: optionalBoolean(policy.avoidExternalCommitment),
    avoidFalseExecutionClaim: optionalBoolean(policy.avoidFalseExecutionClaim),
    requireDraftLabel: optionalBoolean(policy.requireDraftLabel)
  };
}

/**
 * 从 unknown 中读取 SpeakSourceRef 数组。
 *
 * 使用方法：
 * - /api/speak/compose 处理 sourceRefs 时调用。
 *
 * 作用：
 * - 让表达内容可以带上工具结果、记忆、上下文块或推断来源。
 */
function optionalSpeakSourceRefs(value: unknown): SpeakSourceRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw createHttpError("sourceRefs must be an array.");
  return value.map((item) => coerceSpeakSourceRef(item));
}

/**
 * 从调试 API 请求体运行一次 Agent Core 决策，可选执行一次 read round。
 *
 * 使用方法：
 * - POST /api/core/decide 传入 content、可选 sessionId、locale 和 executeReadRound。
 * - executeReadRound=false 时只返回第一次判断，适合检查是否会选择 read_context。
 * - executeReadRound=true 时，如果第一次 route 是 read，会执行一次 ReadPlan 并返回第二次最终判断。
 *
 * 作用：
 * - 为开发、测试和未来调试 UI 提供不创建聊天消息的 Agent Core 入口。
 * - 复用正式 Listen、Read、Agent Core、store 和 audit 链路。
 *
 * 边界：
 * - 不自动调用手或脚。
 * - 不创建 assistant message；用户可见表达仍由正式 processUserMessage() 负责。
 */
async function decideAgentCoreFromBody(body: JsonObject): Promise<JsonObject> {
  const content = optionalString(body.content) || optionalString(body.rawText);
  if (!content) {
    throw createHttpError("Agent Core decide requires content.");
  }
  const sessionId = optionalString(body.sessionId) || "core-debug";
  const locale = optionalString(body.locale) || "zh-CN";
  const recentMessages = await getRecentMessages(sessionId, 30);
  const listenAnalysis = await analyzeAndRecordListenEvent(
    {
      kind: "user_text",
      channelId: "core-api",
      sessionId,
      locale,
      rawText: content,
      sourceLabel: "Agent Core API"
    },
    recentMessages
  );
  const config = await loadConfig();
  const pendingToolRuns = (await listToolRuns(sessionId)).filter((run) =>
    ["pending", "approved", "running"].includes(run.status)
  );
  const coreResults: AgentCoreResult[] = [];
  let contextBlocks: ContextBlock[] = [];
  let readResults: ReadResult[] = [];

  try {
    const firstResult = await decideNextStep(
      createAgentCoreInput({
        sessionId,
        userMessageId: optionalString(body.messageId) || `core-api-${listenAnalysis.result.id}`,
        userText: content,
        locale,
        listenResult: listenAnalysis.result,
        recentMessages,
        pendingToolRuns,
        config
      })
    );
    coreResults.push(firstResult);
    let finalResult = firstResult;

    if (
      optionalBoolean(body.executeReadRound) === true &&
      firstResult.route.capability === "read" &&
      firstResult.route.mode === "execute" &&
      firstResult.policyGate.allowed &&
      firstResult.decision.readPlan
    ) {
      let readFailure: string | undefined;
      try {
        const output = await executeAndRecordReadPlan(firstResult.decision.readPlan, config);
        contextBlocks = output.contextBlocks;
        readResults = output.results;
      } catch (error) {
        readFailure = error instanceof Error ? error.message : String(error);
      }

      finalResult = await decideNextStep(
        createAgentCoreInput({
          sessionId,
          userMessageId: optionalString(body.messageId) || `core-api-${listenAnalysis.result.id}`,
          userText: content,
          locale,
          listenResult: listenAnalysis.result,
          recentMessages,
          contextBlocks,
          pendingToolRuns,
          config,
          readAttempted: true,
          readFailure
        })
      );
      coreResults.push(finalResult);
    }

    return {
      listenEvent: listenAnalysis.event,
      listenResult: listenAnalysis.result,
      agentCoreResult: finalResult,
      agentCoreResults: coreResults,
      contextBlocks,
      readResults
    };
  } catch (error) {
    await recordAgentCoreFailure(sessionId, error);
    throw error;
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const unsafePath = decodeURIComponent(url.pathname);
  const relativePath = unsafePath === "/" ? "index.html" : unsafePath.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/api/health") {
    const config = await loadConfig();
    sendJson(res, 200, {
      ok: true,
      app: config.app.name,
      provider: config.model.provider,
      model: config.model.model
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, maskConfig(await loadConfig()));
    return;
  }

  if (method === "POST" && url.pathname === "/api/config/test") {
    const config = await loadConfig();
    validateModelConfig(config);
    const startedAt = Date.now();
    if (config.model.provider === "echo") {
      sendJson(res, 200, {
        ok: true,
        provider: "echo",
        model: "local-echo",
        latencyMs: Date.now() - startedAt,
        message: "Echo provider is available locally; no external model was contacted."
      });
      return;
    }
    const completion = await completeChat(
      config,
      [
        {
          role: "system",
          content: "This is a connection test. Reply with a short confirmation and do not request tools."
        },
        {
          role: "user",
          content: "Confirm that the model endpoint is reachable."
        }
      ],
      "en-US"
    );
    sendJson(res, 200, {
      ok: true,
      provider: completion.provider,
      model: completion.model,
      latencyMs: Date.now() - startedAt,
      message: completion.content.slice(0, 500)
    });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const body = await readBody(req);
    const current = await loadConfig();
    const provider = coerceModelProvider(body.provider, current.model.provider);
    const apiKeyInput = body.apiKey === undefined ? "" : String(body.apiKey);
    const hasNewApiKey = Boolean(apiKeyInput) && !isMaskedApiKey(apiKeyInput);
    const nextConfig: AppConfig = structuredClone(current);
    nextConfig.model.provider = provider;
    if (body.baseUrl !== undefined) nextConfig.model.baseUrl = String(body.baseUrl).trim();
    if (body.model !== undefined) nextConfig.model.model = String(body.model).trim();
    if (body.temperature !== undefined) nextConfig.model.temperature = Number(body.temperature);
    if (hasNewApiKey) nextConfig.model.apiKey = apiKeyInput;
    validateModelConfig(nextConfig);

    const patch: DeepPartial<AppConfig> = { model: {}, security: {} };
    patch.model!.provider = nextConfig.model.provider;
    patch.model!.baseUrl = nextConfig.model.baseUrl;
    patch.model!.model = nextConfig.model.model;
    patch.model!.temperature = nextConfig.model.temperature;
    if (hasNewApiKey) patch.model!.apiKey = apiKeyInput;
    if (body.autoRunReadTools !== undefined) {
      patch.security!.autoRunReadTools = Boolean(body.autoRunReadTools);
    }
    await saveLocalConfig(patch);
    sendJson(res, 200, maskConfig(await loadConfig()));
    return;
  }

  if (method === "GET" && url.pathname === "/api/sessions") {
    sendJson(res, 200, await listSessions());
    return;
  }

  if (method === "POST" && url.pathname === "/api/sessions") {
    const body = await readBody(req);
    sendJson(res, 201, await createSession(typeof body.title === "string" ? body.title : "New session"));
    return;
  }

  if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
    const sessionId = parts[2];
    if (!sessionId) {
      sendJson(res, 404, { error: "Session not found." });
      return;
    }
    if (method === "GET" && parts.length === 3) {
      const session = await getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    if (method === "DELETE" && parts.length === 3) {
      sendJson(res, 200, { deleted: await deleteSession(sessionId) });
      return;
    }

    if (method === "POST" && parts[3] === "messages") {
      const body = await readBody(req);
      if (!body.content || !String(body.content).trim()) {
        sendJson(res, 400, { error: "Message content is required." });
        return;
      }
      sendJson(res, 201, await processUserMessage(sessionId, String(body.content), String(body.locale || "zh-CN")));
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/tool-runs") {
    sendJson(res, 200, await listToolRuns(url.searchParams.get("sessionId")));
    return;
  }

  if (method === "POST" && url.pathname === "/api/core/decide") {
    sendJson(res, 201, await decideAgentCoreFromBody(await readBody(req)));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/agent-core-results" || url.pathname === "/api/core/results")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listAgentCoreResults(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/agent-decisions" || url.pathname === "/api/core/decisions")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listAgentDecisions(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/policy-gate-results" || url.pathname === "/api/core/policy-gates")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listPolicyGateResults(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/capability-routes" || url.pathname === "/api/core/routes")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listCapabilityRoutes(limit));
    return;
  }

  if (method === "POST" && url.pathname === "/api/read/plan") {
    const body = await readBody(req);
    sendJson(res, 201, readPlanFromBody(body, await loadConfig()));
    return;
  }

  if (method === "POST" && url.pathname === "/api/read/execute") {
    const body = await readBody(req);
    const config = await loadConfig();
    const plan = readPlanFromBody(body, config);
    sendJson(res, 200, await executeAndRecordReadPlan(plan, config));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/read-events" || url.pathname === "/api/read/events")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listReadEvents(limit));
    return;
  }

  if (method === "POST" && url.pathname === "/api/listen/analyze") {
    const body = await readBody(req);
    const rawText = optionalString(body.rawText) || optionalString(body.content);
    sendJson(
      res,
      201,
      await analyzeAndRecordListenEvent({
        kind: optionalListenEventKind(body.kind),
        channelId: optionalString(body.channelId) || "api",
        sessionId: optionalString(body.sessionId),
        userId: optionalString(body.userId),
        locale: optionalString(body.locale),
        rawText,
        payload: optionalJsonObject(body.payload),
        sourceLabel: optionalString(body.sourceLabel) || "Listen API",
        privacyLevel: optionalListenPrivacyLevel(body.privacyLevel),
        trust: optionalListenTrust(body.trust)
      })
    );
    return;
  }

  if (method === "GET" && (url.pathname === "/api/listen-events" || url.pathname === "/api/listen/events")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listListenEvents(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/listen-results" || url.pathname === "/api/listen/results")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listListenResults(limit));
    return;
  }

  if (method === "POST" && url.pathname === "/api/speak/plan") {
    const body = await readBody(req);
    sendJson(res, 201, createSpeakPlan(speakPlanInputFromBody(body)));
    return;
  }

  if (method === "POST" && url.pathname === "/api/speak/compose") {
    const body = await readBody(req);
    const content = optionalString(body.content);
    if (!content) {
      throw createHttpError("Speak compose requires content.");
    }
    sendJson(
      res,
      201,
      await createAndRecordSpeakInteraction({
        ...speakPlanInputFromBody(body),
        sessionId: optionalString(body.sessionId),
        title: optionalString(body.title),
        content,
        format: optionalSpeakFormat(body.format),
        sourceRefs: optionalSpeakSourceRefs(body.sourceRefs),
        assumptions: optionalStringArray(body.assumptions),
        uncertaintyFlags: optionalStringArray(body.uncertaintyFlags),
        riskFlags: optionalStringArray(body.riskFlags),
        draft: optionalBoolean(body.draft)
      })
    );
    return;
  }

  if (method === "GET" && (url.pathname === "/api/speak-plans" || url.pathname === "/api/speak/plans")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listSpeakPlans(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/speak-messages" || url.pathname === "/api/speak/messages")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listSpeakMessages(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/speak-results" || url.pathname === "/api/speak/results")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listSpeakResults(limit));
    return;
  }

  if (method === "POST" && url.pathname === "/api/hand/plan") {
    const body = await readBody(req);
    sendJson(res, 201, createHandPlan(handPlanInputFromBody(body)));
    return;
  }

  if (method === "POST" && url.pathname === "/api/hand/preview") {
    const body = await readBody(req);
    const config = await loadConfig();
    sendJson(res, 201, await createHandPreview(handPlanFromBody(body), config));
    return;
  }

  if (method === "POST" && url.pathname === "/api/hand/apply") {
    const body = await readBody(req);
    const plan = handPlanFromBody(body);
    const preview = optionalJsonObject(body.preview);
    if (!preview) {
      throw createHttpError("Hand apply requires preview.");
    }
    sendJson(
      res,
      200,
      await recordHandResult(
        await applyHandPlan(plan, coerceHandPreviewFromBody(preview), handApplyOptionsFromBody(body), await loadConfig())
      )
    );
    return;
  }

  if (method === "POST" && url.pathname === "/api/hand/execute") {
    const body = await readBody(req);
    const config = await loadConfig();
    sendJson(res, 200, await executeAndRecordHandPlan(handPlanFromBody(body), handApplyOptionsFromBody(body), config));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/hand-plans" || url.pathname === "/api/hand/plans")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listHandPlans(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/hand-previews" || url.pathname === "/api/hand/previews")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listHandPreviews(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/hand-results" || url.pathname === "/api/hand/results")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listHandResults(limit));
    return;
  }

  if (method === "POST" && url.pathname === "/api/foot/plan") {
    const body = await readBody(req);
    sendJson(res, 201, createFootPlan(footPlanInputFromBody(body)));
    return;
  }

  if (method === "POST" && url.pathname === "/api/foot/preview") {
    const body = await readBody(req);
    const config = await loadConfig();
    sendJson(res, 201, await createFootPreview(footPlanFromBody(body), config));
    return;
  }

  if (method === "POST" && url.pathname === "/api/foot/execute") {
    const body = await readBody(req);
    const config = await loadConfig();
    sendJson(res, 200, await executeAndRecordFootPlan(footPlanFromBody(body), footExecutionOptionsFromBody(body), config));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/foot-plans" || url.pathname === "/api/foot/plans")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listFootPlans(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/foot-previews" || url.pathname === "/api/foot/previews")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listFootPreviews(limit));
    return;
  }

  if (method === "GET" && (url.pathname === "/api/foot-results" || url.pathname === "/api/foot/results")) {
    const limit = optionalPositiveNumber(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, await listFootResults(limit));
    return;
  }

  if (parts[0] === "api" && parts[1] === "tool-runs" && parts[2]) {
    const runId = parts[2];
    if (!runId) {
      sendJson(res, 404, { error: "Tool run not found." });
      return;
    }
    if (method === "POST" && parts[3] === "approve") {
      const approved = await updateToolRun(
        runId,
        { status: "approved", approvedAt: new Date().toISOString() },
        "tool.approved"
      );
      if (!approved) {
        sendJson(res, 404, { error: "Tool run not found." });
        return;
      }
      sendJson(res, 200, await executeToolRun(runId));
      return;
    }

    if (method === "POST" && parts[3] === "reject") {
      const rejected = await updateToolRun(
        runId,
        { status: "rejected", completedAt: new Date().toISOString() },
        "tool.rejected"
      );
      if (!rejected) {
        sendJson(res, 404, { error: "Tool run not found." });
        return;
      }
      sendJson(res, 200, rejected);
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/audit") {
    sendJson(res, 200, await listAudit());
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.url?.startsWith("/api/")) {
      await routeApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    const httpError = error as HttpError;
    sendJson(res, httpError.statusCode || 500, {
      error: httpError.message || "Internal server error."
    });
  }
}

const cliArgs = parseArgs(process.argv);
const config = await loadConfig({ app: cliArgs });
const server = createServer(handleRequest);

server.listen(config.app.port, config.app.host, () => {
  const address = `http://${config.app.host}:${config.app.port}`;
  console.log(`${config.app.name} listening on ${address}`);
});
