import { exec } from "node:child_process";
import path from "node:path";
import { loadConfig, resolveWorkspace } from "./config.js";
import { newId, nowIso } from "./ids.js";
import { recordFootPlan, recordFootPreview, recordFootResult } from "./store.js";
import type {
  AppConfig,
  FootAction,
  FootActionKind,
  FootActionPreview,
  FootCommandResult,
  FootPlan,
  FootPreview,
  FootResult,
  FootRiskLevel,
  FootTargetKind,
  JsonObject
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 120000;
const EXEC_MAX_BUFFER = 1024 * 1024;

const footActionKinds = new Set<FootActionKind>([
  "run_command",
  "run_test",
  "run_build",
  "start_service",
  "stop_process"
]);

const footTargetKinds = new Set<FootTargetKind>([
  "workspace",
  "package_script",
  "system_process",
  "external_service"
]);

const footRiskLevels = new Set<FootRiskLevel>(["F0", "F1", "F2", "F3"]);

const destructiveCommandPattern =
  /\b(rm\s+-rf|git\s+reset|git\s+clean|remove-item\b[\s\S]*-recurse|del\s+\/[sq]|rd\s+\/s|docker\s+system\s+prune)\b/i;
const dependencyCommandPattern = /\b(npm|pnpm|yarn)\s+(install|add|remove|update|ci)\b/i;
const networkCommandPattern =
  /\b(curl|wget|ssh|scp|ftp|iwr|invoke-webrequest|git\s+push|npm\s+publish|docker\s+push)\b/i;
const longRunningCommandPattern =
  /\b(npm\s+run\s+dev|npm\s+start|vite\b|next\s+dev|webpack\s+serve|nodemon|serve\b|node\s+dist[\\/].*server)\b/i;
const buildCommandPattern = /\b(npm\s+run\s+build|tsc\b|vite\s+build|rollup|webpack\b)\b/i;
const testCommandPattern = /\b(npm\s+test|npm\s+run\s+test|vitest|jest|node\s+--test|typecheck)\b/i;
const secretLikePattern = /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization|bearer)\b/i;

export interface CreateFootPlanInput {
  goal?: string;
  reason?: string;
  actions: unknown[];
  expectedOutcome?: string;
}

export interface FootExecutionOptions {
  approved?: boolean;
  dryRun?: boolean;
}

export interface ExecuteFootPlanOutput {
  plan: FootPlan;
  preview: FootPreview;
  result: FootResult;
}

interface ResolvedFootAction {
  action: FootAction;
  absoluteCwd: string;
  relativeCwd: string;
  timeoutMs: number;
  riskFlags: string[];
}

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
}

/**
 * 判断一个值是否普通 JSON 对象。
 *
 * 使用方法：
 * - 解析 API body 或 action/plan 候选对象前调用。
 *
 * 作用：
 * - 避免把 null、数组或字符串当成可读取字段的对象。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读取一个可选字符串字段。
 *
 * 使用方法：
 * - coerceFootAction 和 coerceFootPlan 从不可信 JSON 中读取字段时调用。
 *
 * 作用：
 * - 只接受真正的字符串，并自动裁剪首尾空白。
 *
 * @param value 需要尝试解析为 String 的未知可选值；无法识别时返回 undefined。
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 把不可信值收敛成脚部动作类型。
 *
 * 使用方法：
 * - API 层、Agent Core 或测试传入 kind 时调用。
 *
 * 作用：
 * - 确保动作类型只会落在 FootActionKind 定义的集合内。
 *
 * @param value 需要校验并转换为 FootActionKind 的未知输入值。
 */
function coerceFootActionKind(value: unknown): FootActionKind {
  if (typeof value === "string" && footActionKinds.has(value as FootActionKind)) {
    return value as FootActionKind;
  }
  throw new Error("Foot action kind is not supported.");
}

/**
 * 把不可信值收敛成脚部目标类型。
 *
 * 使用方法：
 * - coerceFootAction 处理 targetKind 时调用。
 *
 * 作用：
 * - 防止外部 JSON 把未知目标类型塞进执行链路。
 *
 * @param value 需要校验并转换为 FootTargetKind 的未知输入值。
 */
function coerceFootTargetKind(value: unknown): FootTargetKind {
  if (typeof value === "string" && footTargetKinds.has(value as FootTargetKind)) {
    return value as FootTargetKind;
  }
  return "workspace";
}

/**
 * 把不可信值收敛成脚部风险等级。
 *
 * 使用方法：
 * - coerceFootPlan 保留已有 plan 风险等级时调用。
 *
 * 作用：
 * - 保证风险等级只会是 F0、F1、F2 或 F3。
 *
 * @param value 需要校验并转换为 FootRiskLevel 的未知输入值。
 * @param fallback 输入无法解析时使用的回退值。
 */
function coerceFootRiskLevel(value: unknown, fallback: FootRiskLevel): FootRiskLevel {
  if (typeof value === "string" && footRiskLevels.has(value as FootRiskLevel)) {
    return value as FootRiskLevel;
  }
  return fallback;
}

/**
 * 读取一个安全的 timeout 毫秒值。
 *
 * 使用方法：
 * - preview 和 execute 阶段为每个 action 计算最终 timeout 时调用。
 *
 * 作用：
 * - 限制命令最长运行时间，避免脚能力第一阶段变成长期进程管理器。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
function normalizeTimeoutMs(value: unknown, config: AppConfig): number {
  const configured = Number(config.security?.commandTimeoutMs || DEFAULT_TIMEOUT_MS);
  const requested = typeof value === "number" ? value : Number(value);
  const base = Number.isFinite(requested) && requested > 0 ? requested : configured;
  return Math.min(Math.max(Math.floor(base), 1000), MAX_TIMEOUT_MS);
}

/**
 * 生成去重后的字符串数组。
 *
 * 使用方法：
 * - 风险标记汇总时调用 uniqueStrings(flags)。
 *
 * 作用：
 * - 保持 riskFlags 稳定、简洁，避免审计记录里重复出现同一标记。
 *
 * @param values 需要批量归一化、去重、替换或格式化的值集合。
 */
function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

/**
 * 判断动作是否属于第一阶段可执行范围。
 *
 * 使用方法：
 * - preview 阶段决定 willExecute，execute 阶段做底线校验。
 *
 * 作用：
 * - 把 start_service、stop_process 和外部服务先挡在第一阶段之外。
 *
 * @param action 当前要校验、解析、预览或执行的单个动作。
 */
function isSupportedFootAction(action: FootAction): boolean {
  return (
    (action.kind === "run_command" || action.kind === "run_test" || action.kind === "run_build") &&
    (action.targetKind === "workspace" || action.targetKind === "package_script")
  );
}

/**
 * 从不可信输入中构造一个 FootAction。
 *
 * 使用方法：
 * - API 层、未来 Agent Core 或测试把 JSON action 传入 coerceFootAction(value)。
 * - 缺失 id 时会自动生成，cwd 缺失时默认为 workspace 根目录。
 *
 * 作用：
 * - 把命令、cwd、原因、预期效果和 timeout 收敛成内部稳定结构。
 * - 避免命令执行相关字段校验散落在 API、tools 和 agent 中。
 *
 * 边界：
 * - 不运行命令。
 * - 不判断 cwd 是否逃出 workspace；路径安全由 resolveFootCwd 负责。
 *
 * @param value 需要校验并转换为 FootAction 的未知输入值。
 */
export function coerceFootAction(value: unknown): FootAction {
  if (!isJsonObject(value)) {
    throw new Error("Foot action must be an object.");
  }
  const command = optionalString(value.command);
  if (!command) {
    throw new Error("Foot action command is required.");
  }
  const timeoutMs = typeof value.timeoutMs === "number" && value.timeoutMs > 0
    ? Math.floor(value.timeoutMs)
    : undefined;
  return {
    id: optionalString(value.id) || newId("fct"),
    kind: coerceFootActionKind(value.kind || "run_command"),
    targetKind: coerceFootTargetKind(value.targetKind),
    command,
    cwd: optionalString(value.cwd) || ".",
    reason: optionalString(value.reason) || "Run a local workspace command.",
    expectedEffect: optionalString(value.expectedEffect) || "Produce command output for the current task.",
    inputSummary: optionalString(value.inputSummary) || command.slice(0, 160),
    timeoutMs
  };
}

/**
 * 创建一个结构化脚部动作。
 *
 * 使用方法：
 * - 代码内部需要构造命令动作时调用 createFootAction({ command })。
 * - 常见场景是 tools.ts 将已审批的 shell.run 转成 FootAction。
 *
 * 作用：
 * - 自动补齐 id、kind、targetKind、cwd、原因和摘要。
 * - 保证内部创建的 action 也经过 coerceFootAction 的同一套校验。
 *
 * @param input 创建 FootAction 所需的结构化输入。
 */
export function createFootAction(input: Partial<FootAction> & { command: string }): FootAction {
  return coerceFootAction({
    kind: "run_command",
    targetKind: "workspace",
    cwd: ".",
    reason: "Run a local workspace command.",
    expectedEffect: "Produce command output for the current task.",
    inputSummary: input.command,
    ...input
  });
}

/**
 * 从不可信输入中构造一个 FootPlan。
 *
 * 使用方法：
 * - /api/foot/preview 或 /api/foot/execute 收到 plan 对象时调用。
 * - 已有 id、createdAt、riskLevel 会在合法时保留。
 *
 * 作用：
 * - 让“先 plan 后 preview/execute”的 API 流程可以安全复用客户端传回的计划。
 * - 重新推导缺失的风险、preview 和审批字段，避免计划结构漂移。
 *
 * 边界：
 * - 不运行命令。
 * - 不记录 store。
 *
 * @param value 需要校验并转换为 FootPlan 的未知输入值。
 */
export function coerceFootPlan(value: unknown): FootPlan {
  if (!isJsonObject(value)) {
    throw new Error("Foot plan must be an object.");
  }
  if (!Array.isArray(value.actions)) {
    throw new Error("Foot plan actions must be an array.");
  }
  const actions = value.actions.map((action) => coerceFootAction(action));
  const riskFlags = detectFootRiskFlags(actions);
  const inferredRisk = inferFootRisk(actions, riskFlags);
  const riskLevel = coerceFootRiskLevel(value.riskLevel, inferredRisk);
  return {
    id: optionalString(value.id) || newId("ftp"),
    goal: optionalString(value.goal) || "Run a local workspace command.",
    reason: optionalString(value.reason) || "The current task needs command execution.",
    actions,
    riskLevel,
    requiresPreview: value.requiresPreview === undefined ? actions.length > 0 : Boolean(value.requiresPreview),
    requiresApproval: value.requiresApproval === undefined ? actions.length > 0 : Boolean(value.requiresApproval),
    expectedOutcome: optionalString(value.expectedOutcome) || "The command produces an auditable result.",
    createdAt: optionalString(value.createdAt) || nowIso()
  };
}

/**
 * 创建一次脚部执行计划。
 *
 * 使用方法：
 * - API 层或未来 Agent Core 收到命令执行请求后调用 createFootPlan(input)。
 * - 调用方需要提供 goal、reason 和 actions。
 * - 这个方法只创建计划，不启动进程。
 *
 * 作用：
 * - 把“准备运行什么、为什么运行、风险多高、是否需要审批”固定成结构化记录。
 * - 让 preview、policy gate、execute 和 audit 都基于同一份计划。
 *
 * 边界：
 * - 不运行命令。
 * - 不绕过审批。
 *
 * @param input 创建 FootPlan 所需的结构化输入。
 */
export function createFootPlan(input: CreateFootPlanInput): FootPlan {
  const actions = input.actions.map((action) => coerceFootAction(action));
  const riskFlags = detectFootRiskFlags(actions);
  const riskLevel = inferFootRisk(actions, riskFlags);
  return {
    id: newId("ftp"),
    goal: optionalString(input.goal) || "Run a local workspace command.",
    reason: optionalString(input.reason) || "The current task needs command execution.",
    actions,
    riskLevel,
    requiresPreview: actions.length > 0,
    requiresApproval: actions.length > 0,
    expectedOutcome: optionalString(input.expectedOutcome) || "The command produces an auditable result.",
    createdAt: nowIso()
  };
}

/**
 * 检测脚部动作的风险标记。
 *
 * 使用方法：
 * - createFootPlan、createFootPreview 和 policy gate 都可以调用。
 *
 * 作用：
 * - 把命令文本、动作类型和目标类型转成可解释的风险标签。
 * - 让用户和审计日志能看懂为什么某个命令需要审批或被拒绝。
 *
 * @param actions 组成计划并用于风险判断或批量处理的动作列表。
 */
export function detectFootRiskFlags(actions: FootAction[]): string[] {
  const flags: string[] = [];
  if (actions.length > 0) flags.push("executes_process", "uses_shell", "workspace_command");
  if (actions.length > 1) flags.push("multi_command");
  for (const action of actions) {
    const command = action.command;
    if (action.kind === "run_test" || testCommandPattern.test(command)) flags.push("runs_test");
    if (action.kind === "run_build" || buildCommandPattern.test(command)) flags.push("runs_build", "writes_workspace");
    if (longRunningCommandPattern.test(command) || action.kind === "start_service") flags.push("long_running");
    if (dependencyCommandPattern.test(command)) flags.push("modifies_dependencies", "writes_workspace");
    if (networkCommandPattern.test(command)) flags.push("network_command", "external_side_effect");
    if (destructiveCommandPattern.test(command) || action.kind === "stop_process") {
      flags.push("destructive_command", "requires_user_confirmation");
    }
    if (secretLikePattern.test(command)) flags.push("uses_secrets");
    if (!isSupportedFootAction(action)) flags.push("unsupported_action", "requires_user_confirmation");
    if (action.targetKind === "external_service") flags.push("external_side_effect");
    if (action.targetKind === "system_process") flags.push("system_process");
  }
  return uniqueStrings(flags);
}

/**
 * 推导脚部计划的风险等级。
 *
 * 使用方法：
 * - 创建计划和预览时调用 inferFootRisk(actions, flags)。
 *
 * 作用：
 * - 把风险标记合并成 F0-F3 等级，供审批策略和 UI 使用。
 * - 风险等级只描述危险程度，不代表一定会执行。
 *
 * @param actions 组成计划并用于风险判断或批量处理的动作列表。
 * @param riskFlags 风险检测阶段生成、用于推导最终风险等级的标记集合。
 */
export function inferFootRisk(actions: FootAction[], riskFlags: string[] = detectFootRiskFlags(actions)): FootRiskLevel {
  if (actions.length === 0) return "F0";
  if (
    riskFlags.some((flag) =>
      [
        "destructive_command",
        "external_side_effect",
        "long_running",
        "modifies_dependencies",
        "network_command",
        "requires_user_confirmation",
        "shell_disabled",
        "system_process",
        "unsupported_action",
        "workspace_escape"
      ].includes(flag)
    )
  ) {
    return "F3";
  }
  if (riskFlags.some((flag) => ["runs_build", "runs_test", "writes_workspace", "multi_command"].includes(flag))) {
    return "F2";
  }
  return "F1";
}

/**
 * 解析命令执行目录，并确保 cwd 位于 workspace 内。
 *
 * 使用方法：
 * - createFootPreview 和 executeFootPlan 在处理每个 action 前调用。
 *
 * 作用：
 * - 将 action.cwd 转成绝对路径和相对路径。
 * - 阻止脚能力在 workspace 外启动命令。
 *
 * 边界：
 * - 只校验 cwd，不解释命令本身是否会访问外部路径。
 *
 * @param action 当前要校验、解析、预览或执行的单个动作。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export function resolveFootCwd(action: FootAction, config: AppConfig): ResolvedFootAction {
  const workspace = resolveWorkspace(config);
  const absoluteCwd = path.resolve(workspace, action.cwd || ".");
  const relative = path.relative(workspace, absoluteCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Command cwd escapes the configured workspace.");
  }
  return {
    action,
    absoluteCwd,
    relativeCwd: relative || ".",
    timeoutMs: normalizeTimeoutMs(action.timeoutMs, config),
    riskFlags: []
  };
}

/**
 * 创建单个命令动作的执行预览。
 *
 * 使用方法：
 * - createFootPreview 遍历 plan.actions 时调用。
 *
 * 作用：
 * - 展示命令、cwd、timeout、风险等级和是否会执行。
 * - 在不启动进程的情况下，让用户先看到脚准备怎么走。
 *
 * @param action 当前要校验、解析、预览或执行的单个动作。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
function createActionPreview(action: FootAction, config: AppConfig): FootActionPreview {
  const flags = detectFootRiskFlags([action]);
  let cwd = action.cwd || ".";
  let willExecute = isSupportedFootAction(action) && Boolean(config.security?.allowShell);
  try {
    const resolved = resolveFootCwd(action, config);
    cwd = resolved.relativeCwd;
  } catch {
    flags.push("workspace_escape", "requires_user_confirmation");
    willExecute = false;
  }
  if (!config.security?.allowShell) {
    flags.push("shell_disabled");
    willExecute = false;
  }
  const riskFlags = uniqueStrings(flags);
  return {
    actionId: action.id,
    command: action.command,
    cwd,
    timeoutMs: normalizeTimeoutMs(action.timeoutMs, config),
    riskLevel: inferFootRisk([action], riskFlags),
    riskFlags,
    willExecute,
    summary: willExecute
      ? `Run "${action.command}" in ${cwd}.`
      : `Command "${action.command}" is blocked by current foot policy.`
  };
}

/**
 * 创建一次脚部执行预览。
 *
 * 使用方法：
 * - 所有 execute 之前都必须先调用 createFootPreview(plan, config)。
 * - API 的 /api/foot/preview 会直接返回这个结构。
 *
 * 作用：
 * - 在不启动进程的情况下展示命令、cwd、timeout、风险和审批要求。
 * - 给 Policy Gate 和用户审批提供稳定依据。
 *
 * 边界：
 * - 不运行命令。
 * - 不创建后台进程。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function createFootPreview(plan: FootPlan, config: AppConfig | null = null): Promise<FootPreview> {
  const activeConfig = config || (await loadConfig());
  const actionPreviews = plan.actions.map((action) => createActionPreview(action, activeConfig));
  const riskFlags = uniqueStrings([
    ...detectFootRiskFlags(plan.actions),
    ...actionPreviews.flatMap((preview) => preview.riskFlags)
  ]);
  if (!activeConfig.security?.allowShell && plan.actions.length > 0) riskFlags.push("shell_disabled");
  const stableRiskFlags = uniqueStrings(riskFlags);
  const riskLevel = inferFootRisk(plan.actions, stableRiskFlags);
  return {
    id: newId("fpv"),
    planId: plan.id,
    summary: plan.actions.length
      ? `Preview ${plan.actions.length} command action(s); risk ${riskLevel}.`
      : "No command will be executed.",
    commands: plan.actions.map((action) => action.command),
    actionPreviews,
    riskLevel,
    riskFlags: stableRiskFlags,
    requiresApproval: plan.actions.length > 0,
    createdAt: nowIso()
  };
}

/**
 * 判断脚部计划是否可自动执行。
 *
 * 使用方法：
 * - executeFootPlan 在检查 approved 参数前调用。
 *
 * 作用：
 * - 集中表达第一阶段自动执行策略。
 * - 当前第一阶段为了安全，任何真实进程执行都不自动放行。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param preview 计划执行前生成的预览，用于风险判断和审批绑定。
 */
export function canAutoExecuteFootPlan(plan: FootPlan, preview: FootPreview): boolean {
  return plan.actions.length === 0 && preview.riskLevel === "F0";
}

/**
 * 创建一个被拒绝的脚部结果。
 *
 * 使用方法：
 * - policy gate 未通过、缺少审批、动作不支持或 shell 被禁用时调用。
 *
 * 作用：
 * - 用标准 FootResult 记录“没有启动进程”的事实。
 * - 防止嘴巴把被拒绝的命令误报成已经运行。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param preview 计划执行前生成的预览，用于风险判断和审批绑定。
 * @param reason 拒绝、失败、风险判断或状态变化的原因说明。
 */
export function createRejectedFootResult(plan: FootPlan, preview: FootPreview | null, reason: string): FootResult {
  return {
    id: newId("frs"),
    planId: plan.id,
    previewId: preview?.id,
    status: "rejected",
    commandResults: [],
    error: redactSensitiveOutput(reason),
    createdAt: nowIso()
  };
}

/**
 * 创建一个失败的脚部结果。
 *
 * 使用方法：
 * - 执行链路捕获异常时调用 createFailedFootResult(plan, preview, error)。
 *
 * 作用：
 * - 将未知异常转换成安全、可审计、可展示的 FootResult。
 * - 避免把 token、password 或 authorization 原文写入结果。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param preview 计划执行前生成的预览，用于风险判断和审批绑定。
 * @param error 捕获到的未知错误或进程错误对象。
 */
export function createFailedFootResult(plan: FootPlan, preview: FootPreview | null, error: unknown): FootResult {
  return {
    id: newId("frs"),
    planId: plan.id,
    previewId: preview?.id,
    status: "failed",
    commandResults: [],
    error: redactSensitiveOutput(error instanceof Error ? error.message : String(error)),
    createdAt: nowIso()
  };
}

/**
 * 对命令输出做基础脱敏。
 *
 * 使用方法：
 * - stdout、stderr 和 error 写入 FootResult 前调用。
 *
 * 作用：
 * - 避免常见 key、token、password 和 bearer token 原文进入审计日志。
 * - 这是启发式保护，不替代更强的 secret scanner。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function redactSensitiveOutput(value: string): string {
  return value
    .replace(/\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
}

/**
 * 截断过长的命令输出。
 *
 * 使用方法：
 * - runFootCommand 捕获 stdout、stderr 后调用。
 *
 * 作用：
 * - 防止单次命令把过大的日志写入本地 store。
 * - 保留开头内容和截断提示，方便用户判断结果。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated after ${MAX_OUTPUT_CHARS} characters]`;
}

/**
 * 从 exec 错误中提取退出码。
 *
 * 使用方法：
 * - runFootCommand 处理 child_process.exec 回调错误时调用。
 *
 * 作用：
 * - 将 Node 的 Error.code 统一转成 number 或 null，方便 FootCommandResult 展示。
 *
 * @param error 捕获到的未知错误或进程错误对象。
 */
function exitCodeFromError(error: ExecError | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

/**
 * 判断 exec 错误是否代表 timeout。
 *
 * 使用方法：
 * - runFootCommand 在命令结束后判断结果状态时调用。
 *
 * 作用：
 * - 把 Node exec 的 killed、signal 和错误消息统一收敛成 timedOut 布尔值。
 *
 * @param error 捕获到的未知错误或进程错误对象。
 */
function didCommandTimeOut(error: ExecError | null): boolean {
  if (!error) return false;
  return Boolean(error.killed && /timed out|timeout/i.test(error.message || ""));
}

/**
 * 运行一个已经通过策略校验的命令。
 *
 * 使用方法：
 * - executeFootPlan 在审批通过后逐个 action 调用。
 *
 * 作用：
 * - 启动本地 shell 命令，捕获 stdout、stderr、exit code、timeout 和 duration。
 * - 将结果收敛成 FootCommandResult，而不是把 child_process 细节泄漏给上层。
 *
 * 边界：
 * - 不做审批判断，调用前必须已经经过 executeFootPlan 的 policy gate。
 * - 不支持交互式 stdin。
 *
 * @param resolved 已经通过边界校验并补齐绝对路径等信息的动作。
 */
async function runFootCommand(resolved: ResolvedFootAction): Promise<FootCommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    exec(
      resolved.action.command,
      {
        cwd: resolved.absoluteCwd,
        timeout: resolved.timeoutMs,
        windowsHide: true,
        maxBuffer: EXEC_MAX_BUFFER
      },
      (error, stdout, stderr) => {
        const execError = error as ExecError | null;
        const safeStdout = truncateOutput(redactSensitiveOutput(stdout || ""));
        const safeStderr = truncateOutput(redactSensitiveOutput(stderr || ""));
        const output = truncateOutput([safeStdout, safeStderr].filter(Boolean).join("\n").trim());
        resolve({
          actionId: resolved.action.id,
          command: resolved.action.command,
          cwd: resolved.relativeCwd,
          exitCode: exitCodeFromError(execError),
          stdout: safeStdout,
          stderr: safeStderr,
          output: output || "(command completed with no output)",
          durationMs: Date.now() - started,
          timedOut: didCommandTimeOut(execError)
        });
      }
    );
  });
}

/**
 * 判断 preview 是否包含阻断执行的风险标记。
 *
 * 使用方法：
 * - executeFootPlan 在真正启动命令前调用。
 *
 * 作用：
 * - 将第一阶段不支持的场景集中阻断，避免分散在多处 if 判断中。
 *
 * @param preview 计划执行前生成的预览，用于风险判断和审批绑定。
 */
function blockingPreviewReason(preview: FootPreview): string | null {
  const blockingFlags = ["shell_disabled", "unsupported_action", "workspace_escape"];
  const flag = preview.riskFlags.find((item) => blockingFlags.includes(item));
  return flag ? `Foot preview contains blocking risk flag: ${flag}.` : null;
}

/**
 * 执行一次脚部计划。
 *
 * 使用方法：
 * - API 或 tools.ts 先创建 plan 和 preview，再调用 executeFootPlan(plan, preview, options, config)。
 * - options.approved 表示调用方已经完成用户审批。
 *
 * 作用：
 * - 根据 preview 和审批状态执行命令。
 * - 捕获每个命令的输出、退出码、耗时和 timeout。
 * - 返回真实 FootResult，供 store、嘴巴和审计系统使用。
 *
 * 边界：
 * - 没有 preview 不执行。
 * - preview 不匹配 plan 不执行。
 * - 未审批的真实进程不执行。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param preview 计划执行前生成的预览，用于风险判断和审批绑定。
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeFootPlan(
  plan: FootPlan,
  preview: FootPreview,
  options: FootExecutionOptions = {},
  config: AppConfig | null = null
): Promise<FootResult> {
  const activeConfig = config || (await loadConfig());
  const startedAt = nowIso();
  const started = Date.now();
  if (preview.planId !== plan.id) {
    return createFailedFootResult(plan, preview, "Foot preview does not match plan.");
  }
  if (options.dryRun) {
    return {
      id: newId("frs"),
      planId: plan.id,
      previewId: preview.id,
      status: "skipped",
      commandResults: [],
      output: "Dry run skipped command execution.",
      startedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - started,
      createdAt: nowIso()
    };
  }
  const blockingReason = blockingPreviewReason(preview);
  if (blockingReason) {
    return createRejectedFootResult(plan, preview, blockingReason);
  }
  if (plan.requiresApproval && !options.approved && !canAutoExecuteFootPlan(plan, preview)) {
    return createRejectedFootResult(plan, preview, "Foot execution requires approval.");
  }
  if (!activeConfig.security?.allowShell) {
    return createRejectedFootResult(plan, preview, "Shell execution is disabled in config.");
  }

  const commandResults: FootCommandResult[] = [];
  for (const action of plan.actions) {
    if (!isSupportedFootAction(action)) {
      return createRejectedFootResult(plan, preview, `Unsupported foot action: ${action.kind}.`);
    }
    try {
      const result = await runFootCommand(resolveFootCwd(action, activeConfig));
      commandResults.push(result);
      if (result.timedOut) {
        return {
          id: newId("frs"),
          planId: plan.id,
          previewId: preview.id,
          status: "timed_out",
          commandResults,
          output: formatCommandResults(commandResults),
          error: `Command timed out after ${result.durationMs}ms.`,
          startedAt,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          createdAt: nowIso()
        };
      }
      if (result.exitCode !== 0) {
        return {
          id: newId("frs"),
          planId: plan.id,
          previewId: preview.id,
          status: "failed",
          commandResults,
          output: formatCommandResults(commandResults),
          error: `Command exited with code ${result.exitCode ?? "unknown"}.`,
          startedAt,
          completedAt: nowIso(),
          durationMs: Date.now() - started,
          createdAt: nowIso()
        };
      }
    } catch (error) {
      return createFailedFootResult(plan, preview, error);
    }
  }

  return {
    id: newId("frs"),
    planId: plan.id,
    previewId: preview.id,
    status: commandResults.length ? "completed" : "skipped",
    commandResults,
    output: commandResults.length ? formatCommandResults(commandResults) : "No command actions to execute.",
    startedAt,
    completedAt: nowIso(),
    durationMs: Date.now() - started,
    createdAt: nowIso()
  };
}

/**
 * 格式化多个命令结果。
 *
 * 使用方法：
 * - executeFootPlan 生成 FootResult.output 时调用。
 *
 * 作用：
 * - 把多个 FootCommandResult 合并成适合展示和 tool output 的文本。
 * - 保留命令、cwd、exit code、duration 和输出。
 *
 * @param results 需要汇总、格式化或返回的多个能力结果。
 */
function formatCommandResults(results: FootCommandResult[]): string {
  return results
    .map((result) =>
      [
        `$ ${result.command}`,
        `cwd: ${result.cwd}`,
        `exitCode: ${result.exitCode ?? "unknown"}`,
        `durationMs: ${result.durationMs}`,
        result.timedOut ? "timedOut: true" : "",
        result.output
      ].filter(Boolean).join("\n")
    )
    .join("\n\n");
}

/**
 * 将 FootResult 格式化为工具输出文本。
 *
 * 使用方法：
 * - tools.ts 中的 shell.run 复用脚能力后调用。
 *
 * 作用：
 * - 让旧的工具面板仍能收到普通文本输出。
 * - 同时保留脚能力内部的结构化 FootResult 和 audit。
 *
 * @param result 当前要格式化、返回、审计或持久化的能力结果。
 */
export function formatFootResultOutput(result: FootResult): string {
  if (result.output) return result.output;
  if (result.error) return result.error;
  return `Foot execution finished with status ${result.status}.`;
}

/**
 * 创建、预览、执行并记录一次脚部计划。
 *
 * 使用方法：
 * - /api/foot/execute 可以传入 CreateFootPlanInput 或已有 FootPlan。
 * - tools.ts 的 shell.run 在用户批准后也可以调用这个方法。
 *
 * 作用：
 * - 串起 FootPlan、FootPreview、FootResult 和 store audit。
 * - 保证没有任何命令绕过 preview 和 result 记录。
 *
 * 边界：
 * - 如果未传 approved 且计划需要审批，会记录 rejected result，而不是执行命令。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param options 控制当前方法可选行为、依赖或执行策略的配置对象。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeAndRecordFootPlan(
  input: CreateFootPlanInput | FootPlan,
  options: FootExecutionOptions = {},
  config: AppConfig | null = null
): Promise<ExecuteFootPlanOutput> {
  const activeConfig = config || (await loadConfig());
  const plan = await recordFootPlan(isJsonObject(input) && Array.isArray(input.actions) && "riskLevel" in input
    ? coerceFootPlan(input)
    : createFootPlan(input as CreateFootPlanInput));
  const preview = await recordFootPreview(await createFootPreview(plan, activeConfig));
  const result = await recordFootResult(await executeFootPlan(plan, preview, options, activeConfig));
  return { plan, preview, result };
}
