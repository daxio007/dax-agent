import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadConfig, resolveWorkspace } from "./config.js";
import { newId, nowIso } from "./ids.js";
import { recordHandPlan, recordHandPreview, recordHandResult } from "./store.js";
import type {
  AppConfig,
  HandAction,
  HandActionKind,
  HandActionPreview,
  HandPlan,
  HandPreview,
  HandResult,
  HandRiskLevel,
  HandRollbackStrategy,
  HandTargetKind,
  JsonObject
} from "./types.js";

const LARGE_CHANGE_BYTES = 200000;
const LARGE_CHANGE_LINES = 600;

const handTargetKinds = new Set<HandTargetKind>([
  "workspace_file",
  "document",
  "config",
  "external_object",
  "database_record",
  "application_state",
  "browser_state",
  "clipboard",
  "message_draft"
]);

const handActionKinds = new Set<HandActionKind>([
  "create_file",
  "update_file",
  "delete_file",
  "move_file",
  "apply_patch",
  "append",
  "replace_range",
  "structured_update",
  "create_external_draft",
  "update_external_object",
  "update_database_record",
  "update_application_state"
]);

const handRiskLevels = new Set<HandRiskLevel>(["H0", "H1", "H2", "H3"]);

const supportedTargetKinds = new Set<HandTargetKind>(["workspace_file", "document", "config"]);
const supportedActionKinds = new Set<HandActionKind>(["create_file", "update_file", "apply_patch"]);

const secretLikeTargetPattern =
  /(^|[\\/])(\.env|config[\\/]local\.json|id_rsa|id_ed25519|\.ssh|cookies?|history|secrets?|tokens?|credentials?|private|\.pem|\.p12|\.kdbx)([\\/.]|$)/i;
const configLikeTargetPattern =
  /(^|[\\/])(\.env|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^\\/]*\.json|config[\\/].+\.json)([\\/.]|$)/i;
const secretLikeContentPatterns = [
  /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/
];

export interface CreateHandPlanInput {
  goal?: string;
  reason?: string;
  actions: unknown[];
  expectedOutcome?: string;
}

export interface ApplyHandPlanOptions {
  approved?: boolean;
  dryRun?: boolean;
}

export interface ExecuteHandPlanOutput {
  plan: HandPlan;
  preview: HandPreview;
  result: HandResult;
}

interface ResolvedHandTarget {
  action: HandAction;
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  riskFlags: string[];
}

interface ActionContentSnapshot {
  beforeText: string;
  afterText: string;
  beforeHash?: string;
  afterHash: string;
  beforeBytes: number;
  afterBytes: number;
  riskFlags: string[];
}

/**
 * 判断一个值是否普通 JSON 对象。
 *
 * 使用方法：
 * - 解析 API body、HandAction 或 HandPlan 候选对象前调用。
 *
 * 作用：
 * - 避免把 null、数组或字符串当成可读取字段的对象。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读取一个可选字符串字段。
 *
 * 使用方法：
 * - coerceHandAction 和 coerceHandPlan 从不可信 JSON 中读取字段时调用。
 *
 * 作用：
 * - 只接受真正的字符串，并自动裁剪首尾空白。
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 把不可信值收敛成手部动作类型。
 *
 * 使用方法：
 * - API 层、未来 Agent Core 或测试传入 kind 时调用。
 *
 * 作用：
 * - 确保动作类型只会落在 HandActionKind 定义的集合内。
 */
function coerceHandActionKind(value: unknown): HandActionKind {
  if (typeof value === "string" && handActionKinds.has(value as HandActionKind)) {
    return value as HandActionKind;
  }
  throw new Error("Hand action kind is not supported.");
}

/**
 * 把不可信值收敛成手部目标类型。
 *
 * 使用方法：
 * - coerceHandAction 处理 targetKind 时调用。
 *
 * 作用：
 * - 防止未知目标类型进入修改链路。
 */
function coerceHandTargetKind(value: unknown): HandTargetKind {
  if (typeof value === "string" && handTargetKinds.has(value as HandTargetKind)) {
    return value as HandTargetKind;
  }
  return "workspace_file";
}

/**
 * 把不可信值收敛成手部风险等级。
 *
 * 使用方法：
 * - coerceHandPlan 保留已有 plan 风险等级时调用。
 *
 * 作用：
 * - 保证风险等级只会是 H0、H1、H2 或 H3。
 */
function coerceHandRiskLevel(value: unknown, fallback: HandRiskLevel): HandRiskLevel {
  if (typeof value === "string" && handRiskLevels.has(value as HandRiskLevel)) {
    return value as HandRiskLevel;
  }
  return fallback;
}

/**
 * 生成去重后的字符串数组。
 *
 * 使用方法：
 * - 风险标记汇总时调用 uniqueStrings(flags)。
 *
 * 作用：
 * - 保持 riskFlags 稳定、简洁，避免审计记录里重复出现同一标记。
 */
function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

/**
 * 对错误或输出文本做基础脱敏。
 *
 * 使用方法：
 * - HandResult.error 或 diff 风险说明进入 store 前调用。
 *
 * 作用：
 * - 避免常见 key、token、password 和 bearer token 原文进入审计日志。
 * - 这是启发式保护，不替代完整 secret scanner。
 */
function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
}

/**
 * 判断一个手部动作是否属于第一阶段可应用范围。
 *
 * 使用方法：
 * - preview 阶段打风险标记，apply 阶段做底线校验。
 *
 * 作用：
 * - 把 delete、move、external object、database record 等完整版动作先挡在第一阶段之外。
 */
function isSupportedHandAction(action: HandAction): boolean {
  return supportedActionKinds.has(action.kind) && supportedTargetKinds.has(action.targetKind);
}

/**
 * 从不可信输入中构造一个 HandAction。
 *
 * 使用方法：
 * - API 层、未来 Agent Core 或测试把 JSON action 传入 coerceHandAction(value)。
 * - create_file、update_file 和 apply_patch 第一阶段需要提供 content。
 *
 * 作用：
 * - 把动作类型、目标、目标种类、原因、预期变化和内容字段收敛成内部稳定结构。
 * - 避免修改相关字段校验散落在 API、agent 或 adapter 中。
 *
 * 边界：
 * - 不读取文件。
 * - 不写文件。
 * - 不判断目标路径是否逃出 workspace；路径安全由 resolveHandTarget 负责。
 */
export function coerceHandAction(value: unknown): HandAction {
  if (!isJsonObject(value)) {
    throw new Error("Hand action must be an object.");
  }
  const kind = coerceHandActionKind(value.kind || "update_file");
  const target = optionalString(value.target);
  if (!target) {
    throw new Error("Hand action target is required.");
  }
  const content = typeof value.content === "string" ? value.content : undefined;
  if ((kind === "create_file" || kind === "update_file" || kind === "apply_patch") && content === undefined) {
    throw new Error("Hand action content is required for create_file, update_file, and apply_patch.");
  }
  return {
    id: optionalString(value.id) || newId("hct"),
    kind,
    targetKind: coerceHandTargetKind(value.targetKind),
    target,
    reason: optionalString(value.reason) || "Modify a workspace object.",
    expectedChange: optionalString(value.expectedChange) || "Apply the requested content change.",
    inputSummary: optionalString(value.inputSummary) || target,
    content,
    expectedCurrentHash: optionalString(value.expectedCurrentHash),
    adapterId: optionalString(value.adapterId),
    rollbackStrategy: coerceRollbackStrategy(value.rollbackStrategy)
  };
}

/**
 * 把不可信值收敛成回滚策略。
 *
 * 使用方法：
 * - coerceHandAction 读取 rollbackStrategy 时调用。
 *
 * 作用：
 * - 为完整版手能力预留 rollback 字段，同时保证第一阶段不会出现未知策略。
 */
function coerceRollbackStrategy(value: unknown): HandRollbackStrategy | undefined {
  if (
    value === "none" ||
    value === "snapshot" ||
    value === "reverse_patch" ||
    value === "external_revision" ||
    value === "adapter_defined"
  ) {
    return value;
  }
  return undefined;
}

/**
 * 创建一个结构化手部动作。
 *
 * 使用方法：
 * - 代码内部需要构造文件修改动作时调用 createHandAction({ target, content })。
 *
 * 作用：
 * - 自动补齐 id、kind、targetKind、原因和摘要。
 * - 保证内部创建的 action 也经过 coerceHandAction 的同一套校验。
 */
export function createHandAction(input: Partial<HandAction> & { target: string; content?: string }): HandAction {
  return coerceHandAction({
    kind: "update_file",
    targetKind: "workspace_file",
    reason: "Modify a workspace file.",
    expectedChange: "Apply a text content change.",
    inputSummary: input.target,
    ...input
  });
}

/**
 * 从不可信输入中构造一个 HandPlan。
 *
 * 使用方法：
 * - /api/hand/preview 或 /api/hand/apply 收到 plan 对象时调用。
 * - 已有 id、createdAt、riskLevel 会在合法时保留。
 *
 * 作用：
 * - 让“先 plan 后 preview/apply”的 API 流程可以安全复用客户端传回的计划。
 * - 重新推导缺失的风险、preview 和审批字段，避免计划结构漂移。
 *
 * 边界：
 * - 不读取文件。
 * - 不写文件。
 */
export function coerceHandPlan(value: unknown): HandPlan {
  if (!isJsonObject(value)) {
    throw new Error("Hand plan must be an object.");
  }
  if (!Array.isArray(value.actions)) {
    throw new Error("Hand plan actions must be an array.");
  }
  const actions = value.actions.map((action) => coerceHandAction(action));
  const riskFlags = detectHandRiskFlags(actions);
  const inferredRisk = inferHandRisk(actions, riskFlags);
  const riskLevel = coerceHandRiskLevel(value.riskLevel, inferredRisk);
  return {
    id: optionalString(value.id) || newId("hdp"),
    goal: optionalString(value.goal) || "Modify a workspace object.",
    reason: optionalString(value.reason) || "The current task requires a controlled modification.",
    targetKind: coerceHandTargetKind(value.targetKind || inferPlanTargetKind(actions)),
    actions,
    riskLevel,
    requiresPreview: value.requiresPreview === undefined ? actions.length > 0 : Boolean(value.requiresPreview),
    requiresApproval: value.requiresApproval === undefined ? riskLevel !== "H0" && riskLevel !== "H1" : Boolean(value.requiresApproval),
    expectedOutcome: optionalString(value.expectedOutcome) || "The object is modified and the result is auditable.",
    createdAt: optionalString(value.createdAt) || nowIso()
  };
}

/**
 * 创建一次手部修改计划。
 *
 * 使用方法：
 * - API 层或未来 Agent Core 收到修改请求后调用 createHandPlan(input)。
 * - 调用方需要提供 goal、reason 和 actions。
 * - 这个方法只创建计划，不读取文件，也不应用修改。
 *
 * 作用：
 * - 把“准备改什么、为什么改、风险多高、是否需要预览和审批”固定成结构化记录。
 * - 让 preview、policy gate、apply 和 audit 都基于同一份计划。
 *
 * 边界：
 * - 不直接写文件。
 * - 不绕过 preview。
 */
export function createHandPlan(input: CreateHandPlanInput): HandPlan {
  const actions = input.actions.map((action) => coerceHandAction(action));
  const riskFlags = detectHandRiskFlags(actions);
  const riskLevel = inferHandRisk(actions, riskFlags);
  return {
    id: newId("hdp"),
    goal: optionalString(input.goal) || "Modify a workspace object.",
    reason: optionalString(input.reason) || "The current task requires a controlled modification.",
    targetKind: inferPlanTargetKind(actions),
    actions,
    riskLevel,
    requiresPreview: actions.length > 0,
    requiresApproval: riskLevel !== "H0" && riskLevel !== "H1",
    expectedOutcome: optionalString(input.expectedOutcome) || "The object is modified and the result is auditable.",
    createdAt: nowIso()
  };
}

/**
 * 推导计划的主目标类型。
 *
 * 使用方法：
 * - createHandPlan 和 coerceHandPlan 在汇总多 action 计划时调用。
 *
 * 作用：
 * - 给 HandPlan 提供一个稳定的 targetKind，方便 UI 和审计快速理解修改目标。
 */
function inferPlanTargetKind(actions: HandAction[]): HandTargetKind {
  if (actions.some((action) => action.targetKind === "external_object")) return "external_object";
  if (actions.some((action) => action.targetKind === "database_record")) return "database_record";
  if (actions.some((action) => action.targetKind === "application_state" || action.targetKind === "browser_state")) {
    return "application_state";
  }
  if (actions.some((action) => action.targetKind === "config")) return "config";
  if (actions.some((action) => action.targetKind === "document")) return "document";
  return "workspace_file";
}

/**
 * 检测手部动作的风险标记。
 *
 * 使用方法：
 * - createHandPlan、createHandPreview 和 policy gate 都可以调用。
 *
 * 作用：
 * - 把动作类型、目标类型、目标路径和内容规模转成可解释的风险标签。
 * - 风险标签是解释依据，不直接替代最终 policy gate。
 */
export function detectHandRiskFlags(actions: HandAction[]): string[] {
  const flags: string[] = [];
  if (actions.length > 0) flags.push("modifies_workspace");
  if (actions.length > 1) flags.push("multi_file_change");
  for (const action of actions) {
    if (action.kind === "create_file") flags.push("creates_file");
    if (action.kind === "update_file" || action.kind === "apply_patch") flags.push("updates_file");
    if (action.kind === "delete_file") flags.push("deletes_file", "irreversible_change", "requires_user_confirmation");
    if (action.kind === "move_file") flags.push("moves_file", "requires_user_confirmation");
    if (action.targetKind === "config" || configLikeTargetPattern.test(action.target)) flags.push("modifies_config");
    if (isSecretLikeTarget(action.target) || (action.content && secretLikeContentPatterns.some((pattern) => pattern.test(action.content || "")))) {
      flags.push("touches_secret_like_file", "requires_user_confirmation");
    }
    if (
      action.targetKind === "external_object" ||
      action.targetKind === "database_record" ||
      action.targetKind === "application_state" ||
      action.targetKind === "browser_state" ||
      action.targetKind === "clipboard" ||
      action.targetKind === "message_draft"
    ) {
      flags.push("external_object", "requires_user_confirmation");
    }
    if (!isSupportedHandAction(action)) flags.push("unsupported_action", "requires_user_confirmation");
    if ((action.content || "").length > LARGE_CHANGE_BYTES || (action.content || "").split(/\r?\n/).length > LARGE_CHANGE_LINES) {
      flags.push("large_change");
    }
  }
  return uniqueStrings(flags);
}

/**
 * 推导手部计划的风险等级。
 *
 * 使用方法：
 * - 创建 plan 和 preview 时调用 inferHandRisk(actions, flags)。
 *
 * 作用：
 * - 把动作类型、目标类型、风险标记合成 H0-H3。
 * - 风险等级只决定 policy，不代表一定能执行。
 */
export function inferHandRisk(actions: HandAction[], riskFlags: string[] = detectHandRiskFlags(actions)): HandRiskLevel {
  if (actions.length === 0) return "H0";
  if (
    riskFlags.some((flag) =>
      [
        "deletes_file",
        "moves_file",
        "external_object",
        "irreversible_change",
        "touches_secret_like_file",
        "requires_user_confirmation",
        "unsupported_action",
        "workspace_escape",
        "binary_file",
        "no_preview_available"
      ].includes(flag)
    )
  ) {
    return "H3";
  }
  if (riskFlags.some((flag) => ["updates_file", "modifies_config", "large_change", "multi_file_change"].includes(flag))) {
    return "H2";
  }
  return "H1";
}

/**
 * 解析手部目标，并确保路径位于 workspace 内。
 *
 * 使用方法：
 * - preview 和 apply 前必须先调用 resolveHandTarget(action, config)。
 *
 * 作用：
 * - 把 action.target 转成 workspace 内绝对路径和相对路径。
 * - 阻止手能力写入 workspace 外文件。
 *
 * 边界：
 * - 第一阶段只解析本地文件路径。
 * - 外部对象、数据库和 GUI 状态会在 policy 中被拒绝。
 */
export function resolveHandTarget(action: HandAction, config: AppConfig): ResolvedHandTarget {
  const workspace = resolveWorkspace(config);
  const absolutePath = path.resolve(workspace, action.target);
  const relative = path.relative(workspace, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Hand target escapes the configured workspace.");
  }
  const exists = existsSync(absolutePath);
  const riskFlags = [];
  if (isSecretLikeTarget(relative)) riskFlags.push("touches_secret_like_file", "requires_user_confirmation");
  if (configLikeTargetPattern.test(relative)) riskFlags.push("modifies_config");
  if (exists) {
    try {
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile()) riskFlags.push("unsupported_target");
    } catch {
      riskFlags.push("target_stat_failed");
    }
  }
  return {
    action,
    absolutePath,
    relativePath: relative || ".",
    exists,
    riskFlags
  };
}

/**
 * 计算文本内容 hash。
 *
 * 使用方法：
 * - preview 生成 beforeHash/afterHash 时调用。
 * - apply 前重新读取当前文件后调用，用来检测 preview 是否 stale。
 *
 * 作用：
 * - 判断 preview 之后目标内容是否变化。
 * - 这不是权限校验，只是内容一致性检测。
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 判断目标路径是否像密钥或凭证文件。
 *
 * 使用方法：
 * - 风险检测和目标解析时调用。
 *
 * 作用：
 * - 识别 .env、密钥文件、凭证文件等高风险目标。
 * - 只能做启发式判断，不能保证覆盖所有秘密文件。
 */
export function isSecretLikeTarget(target: string): boolean {
  return secretLikeTargetPattern.test(target);
}

/**
 * 判断文本是否疑似二进制内容。
 *
 * 使用方法：
 * - 读取目标文件后判断是否适合文本 diff。
 *
 * 作用：
 * - 避免把二进制文件当文本写坏。
 * - 第一阶段遇到可疑二进制应保守拒绝。
 */
export function isProbablyBinaryText(text: string): boolean {
  return text.includes("\0");
}

/**
 * 读取目标当前内容，并构造预览快照。
 *
 * 使用方法：
 * - createHandPreview 为每个 action 创建 HandActionPreview 前调用。
 *
 * 作用：
 * - 读取旧内容、准备新内容、计算 hash、检测二进制和大修改风险。
 * - 把文件状态固定成 apply 阶段可以校验的快照。
 */
async function readActionContentSnapshot(resolved: ResolvedHandTarget): Promise<ActionContentSnapshot> {
  const riskFlags = [...resolved.riskFlags];
  let beforeText = "";
  let beforeHash: string | undefined;
  if (resolved.exists) {
    const buffer = await readFile(resolved.absolutePath);
    beforeText = buffer.toString("utf8");
    beforeHash = hashText(beforeText);
    if (isProbablyBinaryText(beforeText)) riskFlags.push("binary_file", "no_preview_available");
  } else if (resolved.action.kind === "update_file" || resolved.action.kind === "apply_patch") {
    riskFlags.push("target_missing");
  }
  if (resolved.action.kind === "create_file" && resolved.exists) {
    riskFlags.push("target_exists", "requires_user_confirmation");
  }
  const afterText = resolved.action.content || "";
  if (isProbablyBinaryText(afterText)) riskFlags.push("binary_file", "no_preview_available");
  if (Math.abs(afterText.length - beforeText.length) > LARGE_CHANGE_BYTES) riskFlags.push("large_change");
  if (Math.max(beforeText.split(/\r?\n/).length, afterText.split(/\r?\n/).length) > LARGE_CHANGE_LINES) {
    riskFlags.push("large_change");
  }
  return {
    beforeText,
    afterText,
    beforeHash,
    afterHash: hashText(afterText),
    beforeBytes: Buffer.byteLength(beforeText),
    afterBytes: Buffer.byteLength(afterText),
    riskFlags: uniqueStrings(riskFlags)
  };
}

/**
 * 生成简单 unified diff。
 *
 * 使用方法：
 * - createHandPreview 对每个 action 调用。
 *
 * 作用：
 * - 生成给用户和 audit 查看的一致 diff 文本。
 * - 第一阶段实现稳定、可读的行级 diff，不追求最短 diff。
 */
export function createUnifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  const oldLines = oldText.length ? oldText.split(/\r?\n/) : [];
  const newLines = newText.length ? newText.split(/\r?\n/) : [];
  const header = [`--- ${oldLabel}`, `+++ ${newLabel}`, "@@"];
  if (oldText === newText) return [...header, " no changes"].join("\n");
  return [
    ...header,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}

/**
 * 为单个 action 创建修改预览。
 *
 * 使用方法：
 * - createHandPreview 遍历 plan.actions 时调用。
 *
 * 作用：
 * - 生成 diff、hash、风险标记和回滚策略。
 * - 不写文件，只读取当前目标状态。
 */
async function createActionPreview(action: HandAction, config: AppConfig): Promise<HandActionPreview> {
  let resolved: ResolvedHandTarget;
  try {
    resolved = resolveHandTarget(action, config);
  } catch {
    return {
      actionId: action.id,
      target: action.target,
      beforeBytes: 0,
      afterBytes: Buffer.byteLength(action.content || ""),
      diff: "",
      riskFlags: ["workspace_escape", "requires_user_confirmation", "no_preview_available"],
      reversible: false,
      rollbackStrategy: "none",
      summary: `Target "${action.target}" escapes the workspace.`
    };
  }
  if (!isSupportedHandAction(action)) {
    return {
      actionId: action.id,
      target: resolved.relativePath,
      beforeBytes: 0,
      afterBytes: Buffer.byteLength(action.content || ""),
      diff: "",
      riskFlags: uniqueStrings([...detectHandRiskFlags([action]), ...resolved.riskFlags, "unsupported_action", "no_preview_available"]),
      reversible: false,
      rollbackStrategy: "none",
      summary: `Action ${action.kind} is not supported by first-stage hand capability.`
    };
  }
  const snapshot = await readActionContentSnapshot(resolved);
  const oldLabel = action.kind === "create_file" && !resolved.exists ? "/dev/null" : resolved.relativePath;
  const diff = snapshot.riskFlags.includes("no_preview_available")
    ? ""
    : createUnifiedDiff(snapshot.beforeText, snapshot.afterText, oldLabel, resolved.relativePath);
  const rollbackStrategy: HandRollbackStrategy = snapshot.riskFlags.includes("no_preview_available") ? "none" : "reverse_patch";
  return {
    actionId: action.id,
    target: resolved.relativePath,
    beforeHash: snapshot.beforeHash,
    afterHash: snapshot.afterHash,
    beforeBytes: snapshot.beforeBytes,
    afterBytes: snapshot.afterBytes,
    diff,
    riskFlags: uniqueStrings([...detectHandRiskFlags([action]), ...snapshot.riskFlags]),
    reversible: rollbackStrategy !== "none",
    rollbackStrategy,
    summary: `${action.kind} ${resolved.relativePath}`
  };
}

/**
 * 创建一次手部修改预览。
 *
 * 使用方法：
 * - 所有 apply 之前都必须先调用 createHandPreview(plan, config)。
 * - API 的 /api/hand/preview 会直接返回这个结构。
 *
 * 作用：
 * - 读取当前目标内容、生成 diff、计算 hash、汇总风险。
 * - 给 Policy Gate、用户审批和审计系统提供稳定依据。
 *
 * 边界：
 * - 只读文件，不写文件。
 * - 无法 preview 的修改不能自动 apply。
 */
export async function createHandPreview(plan: HandPlan, config: AppConfig | null = null): Promise<HandPreview> {
  const activeConfig = config || (await loadConfig());
  const actionPreviews = await Promise.all(plan.actions.map((action) => createActionPreview(action, activeConfig)));
  const riskFlags = uniqueStrings([
    ...detectHandRiskFlags(plan.actions),
    ...actionPreviews.flatMap((preview) => preview.riskFlags)
  ]);
  const riskLevel = inferHandRisk(plan.actions, riskFlags);
  const diff = actionPreviews.map((preview) => preview.diff).filter(Boolean).join("\n\n");
  const reversible = actionPreviews.length > 0 && actionPreviews.every((preview) => preview.reversible);
  return {
    id: newId("hpv"),
    planId: plan.id,
    summary: plan.actions.length
      ? `Preview ${plan.actions.length} hand action(s); risk ${riskLevel}.`
      : "No object will be modified.",
    affectedTargets: actionPreviews.map((preview) => preview.target),
    actionPreviews,
    diff,
    reversible,
    rollbackStrategy: reversible ? "reverse_patch" : "none",
    riskLevel,
    riskFlags,
    requiresApproval: riskLevel !== "H0" && riskLevel !== "H1",
    createdAt: nowIso()
  };
}

/**
 * 判断手部计划是否可以自动应用。
 *
 * 使用方法：
 * - applyHandPlan 在检查 approved 参数前调用。
 *
 * 作用：
 * - 把自动应用策略集中到一个地方。
 * - 返回 true 只代表 policy 允许，不代表写入一定成功。
 */
export function canAutoApplyHandPlan(plan: HandPlan, preview: HandPreview): boolean {
  return (
    plan.actions.length > 0 &&
    preview.riskLevel === "H1" &&
    !preview.requiresApproval &&
    Boolean(preview.diff) &&
    !preview.riskFlags.some((flag) =>
      [
        "workspace_escape",
        "unsupported_action",
        "binary_file",
        "no_preview_available",
        "touches_secret_like_file",
        "requires_user_confirmation"
      ].includes(flag)
    )
  );
}

/**
 * 创建一个被拒绝的手部结果。
 *
 * 使用方法：
 * - policy gate 拒绝、用户拒绝、unsupported action 或冲突时调用。
 *
 * 作用：
 * - 用标准 HandResult 记录“没有修改”的事实。
 * - 防止嘴巴把被拒绝的修改误报成已经应用。
 */
export function createRejectedHandResult(plan: HandPlan, preview: HandPreview | null, reason: string): HandResult {
  return {
    id: newId("hrs"),
    planId: plan.id,
    previewId: preview?.id,
    status: "rejected",
    changedTargets: [],
    error: redactSensitiveText(reason),
    rollbackAvailable: false,
    rollbackStrategy: "none",
    createdAt: nowIso()
  };
}

/**
 * 创建一个失败的手部结果。
 *
 * 使用方法：
 * - preview 或 apply 过程中捕获异常时调用 createFailedHandResult(plan, preview, error)。
 *
 * 作用：
 * - 将未知异常转换成安全、可审计、可展示的 HandResult。
 * - 避免把 token、password 或 authorization 原文写入结果。
 */
export function createFailedHandResult(plan: HandPlan, preview: HandPreview | null, error: unknown): HandResult {
  return {
    id: newId("hrs"),
    planId: plan.id,
    previewId: preview?.id,
    status: "failed",
    changedTargets: [],
    error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    rollbackAvailable: false,
    rollbackStrategy: "none",
    createdAt: nowIso()
  };
}

/**
 * 判断 preview 是否包含第一阶段必须阻断的风险。
 *
 * 使用方法：
 * - applyHandPlan 在真正写入前调用。
 *
 * 作用：
 * - 将不支持动作、workspace escape、二进制和无法预览集中阻断。
 */
function blockingPreviewReason(preview: HandPreview): string | null {
  const blockingFlags = ["workspace_escape", "unsupported_action", "binary_file", "no_preview_available"];
  const flag = preview.riskFlags.find((item) => blockingFlags.includes(item));
  return flag ? `Hand preview contains blocking risk flag: ${flag}.` : null;
}

/**
 * 按 actionId 查找预览项。
 *
 * 使用方法：
 * - applyHandPlan 应用每个 action 前调用。
 *
 * 作用：
 * - 确保所有会写入的动作都有对应 preview 和 hash。
 */
function findActionPreview(preview: HandPreview, actionId: string): HandActionPreview | null {
  return preview.actionPreviews.find((item) => item.actionId === actionId) || null;
}

/**
 * 应用一次手部修改计划。
 *
 * 使用方法：
 * - API 或未来 Agent Core 在 preview 之后调用 applyHandPlan(plan, preview, options, config)。
 * - options.approved 表示调用方已经完成用户审批。
 *
 * 作用：
 * - 根据 policy gate 结果应用 workspace 文件修改。
 * - 应用前重新校验当前文件 hash，避免覆盖 preview 之后的用户改动。
 *
 * 边界：
 * - 没有 preview 不应用。
 * - preview stale 不应用。
 * - H2/H3 没有批准不应用。
 */
export async function applyHandPlan(
  plan: HandPlan,
  preview: HandPreview,
  options: ApplyHandPlanOptions = {},
  config: AppConfig | null = null
): Promise<HandResult> {
  const activeConfig = config || (await loadConfig());
  if (preview.planId !== plan.id) {
    return createFailedHandResult(plan, preview, "Hand preview does not match plan.");
  }
  if (options.dryRun) {
    return {
      id: newId("hrs"),
      planId: plan.id,
      previewId: preview.id,
      status: "skipped",
      changedTargets: [],
      diffApplied: preview.diff,
      rollbackAvailable: false,
      rollbackStrategy: "none",
      createdAt: nowIso()
    };
  }
  const blockingReason = blockingPreviewReason(preview);
  if (blockingReason) return createRejectedHandResult(plan, preview, blockingReason);
  if ((plan.requiresApproval || preview.requiresApproval) && !options.approved && !canAutoApplyHandPlan(plan, preview)) {
    return createRejectedHandResult(plan, preview, "Hand modification requires approval.");
  }

  const changedTargets: string[] = [];
  try {
    for (const action of plan.actions) {
      if (!isSupportedHandAction(action)) {
        return createRejectedHandResult(plan, preview, `Unsupported hand action: ${action.kind}.`);
      }
      const resolved = resolveHandTarget(action, activeConfig);
      const actionPreview = findActionPreview(preview, action.id);
      if (!actionPreview) {
        return createRejectedHandResult(plan, preview, `Missing preview for action ${action.id}.`);
      }
      if (action.kind === "create_file" && resolved.exists) {
        return createRejectedHandResult(plan, preview, `Create target already exists: ${resolved.relativePath}.`);
      }
      if ((action.kind === "update_file" || action.kind === "apply_patch") && !resolved.exists) {
        return createRejectedHandResult(plan, preview, `Update target does not exist: ${resolved.relativePath}.`);
      }
      const currentText = resolved.exists ? (await readFile(resolved.absolutePath, "utf8")) : "";
      const currentHash = resolved.exists ? hashText(currentText) : undefined;
      if (actionPreview.beforeHash !== currentHash) {
        return createRejectedHandResult(plan, preview, `Patch conflict for ${resolved.relativePath}.`);
      }
      if (action.expectedCurrentHash && action.expectedCurrentHash !== currentHash) {
        return createRejectedHandResult(plan, preview, `Expected current hash does not match ${resolved.relativePath}.`);
      }
      await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      await writeFile(resolved.absolutePath, action.content || "", "utf8");
      changedTargets.push(resolved.relativePath);
    }
    return {
      id: newId("hrs"),
      planId: plan.id,
      previewId: preview.id,
      status: changedTargets.length ? "applied" : "skipped",
      changedTargets,
      diffApplied: preview.diff,
      rollbackAvailable: preview.reversible,
      rollbackStrategy: preview.rollbackStrategy,
      createdAt: nowIso()
    };
  } catch (error) {
    return createFailedHandResult(plan, preview, error);
  }
}

/**
 * 创建、预览、应用并记录一次手部计划。
 *
 * 使用方法：
 * - /api/hand/execute 可以传入 CreateHandPlanInput 或已有 HandPlan。
 * - 未来 Agent Core 也可以用它串起三段式修改流程。
 *
 * 作用：
 * - 串起 HandPlan、HandPreview、HandResult 和 store audit。
 * - 保证没有任何写入绕过 preview 和 result 记录。
 *
 * 边界：
 * - 如果未传 approved 且计划需要审批，会记录 rejected result，而不是写文件。
 */
export async function executeAndRecordHandPlan(
  input: CreateHandPlanInput | HandPlan,
  options: ApplyHandPlanOptions = {},
  config: AppConfig | null = null
): Promise<ExecuteHandPlanOutput> {
  const activeConfig = config || (await loadConfig());
  const plan = await recordHandPlan(isJsonObject(input) && Array.isArray(input.actions) && "riskLevel" in input
    ? coerceHandPlan(input)
    : createHandPlan(input as CreateHandPlanInput));
  const preview = await recordHandPreview(await createHandPreview(plan, activeConfig));
  const result = await recordHandResult(await applyHandPlan(plan, preview, options, activeConfig));
  return { plan, preview, result };
}
