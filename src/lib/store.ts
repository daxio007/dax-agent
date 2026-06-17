import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId, nowIso } from "./ids.js";
import type {
  AuditRecord,
  JsonObject,
  Message,
  MessageRole,
  ReadEvent,
  Session,
  SessionDetail,
  SessionSummary,
  Store,
  ToolRun
} from "./types.js";

const dataDir = path.join(process.cwd(), "data");
const storePath = path.join(dataDir, "store.json");
let writeQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): Store {
  return {
    version: 1,
    sessions: [],
    messages: [],
    toolRuns: [],
    readEvents: [],
    audit: []
  };
}

async function readStore(): Promise<Store> {
  try {
    const raw = await readFile(storePath, "utf8");
    return { ...emptyStore(), ...JSON.parse(raw) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyStore();
    }
    throw error;
  }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${storePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmpPath, storePath);
}

async function mutate<T>(mutator: (store: Store) => T | Promise<T>): Promise<T> {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  return writeQueue as Promise<T>;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const store = await readStore();
  return store.sessions
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((session) => ({
      ...session,
      messageCount: store.messages.filter((message) => message.sessionId === session.id).length
    }));
}

export async function createSession(title = "New session"): Promise<Session> {
  return mutate((store) => {
    const session = {
      id: newId("ses"),
      title,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    store.sessions.push(session);
    store.audit.push({
      id: newId("aud"),
      type: "session.created",
      sessionId: session.id,
      createdAt: nowIso()
    });
    return session;
  });
}

export async function getSession(sessionId: string): Promise<SessionDetail | null> {
  const store = await readStore();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  return {
    ...session,
    messages: store.messages.filter((message) => message.sessionId === sessionId),
    toolRuns: store.toolRuns.filter((run) => run.sessionId === sessionId)
  };
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  return mutate((store) => {
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((session) => session.id !== sessionId);
    store.messages = store.messages.filter((message) => message.sessionId !== sessionId);
    store.toolRuns = store.toolRuns.filter((run) => run.sessionId !== sessionId);
    store.audit.push({
      id: newId("aud"),
      type: "session.deleted",
      sessionId,
      createdAt: nowIso()
    });
    return before !== store.sessions.length;
  });
}

export async function addMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  meta: JsonObject = {}
): Promise<Message> {
  return mutate((store) => {
    let session = store.sessions.find((item) => item.id === sessionId);
    if (!session) {
      session = {
        id: sessionId,
        title: "New session",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      store.sessions.push(session);
    }
    const message = {
      id: newId("msg"),
      sessionId,
      role,
      content,
      meta,
      createdAt: nowIso()
    };
    store.messages.push(message);
    session.updatedAt = nowIso();
    if (role === "user" && session.title === "New session") {
      session.title = content.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 70) || "New session";
    }
    return message;
  });
}

export async function getRecentMessages(sessionId: string, limit = 30): Promise<Message[]> {
  const store = await readStore();
  return store.messages
    .filter((message) => message.sessionId === sessionId)
    .slice(-limit);
}

export async function createToolRun(
  sessionId: string,
  messageId: string,
  tool: string,
  input: JsonObject,
  approvalRequired = true
): Promise<ToolRun> {
  return mutate((store) => {
    const run: ToolRun = {
      id: newId("run"),
      sessionId,
      messageId,
      tool,
      input,
      status: approvalRequired ? "pending" : "running",
      approvalRequired,
      output: "",
      error: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvedAt: null,
      completedAt: null
    };
    store.toolRuns.push(run);
    store.audit.push({
      id: newId("aud"),
      type: "tool.created",
      sessionId,
      toolRunId: run.id,
      tool,
      approvalRequired,
      createdAt: nowIso()
    });
    return run;
  });
}

export async function listToolRuns(sessionId: string | null = null): Promise<ToolRun[]> {
  const store = await readStore();
  return store.toolRuns
    .filter((run) => !sessionId || run.sessionId === sessionId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getToolRun(runId: string): Promise<ToolRun | null> {
  const store = await readStore();
  return store.toolRuns.find((run) => run.id === runId) || null;
}

export async function updateToolRun(
  runId: string,
  patch: Partial<ToolRun>,
  auditType = "tool.updated"
): Promise<ToolRun | null> {
  return mutate((store) => {
    const run = store.toolRuns.find((item) => item.id === runId);
    if (!run) return null;
    Object.assign(run, patch, { updatedAt: nowIso() });
    store.audit.push({
      id: newId("aud"),
      type: auditType,
      sessionId: run.sessionId,
      toolRunId: run.id,
      tool: run.tool,
      status: run.status,
      createdAt: nowIso()
    });
    return run;
  });
}

export async function listAudit(limit = 100): Promise<AuditRecord[]> {
  const store = await readStore();
  return store.audit.slice(-limit).reverse();
}

/**
 * 记录一次“眼睛”读取事件，并同时写入审计日志。
 *
 * 使用方法：
 * - 读取文件、网页、电脑配置或未来 MCP resource 后调用。
 * - 传入读取来源、读取原因、风险等级和风险标记。
 * - 返回带有 id 和 createdAt 的完整 ReadEvent，供上层和 UI 展示。
 *
 * 作用：
 * - 保留 Agent 看过什么、为什么看、风险如何的历史。
 * - 让后续 Memory、Skill 和调试流程可以复盘读取行为。
 */
export async function recordReadEvent(
  event: Omit<ReadEvent, "id" | "createdAt"> & Partial<Pick<ReadEvent, "id" | "createdAt">>
): Promise<ReadEvent> {
  return mutate((store) => {
    const readEvent: ReadEvent = {
      ...event,
      id: event.id || newId("rev"),
      createdAt: event.createdAt || nowIso()
    };
    store.readEvents.push(readEvent);
    store.audit.push({
      id: newId("aud"),
      type: readEvent.action,
      readEventId: readEvent.id,
      readSource: `${readEvent.source.kind}:${readEvent.source.target}`,
      riskLevel: readEvent.riskLevel,
      riskFlags: readEvent.riskFlags,
      createdAt: nowIso()
    });
    return readEvent;
  });
}

/**
 * 读取最近的“眼睛”事件。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以控制读取数量，例如 listReadEvents(20)。
 *
 * 作用：
 * - 给 UI、调试页、Memory 层提供“Agent 最近看过什么”的时间线。
 * - 不返回原始文件或网页内容，只返回读取来源、原因和风险标记。
 */
export async function listReadEvents(limit = 100): Promise<ReadEvent[]> {
  const store = await readStore();
  return store.readEvents.slice(-limit).reverse();
}
