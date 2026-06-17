import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, maskConfig, saveLocalConfig } from "./lib/config.js";
import {
  createSession,
  deleteSession,
  getSession,
  listAudit,
  listListenEvents,
  listListenResults,
  listReadEvents,
  listSessions,
  listToolRuns,
  updateToolRun
} from "./lib/store.js";
import { processUserMessage } from "./lib/agent.js";
import { executeToolRun } from "./lib/tools.js";
import { coerceReadSource, createReadPlan, executeAndRecordReadPlan } from "./lib/read.js";
import { analyzeAndRecordListenEvent } from "./lib/listen.js";
import type { AppConfig, DeepPartial, JsonObject, ListenEventKind, ListenPrivacyLevel, ListenTrust, ReadPlan, ReadSource } from "./lib/types.js";

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

  if (method === "PUT" && url.pathname === "/api/config") {
    const body = await readBody(req);
    const patch: DeepPartial<AppConfig> = { model: {}, security: {} };
    if (body.provider) patch.model!.provider = String(body.provider);
    if (body.baseUrl !== undefined) patch.model!.baseUrl = String(body.baseUrl);
    if (body.model) patch.model!.model = String(body.model);
    if (body.temperature !== undefined) patch.model!.temperature = Number(body.temperature);
    if (body.apiKey !== undefined && body.apiKey !== "" && !String(body.apiKey).includes("*")) {
      patch.model!.apiKey = String(body.apiKey);
    }
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
