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
  listSessions,
  listToolRuns,
  updateToolRun
} from "./lib/store.js";
import { processUserMessage } from "./lib/agent.js";
import { executeToolRun } from "./lib/tools.js";
import type { AppConfig, DeepPartial, JsonObject } from "./lib/types.js";

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
