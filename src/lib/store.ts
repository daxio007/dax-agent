import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId, nowIso } from "./ids.js";
import type {
  AgentCoreResult,
  AgentDecision,
  AuditRecord,
  CapabilityRoute,
  FootPlan,
  FootPreview,
  FootResult,
  HandPlan,
  HandPreview,
  HandResult,
  JsonObject,
  ListenEvent,
  ListenResult,
  Message,
  MessageRole,
  PolicyGateResult,
  ReadEvent,
  Session,
  SessionDetail,
  SessionSummary,
  SpeakMessage,
  SpeakPlan,
  SpeakResult,
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
    listenEvents: [],
    listenResults: [],
    speakPlans: [],
    speakMessages: [],
    speakResults: [],
    handPlans: [],
    handPreviews: [],
    handResults: [],
    footPlans: [],
    footPreviews: [],
    footResults: [],
    agentDecisions: [],
    policyGateResults: [],
    capabilityRoutes: [],
    agentCoreResults: [],
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

/**
 * 使用方法：在一次 store mutate 内保存具有 id 的 Agent Core 对象时调用。
 * 作用：同一个 id 再次写入时覆盖旧值，否则追加新值，避免调试 API 重放造成重复对象。
 * 边界：该 helper 只修改传入数组，不写磁盘、不创建审计记录，也不判断对象是否合法。
 */
function upsertById<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) {
    items[index] = value;
  } else {
    items.push(value);
  }
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
    store.agentDecisions = store.agentDecisions.filter((decision) => decision.sessionId !== sessionId);
    store.policyGateResults = store.policyGateResults.filter((result) => result.sessionId !== sessionId);
    store.capabilityRoutes = store.capabilityRoutes.filter((route) => route.sessionId !== sessionId);
    store.agentCoreResults = store.agentCoreResults.filter((result) => result.sessionId !== sessionId);
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

/**
 * 记录一次“耳朵”听到的输入事件和结构化理解结果。
 *
 * 使用方法：
 * - 用户消息、UI 控制事件、工具结果或未来 MCP 通知进入 Agent Core 前调用。
 * - 调用方传入已经生成好的 ListenEvent 和 ListenResult。
 * - 返回写入后的 event/result，方便 API 层或 Agent 层继续使用。
 *
 * 作用：
 * - 保留 Agent 听到了什么、如何理解、下一步建议是什么。
 * - 让后续调试、记忆沉淀和 Skill 唤醒可以复盘听力判断。
 */
export async function recordListenAnalysis(
  event: ListenEvent,
  result: ListenResult
): Promise<{ event: ListenEvent; result: ListenResult }> {
  return mutate((store) => {
    store.listenEvents.push(event);
    store.listenResults.push(result);
    store.audit.push({
      id: newId("aud"),
      type: "listen.analyzed",
      sessionId: event.sessionId,
      listenEventId: event.id,
      listenResultId: result.id,
      listenIntent: result.primaryIntent,
      riskFlags: result.riskFlags,
      createdAt: nowIso()
    });
    return { event, result };
  });
}

/**
 * 读取最近的“耳朵”输入事件。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以控制数量，例如 listListenEvents(20)。
 *
 * 作用：
 * - 给调试页、审计页和未来 Memory Policy 提供输入事件时间线。
 * - 事件中的 rawText 已由听能力模块做基础脱敏和截断。
 */
export async function listListenEvents(limit = 100): Promise<ListenEvent[]> {
  const store = await readStore();
  return store.listenEvents.slice(-limit).reverse();
}

/**
 * 读取最近的“耳朵”理解结果。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以查看更短或更长的听力分析历史。
 *
 * 作用：
 * - 展示 Agent 最近如何理解用户和环境信号。
 * - 帮助检查 intent、constraint、correction 和 contextNeed 是否判断正确。
 */
export async function listListenResults(limit = 100): Promise<ListenResult[]> {
  const store = await readStore();
  return store.listenResults.slice(-limit).reverse();
}

/**
 * 记录一次“嘴巴”表达计划、表达消息和表达结果。
 *
 * 使用方法：
 * - speak.ts 创建 SpeakPlan、SpeakMessage、SpeakResult 后调用。
 * - sessionId 可选；如果这次表达来自某个会话，应传入 sessionId 方便审计关联。
 * - 返回写入后的 plan/message/result，其中 result.auditId 会指向本次审计记录。
 *
 * 作用：
 * - 保留 Agent 对谁说、怎么说、是否草稿、风险标记是什么。
 * - 让未来 UI、Memory 和调试流程可以复盘表达链路。
 */
export async function recordSpeakInteraction(
  plan: SpeakPlan,
  message: SpeakMessage,
  result: SpeakResult,
  sessionId?: string
): Promise<{ plan: SpeakPlan; message: SpeakMessage; result: SpeakResult }> {
  return mutate((store) => {
    const auditId = newId("aud");
    const storedResult: SpeakResult = {
      ...result,
      auditId: result.auditId || auditId
    };
    store.speakPlans.push(plan);
    store.speakMessages.push(message);
    store.speakResults.push(storedResult);
    store.audit.push({
      id: auditId,
      type: storedResult.blockedReason ? "speak.blocked" : "speak.delivered",
      sessionId,
      speakPlanId: plan.id,
      speakMessageId: message.id,
      speakResultId: storedResult.id,
      speakMode: plan.mode,
      speakAudience: plan.audience,
      speakChannel: plan.channel,
      speakDraft: message.draft,
      riskFlags: message.riskFlags,
      createdAt: nowIso()
    });
    return { plan, message, result: storedResult };
  });
}

/**
 * 读取最近的“嘴巴”表达计划。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以控制数量，例如 listSpeakPlans(20)。
 *
 * 作用：
 * - 给调试页和审计页展示 Agent 最近为什么准备表达。
 * - 帮助检查受众、Channel、模式和审批边界是否正确。
 */
export async function listSpeakPlans(limit = 100): Promise<SpeakPlan[]> {
  const store = await readStore();
  return store.speakPlans.slice(-limit).reverse();
}

/**
 * 读取最近的“嘴巴”表达消息。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以查看更短或更长的表达历史。
 *
 * 作用：
 * - 展示 Agent 实际准备展示或作为草稿输出的内容。
 * - 方便检查草稿标签、来源引用、不确定性和风险标记。
 */
export async function listSpeakMessages(limit = 100): Promise<SpeakMessage[]> {
  const store = await readStore();
  return store.speakMessages.slice(-limit).reverse();
}

/**
 * 读取最近的“嘴巴”表达结果。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 传入 limit 可以控制返回数量。
 *
 * 作用：
 * - 展示表达是否已交给本地 Channel、是否被阻止，以及是否只是外部投递候选。
 * - 明确嘴巴的 externalDelivery 永远不是外部发送完成记录。
 */
export async function listSpeakResults(limit = 100): Promise<SpeakResult[]> {
  const store = await readStore();
  return store.speakResults.slice(-limit).reverse();
}

/**
 * 记录一次“手”修改计划，并写入审计日志。
 *
 * 使用方法：
 * - hand.ts 创建 HandPlan 后调用 recordHandPlan(plan)。
 * - 如果同一个 plan id 已经存在，会覆盖旧内容，方便 API plan -> preview -> apply 流程复用。
 *
 * 作用：
 * - 保存“准备修改什么、为什么修改、风险等级和是否需要审批”。
 * - 明确计划不是修改结果，不能据此声称文件或外部对象已经被改变。
 */
export async function recordHandPlan(plan: HandPlan): Promise<HandPlan> {
  return mutate((store) => {
    const index = store.handPlans.findIndex((item) => item.id === plan.id);
    if (index >= 0) {
      store.handPlans[index] = plan;
    } else {
      store.handPlans.push(plan);
    }
    store.audit.push({
      id: newId("aud"),
      type: "hand.planned",
      handPlanId: plan.id,
      handRiskLevel: plan.riskLevel,
      riskFlags: plan.requiresApproval ? ["requires_user_confirmation"] : [],
      approvalRequired: plan.requiresApproval,
      createdAt: nowIso()
    });
    return plan;
  });
}

/**
 * 记录一次“手”修改预览，并写入审计日志。
 *
 * 使用方法：
 * - hand.ts 生成 HandPreview 后调用 recordHandPreview(preview)。
 * - 如果同一个 preview id 已经存在，会覆盖旧内容。
 *
 * 作用：
 * - 保存 diff、受影响目标、风险标记、是否可回滚和审批要求。
 * - 让用户、大脑和未来记忆系统可以复盘动手前看到了什么。
 */
export async function recordHandPreview(preview: HandPreview): Promise<HandPreview> {
  return mutate((store) => {
    const index = store.handPreviews.findIndex((item) => item.id === preview.id);
    if (index >= 0) {
      store.handPreviews[index] = preview;
    } else {
      store.handPreviews.push(preview);
    }
    store.audit.push({
      id: newId("aud"),
      type: "hand.previewed",
      handPlanId: preview.planId,
      handPreviewId: preview.id,
      handRiskLevel: preview.riskLevel,
      riskFlags: preview.riskFlags,
      approvalRequired: preview.requiresApproval,
      createdAt: nowIso()
    });
    return preview;
  });
}

/**
 * 记录一次“手”修改结果，并写入审计日志。
 *
 * 使用方法：
 * - apply、reject、fail 或 dry run 后调用 recordHandResult(result)。
 * - 返回值会补上 auditId，供嘴巴和 UI 引用。
 *
 * 作用：
 * - 保存真实修改结果、应用的 diff、变更目标和回滚可用性。
 * - 只有 status 为 applied 的 HandResult 才表示对象真的被修改。
 */
export async function recordHandResult(result: HandResult): Promise<HandResult> {
  return mutate((store) => {
    const auditId = result.auditId || newId("aud");
    const storedResult: HandResult = {
      ...result,
      auditId
    };
    const index = store.handResults.findIndex((item) => item.id === storedResult.id);
    if (index >= 0) {
      store.handResults[index] = storedResult;
    } else {
      store.handResults.push(storedResult);
    }
    store.audit.push({
      id: auditId,
      type: `hand.${storedResult.status}`,
      handPlanId: storedResult.planId,
      handPreviewId: storedResult.previewId,
      handResultId: storedResult.id,
      status: storedResult.status === "applied" ? "completed" : "failed",
      createdAt: nowIso()
    });
    return storedResult;
  });
}

/**
 * 读取最近的“手”修改计划。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 调试页、审计页或 API 可以传入 limit 缩小返回数量。
 *
 * 作用：
 * - 展示 Agent 最近准备修改的对象和风险等级。
 * - 帮助确认修改没有绕过 HandPlan。
 */
export async function listHandPlans(limit = 100): Promise<HandPlan[]> {
  const store = await readStore();
  return store.handPlans.slice(-limit).reverse();
}

/**
 * 读取最近的“手”修改预览。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 用于 UI 或调试流程查看 diff 和风险标记。
 *
 * 作用：
 * - 展示手在修改前准备改什么。
 * - 帮助确认所有写入都有 preview。
 */
export async function listHandPreviews(limit = 100): Promise<HandPreview[]> {
  const store = await readStore();
  return store.handPreviews.slice(-limit).reverse();
}

/**
 * 读取最近的“手”修改结果。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 嘴巴、UI 或审计页可以用它确认修改是否 applied、rejected、failed 或 skipped。
 *
 * 作用：
 * - 展示真实修改历史。
 * - 为未来 Agent Core 的反思、回滚和 Skill 沉淀提供依据。
 */
export async function listHandResults(limit = 100): Promise<HandResult[]> {
  const store = await readStore();
  return store.handResults.slice(-limit).reverse();
}

/**
 * 记录一次“脚”执行计划，并写入审计日志。
 *
 * 使用方法：
 * - foot.ts 创建 FootPlan 后调用 recordFootPlan(plan)。
 * - 如果同一个 plan id 已经存在，会用新内容覆盖旧内容，避免 API plan -> preview -> execute 流程重复记录。
 *
 * 作用：
 * - 保留 Agent 准备运行什么命令、为什么运行、风险等级和审批要求。
 * - 明确计划本身不是执行结果，只有后续 FootResult 才能证明命令真的运行过。
 */
export async function recordFootPlan(plan: FootPlan): Promise<FootPlan> {
  return mutate((store) => {
    const index = store.footPlans.findIndex((item) => item.id === plan.id);
    if (index >= 0) {
      store.footPlans[index] = plan;
    } else {
      store.footPlans.push(plan);
    }
    store.audit.push({
      id: newId("aud"),
      type: "foot.planned",
      footPlanId: plan.id,
      footRiskLevel: plan.riskLevel,
      riskFlags: plan.requiresApproval ? ["requires_user_confirmation"] : [],
      approvalRequired: plan.requiresApproval,
      createdAt: nowIso()
    });
    return plan;
  });
}

/**
 * 记录一次“脚”执行预览，并写入审计日志。
 *
 * 使用方法：
 * - foot.ts 生成 FootPreview 后调用 recordFootPreview(preview)。
 * - 如果同一个 preview id 已存在，会覆盖旧内容，便于 API 重放同一预览。
 *
 * 作用：
 * - 保存命令、cwd、timeout、风险标记和是否需要审批。
 * - 让用户和未来大脑可以复盘“执行前系统看到了什么风险”。
 */
export async function recordFootPreview(preview: FootPreview): Promise<FootPreview> {
  return mutate((store) => {
    const index = store.footPreviews.findIndex((item) => item.id === preview.id);
    if (index >= 0) {
      store.footPreviews[index] = preview;
    } else {
      store.footPreviews.push(preview);
    }
    store.audit.push({
      id: newId("aud"),
      type: "foot.previewed",
      footPlanId: preview.planId,
      footPreviewId: preview.id,
      footRiskLevel: preview.riskLevel,
      riskFlags: preview.riskFlags,
      approvalRequired: preview.requiresApproval,
      createdAt: nowIso()
    });
    return preview;
  });
}

/**
 * 记录一次“脚”执行结果，并写入审计日志。
 *
 * 使用方法：
 * - 命令完成、失败、超时、被拒绝或 dry run 跳过后调用 recordFootResult(result)。
 * - 返回值会补上 auditId，供嘴巴或 UI 引用。
 *
 * 作用：
 * - 保存真实执行结果，包括状态、输出、错误、耗时和命令结果。
 * - 只有 status 为 completed 的 FootResult 才表示脚真的成功走完一次执行。
 */
export async function recordFootResult(result: FootResult): Promise<FootResult> {
  return mutate((store) => {
    const auditId = result.auditId || newId("aud");
    const storedResult: FootResult = {
      ...result,
      auditId
    };
    const index = store.footResults.findIndex((item) => item.id === storedResult.id);
    if (index >= 0) {
      store.footResults[index] = storedResult;
    } else {
      store.footResults.push(storedResult);
    }
    store.audit.push({
      id: auditId,
      type: `foot.${storedResult.status}`,
      footPlanId: storedResult.planId,
      footPreviewId: storedResult.previewId,
      footResultId: storedResult.id,
      status: storedResult.status === "completed" ? "completed" : "failed",
      createdAt: nowIso()
    });
    return storedResult;
  });
}

/**
 * 读取最近的“脚”执行计划。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 调试页、审计页或 API 可以传入 limit 缩小返回数量。
 *
 * 作用：
 * - 展示 Agent 最近准备运行的命令计划。
 * - 帮助检查风险等级和审批要求是否合理。
 */
export async function listFootPlans(limit = 100): Promise<FootPlan[]> {
  const store = await readStore();
  return store.footPlans.slice(-limit).reverse();
}

/**
 * 读取最近的“脚”执行预览。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 用于 UI 或调试流程查看命令执行前的风险说明。
 *
 * 作用：
 * - 展示命令、cwd、timeout、风险标记和是否需要审批。
 * - 帮助确认脚没有绕过 preview 直接运行。
 */
export async function listFootPreviews(limit = 100): Promise<FootPreview[]> {
  const store = await readStore();
  return store.footPreviews.slice(-limit).reverse();
}

/**
 * 读取最近的“脚”执行结果。
 *
 * 使用方法：
 * - 默认返回最近 100 条。
 * - 嘴巴、UI 或审计页可以用它查看命令是否成功、失败、超时或被拒绝。
 *
 * 作用：
 * - 展示真实执行历史。
 * - 为未来 Agent Core 的反思和下一步判断提供过程结果。
 */
export async function listFootResults(limit = 100): Promise<FootResult[]> {
  const store = await readStore();
  return store.footResults.slice(-limit).reverse();
}

/**
 * 记录一个独立的 AgentDecision。
 *
 * 使用方法：
 * - 调试工具、迁移脚本或未来分步式 Agent Core 可以在只有决策对象时调用。
 * - 正常的一次完整大脑决策优先调用 recordAgentCoreResult()，它会原子记录决策、策略和路由。
 *
 * 作用：
 * - 保存大脑选择了什么下一步、为什么选择、来源是规则、模型还是 fallback。
 * - 同时写入 agent.decision.created 审计事件。
 *
 * 边界：
 * - 记录决策不代表对应能力已经执行。
 * - 该方法不会调用读、说、手、脚或模型。
 */
export async function recordAgentDecision(decision: AgentDecision): Promise<AgentDecision> {
  return mutate((store) => {
    upsertById(store.agentDecisions, decision);
    store.audit.push({
      id: newId("aud"),
      type: "agent.decision.created",
      sessionId: decision.sessionId,
      agentDecisionId: decision.id,
      agentDecisionType: decision.type,
      agentDecisionSource: decision.source,
      createdAt: nowIso()
    });
    return decision;
  });
}

/**
 * 读取最近的 AgentDecision。
 *
 * 使用方法：
 * - API、调试页和未来反思流程调用 listAgentDecisions(limit)。
 * - 默认返回最近 100 条，结果按时间倒序排列。
 *
 * 作用：
 * - 展示大脑最近选择了回答、追问、读取、暂停还是提出行动建议。
 *
 * 边界：
 * - 返回的是决策历史，不等同于能力执行历史。
 */
export async function listAgentDecisions(limit = 100): Promise<AgentDecision[]> {
  const store = await readStore();
  return store.agentDecisions.slice(-limit).reverse();
}

/**
 * 记录一个独立的 PolicyGateResult。
 *
 * 使用方法：
 * - 调试工具或未来分步式策略检查器可以单独调用。
 * - 正常完整流程优先使用 recordAgentCoreResult()。
 *
 * 作用：
 * - 保存某个决策是否被允许、风险等级、需要的审批和被阻止的能力。
 * - 同时写入 agent.policy.checked 审计事件。
 *
 * 边界：
 * - Policy Gate 允许 proposal 不代表允许 hand apply 或 foot execute。
 * - 该方法只记录检查结果，不执行审批或能力调用。
 */
export async function recordPolicyGateResult(result: PolicyGateResult): Promise<PolicyGateResult> {
  return mutate((store) => {
    upsertById(store.policyGateResults, result);
    store.audit.push({
      id: newId("aud"),
      type: "agent.policy.checked",
      sessionId: result.sessionId,
      policyGateResultId: result.id,
      agentDecisionType: result.decisionType,
      agentRiskLevel: result.risk,
      approvalRequired: result.requiredApprovals.length > 0,
      riskFlags: result.blockedCapabilities,
      createdAt: nowIso()
    });
    return result;
  });
}

/**
 * 读取最近的 Policy Gate 检查结果。
 *
 * 使用方法：
 * - API、审计页和调试页调用 listPolicyGateResults(limit)。
 * - 默认返回最近 100 条，结果按时间倒序排列。
 *
 * 作用：
 * - 解释某个大脑决策为什么被允许、阻止或要求审批。
 */
export async function listPolicyGateResults(limit = 100): Promise<PolicyGateResult[]> {
  const store = await readStore();
  return store.policyGateResults.slice(-limit).reverse();
}

/**
 * 记录一个独立的能力路由。
 *
 * 使用方法：
 * - 未来分步式调度器在已经有 CapabilityRoute、但尚未组装完整 AgentCoreResult 时调用。
 * - 正常完整流程优先使用 recordAgentCoreResult()。
 *
 * 作用：
 * - 保存决策最终被路由到 read、speak、hand、foot、memory、skill 或 none。
 *
 * 边界：
 * - route.mode 为 execute 也只表示调度意图；真实能力结果仍由对应 capability 记录。
 */
export async function recordCapabilityRoute(route: CapabilityRoute): Promise<CapabilityRoute> {
  return mutate((store) => {
    upsertById(store.capabilityRoutes, route);
    store.audit.push({
      id: newId("aud"),
      type: "agent.route.created",
      sessionId: route.sessionId,
      agentDecisionId: route.decisionId,
      capabilityRouteId: route.id,
      detail: `${route.capability}:${route.mode}`,
      createdAt: nowIso()
    });
    return route;
  });
}

/**
 * 读取最近的 Agent Core 能力路由。
 *
 * 使用方法：
 * - 调试页或未来调度可视化调用 listCapabilityRoutes(limit)。
 * - 默认返回最近 100 条。
 *
 * 作用：
 * - 展示大脑如何把抽象决策映射到具体能力。
 */
export async function listCapabilityRoutes(limit = 100): Promise<CapabilityRoute[]> {
  const store = await readStore();
  return store.capabilityRoutes.slice(-limit).reverse();
}

/**
 * 原子记录一次完整的 Agent Core 结果。
 *
 * 使用方法：
 * - core.ts 完成 WorkingMemory、AgentDecision、PolicyGate 和 CapabilityRoute 后调用。
 * - 同一个结果 id 被重放时会覆盖对象，但审计仍会留下本次记录轨迹。
 *
 * 作用：
 * - 在一次写入中保存完整大脑结果及其关联对象。
 * - 根据模型解析状态写入 model_reasoning completed/failed、decision、policy、route 和 core completed 审计。
 *
 * 边界：
 * - 该方法只记录大脑判断，不执行 route 指向的能力。
 * - 不保存 AgentCoreInput、模型 API key 或完整未过滤上下文。
 */
export async function recordAgentCoreResult(result: AgentCoreResult): Promise<AgentCoreResult> {
  return mutate((store) => {
    upsertById(store.agentDecisions, result.decision);
    upsertById(store.policyGateResults, result.policyGate);
    upsertById(store.capabilityRoutes, result.route);
    upsertById(store.agentCoreResults, result);

    if (result.modelReasoning) {
      store.audit.push({
        id: newId("aud"),
        type: result.modelReasoning.parseError
          ? "agent.core.model_reasoning.failed"
          : "agent.core.model_reasoning.completed",
        sessionId: result.sessionId,
        agentCoreResultId: result.id,
        agentDecisionId: result.decision.id,
        agentDecisionSource: result.decision.source,
        detail: result.modelReasoning.parseError || `${result.modelReasoning.provider}:${result.modelReasoning.model}`,
        createdAt: nowIso()
      });
    }

    store.audit.push(
      {
        id: newId("aud"),
        type: "agent.decision.created",
        sessionId: result.sessionId,
        agentCoreResultId: result.id,
        agentDecisionId: result.decision.id,
        agentDecisionType: result.decision.type,
        agentDecisionSource: result.decision.source,
        createdAt: nowIso()
      },
      {
        id: newId("aud"),
        type: "agent.policy.checked",
        sessionId: result.sessionId,
        agentCoreResultId: result.id,
        agentDecisionId: result.decision.id,
        policyGateResultId: result.policyGate.id,
        agentDecisionType: result.policyGate.decisionType,
        agentRiskLevel: result.policyGate.risk,
        approvalRequired: result.policyGate.requiredApprovals.length > 0,
        riskFlags: result.policyGate.blockedCapabilities,
        createdAt: nowIso()
      },
      {
        id: newId("aud"),
        type: "agent.route.created",
        sessionId: result.sessionId,
        agentCoreResultId: result.id,
        agentDecisionId: result.decision.id,
        capabilityRouteId: result.route.id,
        detail: `${result.route.capability}:${result.route.mode}`,
        createdAt: nowIso()
      },
      {
        id: newId("aud"),
        type: "agent.core.completed",
        sessionId: result.sessionId,
        agentCoreResultId: result.id,
        agentDecisionId: result.decision.id,
        policyGateResultId: result.policyGate.id,
        capabilityRouteId: result.route.id,
        agentDecisionType: result.decision.type,
        agentDecisionSource: result.decision.source,
        agentRiskLevel: result.policyGate.risk,
        createdAt: nowIso()
      }
    );
    return result;
  });
}

/**
 * 记录一次无法收敛为 AgentCoreResult 的大脑异常。
 *
 * 使用方法：
 * - processUserMessage() 或 /api/core/decide 捕获 core.ts 的意外异常后调用。
 * - detail 应传入已经适合审计的短错误信息。
 *
 * 作用：
 * - 即使大脑在生成结构化结果前失败，也保留 agent.core.failed 轨迹。
 *
 * 边界：
 * - 错误详情最多保存 1000 个字符。
 * - 该方法不处理异常，也不生成用户回复。
 */
export async function recordAgentCoreFailure(sessionId: string, detail: string): Promise<AuditRecord> {
  return mutate((store) => {
    const audit: AuditRecord = {
      id: newId("aud"),
      type: "agent.core.failed",
      sessionId,
      detail: detail.slice(0, 1000),
      createdAt: nowIso()
    };
    store.audit.push(audit);
    return audit;
  });
}

/**
 * 读取最近的完整 AgentCoreResult。
 *
 * 使用方法：
 * - API、调试页、未来反思和 Episode Store 调用 listAgentCoreResults(limit)。
 * - 默认返回最近 100 条，结果按时间倒序排列。
 *
 * 作用：
 * - 一次查看工作记忆、决策、策略、路由、模型解析状态和 warnings。
 */
export async function listAgentCoreResults(limit = 100): Promise<AgentCoreResult[]> {
  const store = await readStore();
  return store.agentCoreResults.slice(-limit).reverse();
}
