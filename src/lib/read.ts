import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveWorkspace } from "./config.js";
import { newId, nowIso } from "./ids.js";
import { recordReadEvent } from "./store.js";
import type {
  AppConfig,
  ContextBlock,
  JsonObject,
  ReadPlan,
  ReadResult,
  ReadRiskLevel,
  ReadSource,
  ReadSourceKind
} from "./types.js";

const DEFAULT_MAX_BYTES = 120000;
const DEFAULT_MAX_FILES = 20;
const CONTEXT_MAX_CHARS = 12000;
const SUMMARY_MAX_CHARS = 2400;
const WEB_TIMEOUT_MS = 15000;

const readSourceKinds = new Set<ReadSourceKind>([
  "local_file",
  "document",
  "workspace",
  "web_page",
  "computer_config",
  "app_content",
  "communication",
  "calendar_task",
  "memory",
  "mcp_resource",
  "search",
  "runtime",
  "app_state"
]);

const riskOrder: ReadRiskLevel[] = ["L0", "L1", "L2", "L3"];

const sensitiveTargetPattern =
  /(^|[\\/])(\.env|config[\\/]local\.json|id_rsa|id_ed25519|\.ssh|cookies?|history|secrets?|tokens?|credentials?|private|\.pem|\.p12|\.kdbx)([\\/.]|$)/i;

const secretLikeContentPatterns = [
  /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/i,
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/
];

export interface CreateReadPlanInput {
  goal: string;
  reason: string;
  sources: ReadSource[];
  maxBytes?: number;
  maxFiles?: number;
  allowNetwork?: boolean;
  expectedSignals?: string[];
}

export interface ExecuteReadPlanOutput {
  plan: ReadPlan;
  results: ReadResult[];
  contextBlocks: ContextBlock[];
}

interface TextReadPayload {
  title: string;
  uri: string;
  mimeType: string;
  content: string;
  riskFlags: string[];
}

/**
 * 从不可信输入中构造一个 ReadSource。
 *
 * 使用方法：
 * - API 层收到 JSON body 后，把每个 source 交给这个方法。
 * - kind 必须是 readSourceKinds 中定义的来源类型。
 * - target 是要看的目标，purpose 是为什么看，required 表示失败时是否中断计划。
 *
 * 作用：
 * - 把外部 JSON 收敛成内部稳定结构。
 * - 避免 API 层到处散落字段校验逻辑。
 *
 * @param value 需要校验并转换为 ReadSource 的未知输入值。
 */
export function coerceReadSource(value: unknown): ReadSource {
  if (!isJsonObject(value)) {
    throw new Error("Read source must be an object.");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !readSourceKinds.has(kind as ReadSourceKind)) {
    throw new Error("Read source kind is not supported.");
  }
  const target = value.target;
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Read source target is required.");
  }
  const purpose = value.purpose;
  return {
    kind: kind as ReadSourceKind,
    target: target.trim(),
    purpose: typeof purpose === "string" && purpose.trim() ? purpose.trim() : "Provide context for the current task.",
    required: value.required === undefined ? true : Boolean(value.required)
  };
}

/**
 * 创建一个结构化读取来源。
 *
 * 使用方法：
 * - 代码内部可以直接调用 createReadSource("workspace", "README.md", "理解项目")。
 * - required 默认为 true，表示这个来源读取失败会影响整个读取计划。
 *
 * 作用：
 * - 让调用方不用手写 ReadSource 对象。
 * - 让来源创建保持统一字段和默认值。
 *
 * @param kind 当前方法要解析、判断或创建的类别标识。
 * @param target 需要解析、读取、修改、执行或校验的目标。
 * @param purpose 调用方声明的读取、表达或动作业务目的。
 * @param required 该需求或条件是否必须满足。
 */
export function createReadSource(
  kind: ReadSourceKind,
  target: string,
  purpose: string,
  required = true
): ReadSource {
  return coerceReadSource({ kind, target, purpose, required });
}

/**
 * 创建一次读取计划。
 *
 * 使用方法：
 * - Agent 判断当前任务需要上下文后，先把目标整理成 ReadSource[]。
 * - 再调用 createReadPlan 生成内部计划。
 * - 读取计划不会触发审批，因为读能力遵循 no_per_read_approval。
 *
 * 作用：
 * - 固定“为什么读、读哪里、读多少、风险多高”的决策记录。
 * - 给执行层、审计层和 UI 层提供同一份计划结构。
 *
 * @param input 创建 ReadPlan 所需的结构化输入。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export function createReadPlan(input: CreateReadPlanInput, config: AppConfig | null = null): ReadPlan {
  const sources = input.sources.map((source) => coerceReadSource(source));
  const maxBytes = positiveNumber(input.maxBytes, config?.security?.maxReadBytes, DEFAULT_MAX_BYTES);
  const maxFiles = positiveNumber(input.maxFiles, config?.security?.maxSearchResults, DEFAULT_MAX_FILES);
  const allowNetwork = input.allowNetwork ?? sources.some((source) => source.kind === "web_page");
  return {
    id: newId("rdp"),
    goal: input.goal.trim() || "Read context for the current task.",
    reason: input.reason.trim() || "The task needs additional context.",
    sources,
    maxBytes,
    maxFiles,
    allowNetwork,
    permissionMode: "no_per_read_approval",
    expectedSignals: input.expectedSignals || [],
    riskLevel: maxRiskLevel(sources.map((source) => inferReadRisk(source))),
    createdAt: nowIso()
  };
}

/**
 * 推断某个读取来源的风险等级。
 *
 * 使用方法：
 * - 创建 ReadPlan 时用于计算计划最高风险。
 * - 读取结果和读取事件写入时也会使用它。
 *
 * 作用：
 * - 风险等级不是阻止读取，而是提醒上下文过滤和长期记忆要谨慎。
 * - L1 普通读取，L2 敏感读取，L3 高敏或大范围读取。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 */
export function inferReadRisk(source: ReadSource): ReadRiskLevel {
  let risk: ReadRiskLevel = "L1";
  if (source.kind === "computer_config" || source.kind === "app_content" || source.kind === "mcp_resource") {
    risk = maxRiskLevel([risk, "L2"]);
  }
  if (
    source.kind === "communication" ||
    source.kind === "calendar_task" ||
    source.kind === "search" ||
    source.kind === "app_state"
  ) {
    risk = maxRiskLevel([risk, "L3"]);
  }
  if (source.kind === "runtime" || source.kind === "memory") {
    risk = maxRiskLevel([risk, "L2"]);
  }
  if (sensitiveTargetPattern.test(source.target)) {
    risk = maxRiskLevel([risk, "L2"]);
  }
  if (looksLikeWholeDiskTarget(source.target)) {
    risk = maxRiskLevel([risk, "L3"]);
  }
  return risk;
}

/**
 * 检测读取来源和内容中的风险标记。
 *
 * 使用方法：
 * - 读取完成后传入 source 和 content。
 * - extraFlags 可用于追加读取过程发现的情况，例如 large_file_truncated。
 *
 * 作用：
 * - 给 ReadResult 和 ContextBlock 标记潜在风险。
 * - 让 Context Filter 能决定是否脱敏、摘要或限制进入工作上下文的内容。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param content 调用方提供、需要解析、保存、表达或发送的正文内容。
 * @param extraFlags 调用方额外提供、需要合并到结果中的风险标记。
 */
export function detectRiskFlags(source: ReadSource, content = "", extraFlags: string[] = []): string[] {
  const flags = new Set(extraFlags);
  if (source.kind === "web_page") {
    flags.add("external_source");
    flags.add("unverified_content");
  }
  if (source.kind === "computer_config" || source.kind === "app_state" || source.kind === "app_content") {
    flags.add("local_system_state");
  }
  if (source.kind === "communication" || source.kind === "calendar_task") {
    flags.add("private_user_data");
  }
  if (source.kind === "mcp_resource") {
    flags.add("external_connector");
  }
  if (source.kind === "search") {
    flags.add("search_result");
  }
  if (sensitiveTargetPattern.test(source.target)) {
    flags.add("sensitive_target");
  }
  if (secretLikeContentPatterns.some((pattern) => pattern.test(content))) {
    flags.add("contains_secret_like_text");
  }
  return [...flags].sort();
}

/**
 * 估算文本大约会消耗多少 token。
 *
 * 使用方法：
 * - 读取结果创建时调用 estimateTokens(content)。
 * - UI 或 Agent Core 可以用 tokenEstimate 控制上下文体积。
 *
 * 作用：
 * - 提供一个轻量级体积指标。
 * - 当前实现使用字符数除以四的近似值，后续可替换为真实 tokenizer。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 从读取内容中抽取简单信号。
 *
 * 使用方法：
 * - 读取文件或网页后传入完整文本。
 * - 返回标题、链接、路径和 TODO 等低成本线索。
 *
 * 作用：
 * - 给后续规划和记忆层提供“读到了什么”的粗略索引。
 * - 这不是最终理解，只是第一阶段的轻量提取。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
export function extractSignals(text: string): string[] {
  const signals = new Set<string>();
  for (const line of text.split(/\r?\n/).slice(0, 2000)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) signals.add(trimmed.replace(/^#{1,6}\s+/, "").slice(0, 120));
    if (/^(todo|fixme|note)[:\s]/i.test(trimmed)) signals.add(trimmed.slice(0, 120));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)"']+/g)) {
    signals.add(match[0].slice(0, 160));
    if (signals.size >= 20) break;
  }
  return [...signals].filter(Boolean).slice(0, 30);
}

/**
 * 为工作上下文生成短摘要。
 *
 * 使用方法：
 * - 长文本、L2/L3 内容和网页内容进入上下文前调用。
 * - maxChars 控制摘要最大字符数。
 *
 * 作用：
 * - 防止大文件直接塞进模型上下文。
 * - 保留开头和结尾，让 Agent 仍能看到结构和收尾信息。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param maxChars 输出允许保留的最大字符数。
 */
export function summarizeForContext(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const headLength = Math.floor(maxChars * 0.72);
  const tailLength = maxChars - headLength;
  return `${clean.slice(0, headLength)}\n\n[...content summarized...]\n\n${clean.slice(-tailLength)}`;
}

/**
 * 把 ReadResult 转换成 Agent Core 可以消费的 ContextBlock。
 *
 * 使用方法：
 * - executeReadPlan 得到 ReadResult 后立即调用。
 * - Agent Core 应优先使用 ContextBlock，而不是直接使用原始 ReadResult。
 *
 * 作用：
 * - 统一做截断、摘要、脱敏、可信度和新鲜度标记。
 * - 把“看见的内容”和“进入工作记忆的内容”分开。
 *
 * @param result 当前要格式化、返回、审计或持久化的能力结果。
 */
export function createContextBlock(result: ReadResult): ContextBlock {
  const isSensitive = result.riskLevel === "L2" || result.riskLevel === "L3";
  const baseContent = isSensitive ? summarizeForContext(result.content) : truncateText(result.content, CONTEXT_MAX_CHARS);
  return {
    id: newId("ctx"),
    sourceId: result.id,
    title: result.title || `${result.source.kind}:${result.source.target}`,
    content: maskSensitiveText(baseContent),
    relevance: 0.8,
    trust: trustForSource(result.source),
    freshness: freshnessForSource(result.source),
    riskFlags: result.riskFlags
  };
}

/**
 * 读取本地文件、文档、workspace 路径或记忆文件。
 *
 * 使用方法：
 * - source.kind 可以是 local_file、document、workspace、memory 或 runtime。
 * - target 可以是绝对路径，也可以是相对 workspace 的路径。
 * - 如果 target 是目录，会返回目录列表；如果是文件，会读取文本内容。
 *
 * 作用：
 * - 第一阶段统一本地文本读取入口。
 * - 不做逐次审批，但会限制读取字节数并标记敏感风险。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 * @param planId 用于关联计划、读取结果和审计记录的计划唯一标识。
 * @param maxBytes 允许读取的最大字节数；超出部分会被截断或拒绝。
 */
export async function readLocalText(
  source: ReadSource,
  config: AppConfig | null = null,
  planId?: string,
  maxBytes?: number
): Promise<ReadResult> {
  const activeConfig = config || (await loadConfig());
  const resolved = resolveReadPath(source, activeConfig);
  const fileStat = await stat(resolved);
  const payload = fileStat.isDirectory()
    ? await readDirectoryPayload(resolved, source, activeConfig)
    : await readFilePayload(resolved, activeConfig, maxBytes);
  return createReadResult(source, payload, planId);
}

/**
 * 读取网页文本。
 *
 * 使用方法：
 * - source.kind 必须是 web_page。
 * - target 是完整 URL，例如 https://example.com/docs。
 * - allowNetwork 为 false 时会拒绝网页读取。
 *
 * 作用：
 * - 让“眼睛”具备读取公开网页和官方文档的能力。
 * - 自动保留来源 URL、content-type、外部来源和未验证内容标记。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param allowNetwork 是否允许本次读取或执行访问网络资源。
 * @param planId 用于关联计划、读取结果和审计记录的计划唯一标识。
 * @param maxBytes 允许读取的最大字节数；超出部分会被截断或拒绝。
 */
export async function readWebPage(
  source: ReadSource,
  allowNetwork: boolean,
  planId?: string,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<ReadResult> {
  if (!allowNetwork) {
    throw new Error("Network reading is disabled for this read plan.");
  }
  const url = new URL(source.target);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Web page returned HTTP ${response.status}.`);
    }
    const mimeType = response.headers.get("content-type") || "text/plain; charset=utf-8";
    const raw = await response.text();
    const content = truncateText(mimeType.includes("html") ? stripHtml(raw) : raw, maxBytes);
    const payload: TextReadPayload = {
      title: url.hostname,
      uri: response.url,
      mimeType,
      content,
      riskFlags: raw.length > maxBytes ? ["large_content_truncated"] : []
    };
    return createReadResult(source, payload, planId);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 读取当前电脑配置和运行环境。
 *
 * 使用方法：
 * - source.kind 使用 computer_config。
 * - target 写 system、node、env-names 或 env-values 都可以。
 * - env-values 会读取环境变量值，但进入 ContextBlock 前仍会被脱敏。
 *
 * 作用：
 * - 帮 Agent 理解当前电脑能运行什么、Node 版本是什么、系统资源大致如何。
 * - 电脑配置默认可读，但会被标记为 local_system_state。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param planId 用于关联计划、读取结果和审计记录的计划唯一标识。
 */
export async function readComputerConfig(source: ReadSource, planId?: string): Promise<ReadResult> {
  const includeEnvValues = /\benv-values\b/i.test(source.target);
  const env = Object.fromEntries(
    Object.entries(process.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, includeEnvValues ? value || "" : "(value omitted)"])
  );
  const payload: JsonObject = {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })).slice(0, 4),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    homeDir: os.homedir(),
    tempDir: os.tmpdir(),
    cwd: process.cwd(),
    nodeVersion: process.version,
    nodeVersions: process.versions,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    networkInterfaces: networkInterfaceSummary(),
    env
  };
  const riskFlags = includeEnvValues ? ["contains_environment_values"] : ["environment_values_omitted"];
  return createReadResult(
    source,
    {
      title: "Computer configuration",
      uri: "computer://local/system",
      mimeType: "application/json",
      content: JSON.stringify(payload, null, 2),
      riskFlags
    },
    planId
  );
}

/**
 * 在 workspace 中进行轻量全文搜索。
 *
 * 使用方法：
 * - source.kind 使用 search。
 * - target 是搜索关键词。
 * - maxFiles 控制最多返回多少条匹配行。
 *
 * 作用：
 * - 作为“先找到应该看哪里”的第一阶段搜索能力。
 * - 只搜索 workspace 内的普通文本文件，不做全盘扫描。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 * @param planId 用于关联计划、读取结果和审计记录的计划唯一标识。
 * @param maxFiles 递归扫描时允许收集的最大文件数量。
 */
export async function searchWorkspaceText(
  source: ReadSource,
  config: AppConfig | null = null,
  planId?: string,
  maxFiles = DEFAULT_MAX_FILES
): Promise<ReadResult> {
  const activeConfig = config || (await loadConfig());
  const workspace = resolveWorkspace(activeConfig);
  const files = await walkTextFiles(workspace, activeConfig, maxFiles * 8);
  const query = source.target.toLowerCase();
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= maxFiles) break;
    const payload = await readFilePayload(file, activeConfig, activeConfig.security?.maxReadBytes || DEFAULT_MAX_BYTES);
    if (payload.riskFlags.includes("likely_binary_content")) continue;
    const lines = payload.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || "";
      if (line.toLowerCase().includes(query)) {
        matches.push(`${path.relative(workspace, file)}:${index + 1}: ${line.trim()}`);
        if (matches.length >= maxFiles) break;
      }
    }
  }
  return createReadResult(
    source,
    {
      title: `Search: ${source.target}`,
      uri: `workspace-search://${encodeURIComponent(source.target)}`,
      mimeType: "text/plain; charset=utf-8",
      content: matches.length ? matches.join("\n") : "No matches.",
      riskFlags: []
    },
    planId
  );
}

/**
 * 执行单个读取来源。
 *
 * 使用方法：
 * - ReadPlan 执行器会逐个调用此方法。
 * - 当前第一阶段支持本地文件、文档、workspace、memory、runtime、网页、电脑配置和 workspace 搜索。
 *
 * 作用：
 * - 把不同来源映射到对应读取方法。
 * - 对尚未接入的应用内容、通信、日历和 MCP resource 给出明确错误。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeReadSource(
  source: ReadSource,
  plan: ReadPlan,
  config: AppConfig | null = null
): Promise<ReadResult> {
  switch (source.kind) {
    case "local_file":
    case "document":
    case "workspace":
    case "memory":
    case "runtime":
      return readLocalText(source, config, plan.id, plan.maxBytes);
    case "web_page":
      return readWebPage(source, plan.allowNetwork, plan.id, plan.maxBytes);
    case "computer_config":
      return readComputerConfig(source, plan.id);
    case "search":
      return searchWorkspaceText(source, config, plan.id, plan.maxFiles);
    case "app_content":
    case "communication":
    case "calendar_task":
    case "mcp_resource":
    case "app_state":
      throw new Error(`${source.kind} reading needs a connector before it can be used.`);
    default:
      return assertNever(source.kind);
  }
}

/**
 * 执行读取计划但不写入持久化事件。
 *
 * 使用方法：
 * - 测试、预览或未来 dry-run 场景可以调用它。
 * - 需要审计记录时请使用 executeAndRecordReadPlan。
 *
 * 作用：
 * - 把 ReadPlan 转成 ReadResult[] 和 ContextBlock[]。
 * - 对 optional source 读取失败会跳过，对 required source 失败会抛错。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeReadPlan(
  plan: ReadPlan,
  config: AppConfig | null = null
): Promise<ExecuteReadPlanOutput> {
  const activeConfig = config || (await loadConfig());
  const results: ReadResult[] = [];
  const contextBlocks: ContextBlock[] = [];
  for (const source of plan.sources.slice(0, plan.maxFiles)) {
    try {
      const result = await executeReadSource(source, plan, activeConfig);
      results.push(result);
      contextBlocks.push(createContextBlock(result));
    } catch (error) {
      if (source.required) throw error;
    }
  }
  return { plan, results, contextBlocks };
}

/**
 * 执行读取计划并记录 ReadEvent。
 *
 * 使用方法：
 * - API 层和 Agent Core 的正式读取入口应调用此方法。
 * - 它会为每个来源记录 planned、completed 或 failed 事件。
 *
 * 作用：
 * - 满足“默认能看，逐次不问，但必须可审计”的设计原则。
 * - 让 DAX Agent 未来能回忆自己看过哪些来源。
 *
 * @param plan 已经创建、待预览、审批、执行或表达的能力计划。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeAndRecordReadPlan(
  plan: ReadPlan,
  config: AppConfig | null = null
): Promise<ExecuteReadPlanOutput> {
  const activeConfig = config || (await loadConfig());
  const results: ReadResult[] = [];
  const contextBlocks: ContextBlock[] = [];
  for (const source of plan.sources.slice(0, plan.maxFiles)) {
    const riskLevel = inferReadRisk(source);
    await recordReadEvent({
      action: "read.planned",
      planId: plan.id,
      source,
      reason: source.purpose || plan.reason,
      riskLevel,
      riskFlags: detectRiskFlags(source)
    });
    try {
      const result = await executeReadSource(source, plan, activeConfig);
      results.push(result);
      contextBlocks.push(createContextBlock(result));
      await recordReadEvent({
        action: "read.completed",
        planId: plan.id,
        resultId: result.id,
        source,
        reason: source.purpose || plan.reason,
        riskLevel: result.riskLevel,
        riskFlags: result.riskFlags
      });
    } catch (error) {
      await recordReadEvent({
        action: "read.failed",
        planId: plan.id,
        source,
        reason: source.purpose || plan.reason,
        riskLevel,
        riskFlags: [...detectRiskFlags(source), "read_failed"]
      });
      if (source.required) throw error;
    }
  }
  return { plan, results, contextBlocks };
}

/**
 * 判断 unknown 是否是普通 JSON 对象。
 *
 * 使用方法：
 * - 解析外部 API 输入时调用。
 *
 * 作用：
 * - 缩小 TypeScript 类型，避免直接访问 unknown 字段。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从多个候选数字中取第一个正数。
 *
 * 使用方法：
 * - createReadPlan 用它处理用户输入、配置值和默认值。
 *
 * 作用：
 * - 保证 maxBytes、maxFiles 这类读取边界始终是正数。
 *
 * @param values 需要批量归一化、去重、替换或格式化的值集合。
 */
function positiveNumber(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return DEFAULT_MAX_BYTES;
}

/**
 * 计算多个风险等级中的最高等级。
 *
 * 使用方法：
 * - createReadPlan 和 inferReadRisk 都会调用。
 *
 * 作用：
 * - 让计划风险等于所有来源中最敏感的那个来源。
 *
 * @param levels 需要比较并汇总为最高风险的等级列表。
 */
function maxRiskLevel(levels: ReadRiskLevel[]): ReadRiskLevel {
  return levels.reduce<ReadRiskLevel>((current, next) => {
    return riskOrder.indexOf(next) > riskOrder.indexOf(current) ? next : current;
  }, "L0");
}

/**
 * 判断目标是否像整盘或根目录读取。
 *
 * 使用方法：
 * - inferReadRisk 用它把大范围读取标记为 L3。
 *
 * 作用：
 * - 不阻止读取，但提醒这是高敏或大范围观察。
 *
 * @param target 需要解析、读取、修改、执行或校验的目标。
 */
function looksLikeWholeDiskTarget(target: string): boolean {
  const trimmed = target.trim();
  return trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

/**
 * 把 ReadSource target 解析为本地路径。
 *
 * 使用方法：
 * - 本地文件、文档、workspace、memory 和 runtime 读取前调用。
 * - 绝对路径按原样解析，相对路径按 workspace 解析。
 *
 * 作用：
 * - 贯彻“读文件默认可以读”的设计，不把读取限制在项目目录。
 * - 同时给 workspace 场景保留相对路径的便利。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
function resolveReadPath(source: ReadSource, config: AppConfig): string {
  if (source.kind === "runtime" && source.target === "store") {
    return path.resolve(process.cwd(), "data", "store.json");
  }
  if (path.isAbsolute(source.target)) {
    return path.resolve(source.target);
  }
  return path.resolve(resolveWorkspace(config), source.target);
}

/**
 * 读取目录并生成文本列表。
 *
 * 使用方法：
 * - readLocalText 发现目标是目录时调用。
 *
 * 作用：
 * - 让眼睛既能看文件，也能先看目录结构。
 * - 目录读取只列出一层，不做递归全盘扫描。
 *
 * @param target 需要解析、读取、修改、执行或校验的目标。
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
async function readDirectoryPayload(target: string, source: ReadSource, config: AppConfig): Promise<TextReadPayload> {
  const maxFiles = config.security?.maxSearchResults || DEFAULT_MAX_FILES;
  const entries = await readdir(target, { withFileTypes: true });
  const rows = entries
    .slice(0, maxFiles)
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
  const omitted = entries.length > maxFiles ? [`... ${entries.length - maxFiles} more entries omitted`] : [];
  return {
    title: path.basename(target) || target,
    uri: `file://${target}`,
    mimeType: "text/plain; charset=utf-8",
    content: [...rows, ...omitted].join("\n") || "(empty directory)",
    riskFlags: source.kind === "workspace" ? [] : ["directory_listing"]
  };
}

/**
 * 按读取上限读取文件内容。
 *
 * 使用方法：
 * - readLocalText 和 workspace 搜索都会调用。
 * - maxBytes 控制最多读取多少字节。
 *
 * 作用：
 * - 避免大文件一次性进入内存或上下文。
 * - 如果文件被截断，会添加 large_file_truncated 风险标记。
 *
 * @param target 需要解析、读取、修改、执行或校验的目标。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 * @param maxBytes 允许读取的最大字节数；超出部分会被截断或拒绝。
 */
async function readFilePayload(target: string, config: AppConfig, maxBytes?: number): Promise<TextReadPayload> {
  const limit = positiveNumber(maxBytes, config.security?.maxReadBytes, DEFAULT_MAX_BYTES);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) {
    throw new Error("Read target is not a file.");
  }
  const bytesToRead = Math.min(fileStat.size, limit);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(target, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.toString("utf8", 0, bytesRead);
    const riskFlags = [];
    if (fileStat.size > limit) riskFlags.push("large_file_truncated");
    if (looksBinary(buffer.subarray(0, bytesRead))) riskFlags.push("likely_binary_content");
    return {
      title: path.basename(target),
      uri: `file://${target}`,
      mimeType: mimeTypeForPath(target),
      content,
      riskFlags
    };
  } finally {
    await handle.close();
  }
}

/**
 * 创建标准 ReadResult。
 *
 * 使用方法：
 * - 各类读取方法拿到 TextReadPayload 后调用。
 *
 * 作用：
 * - 统一补齐 id、createdAt、riskLevel、riskFlags、signals 和 tokenEstimate。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 * @param payload 需要返回、分析或写入的结构化载荷。
 * @param planId 用于关联计划、读取结果和审计记录的计划唯一标识。
 */
function createReadResult(source: ReadSource, payload: TextReadPayload, planId?: string): ReadResult {
  const riskFlags = detectRiskFlags(source, payload.content, payload.riskFlags);
  return {
    id: newId("rdr"),
    planId,
    source,
    title: payload.title,
    uri: payload.uri,
    mimeType: payload.mimeType,
    content: payload.content,
    summary: summarizeForContext(payload.content),
    extractedSignals: extractSignals(payload.content),
    riskLevel: inferReadRisk(source),
    riskFlags,
    tokenEstimate: estimateTokens(payload.content),
    createdAt: nowIso()
  };
}

/**
 * 判断一段字节是否像二进制内容。
 *
 * 使用方法：
 * - readFilePayload 读取文件样本后调用。
 *
 * 作用：
 * - 给图片、压缩包等非文本文件添加 likely_binary_content 标记。
 * - 第一阶段仍返回 UTF-8 解码文本，未来可接入 OCR 或转写。
 *
 * @param buffer 需要检测是否包含二进制内容的原始字节缓冲区。
 */
function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * 根据文件扩展名推断 MIME 类型。
 *
 * 使用方法：
 * - readFilePayload 创建 payload 时调用。
 *
 * 作用：
 * - 让 ReadResult 带上基础内容类型，便于 UI 和未来解析器选择处理方式。
 *
 * @param filePath 需要读取、识别 MIME 或执行路径校验的文件路径。
 */
function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".ts": "text/typescript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".pdf": "application/pdf"
  };
  return table[extension] || "application/octet-stream";
}

/**
 * 简单清理 HTML 成可读文本。
 *
 * 使用方法：
 * - readWebPage 读取 text/html 后调用。
 *
 * 作用：
 * - 去掉 script、style 和标签，让网页先以普通文本进入读取结果。
 * - 这只是第一阶段的轻量解析，未来可替换为更可靠的 DOM/Readability 解析。
 *
 * @param html 需要去除标签并转换为纯文本的 HTML 内容。
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 截断文本到指定字符数。
 *
 * 使用方法：
 * - 网页、上下文块和本地读取限制都会调用。
 *
 * 作用：
 * - 让读取结果保持在可控体积内。
 * - 在结尾标记 omitted 字符数，方便审计读取范围。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 * @param maxChars 输出允许保留的最大字符数。
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...${text.length - maxChars} characters omitted...]`;
}

/**
 * 对上下文文本做基础脱敏。
 *
 * 使用方法：
 * - createContextBlock 在内容进入工作上下文前调用。
 *
 * 作用：
 * - 减少 API key、token、password 等明文进入模型上下文的概率。
 * - 原始 ReadResult 仍保留在本次本地返回值中，不会被长期保存。
 *
 * @param text 当前要清洗、解析、检测、摘要或输出的文本。
 */
function maskSensitiveText(text: string): string {
  return text
    .replace(
      /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[private key redacted]");
}

/**
 * 根据来源推断可信度。
 *
 * 使用方法：
 * - createContextBlock 生成 trust 字段时调用。
 *
 * 作用：
 * - 本地文件通常更可信，网页和搜索结果默认更低。
 * - 后续可以接入来源信誉、签名和时间戳机制。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 */
function trustForSource(source: ReadSource): ContextBlock["trust"] {
  if (source.kind === "web_page" || source.kind === "search") return "low";
  if (source.kind === "mcp_resource" || source.kind === "app_content") return "medium";
  return "high";
}

/**
 * 根据来源推断新鲜度。
 *
 * 使用方法：
 * - createContextBlock 生成 freshness 字段时调用。
 *
 * 作用：
 * - 电脑配置、运行状态和网页读取发生在当前时刻，默认 fresh。
 * - 普通文件没有读取其修改时间进入结构，暂时标记 unknown。
 *
 * @param source 当前要读取、转换、评估或建立上下文的来源定义。
 */
function freshnessForSource(source: ReadSource): ContextBlock["freshness"] {
  if (source.kind === "computer_config" || source.kind === "web_page" || source.kind === "app_state") return "fresh";
  return "unknown";
}

/**
 * 生成网络接口摘要。
 *
 * 使用方法：
 * - readComputerConfig 构造系统配置 JSON 时调用。
 *
 * 作用：
 * - 让 Agent 能看到本机网络状态的大致形态。
 * - 只记录地址族、internal 和 mac 等基础信息，仍会被 local_system_state 标记。
 */
function networkInterfaceSummary(): JsonObject {
  return Object.fromEntries(
    Object.entries(os.networkInterfaces()).map(([name, items]) => [
      name,
      (items || []).map((item) => ({
        address: item.address,
        family: item.family,
        internal: item.internal,
        mac: item.mac
      }))
    ])
  );
}

/**
 * 递归收集 workspace 中的候选文本文件。
 *
 * 使用方法：
 * - searchWorkspaceText 搜索前调用。
 * - maxFiles 控制最多检查多少文件，避免无边界扫描。
 *
 * 作用：
 * - 给搜索能力提供有限、可审计的候选集合。
 * - 跳过常见构建目录和依赖目录。
 *
 * @param root 递归读取或扫描开始时使用的根目录。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 * @param maxFiles 递归扫描时允许收集的最大文件数量。
 * @param results 需要汇总、格式化或返回的多个能力结果。
 */
async function walkTextFiles(root: string, config: AppConfig, maxFiles: number, results: string[] = []): Promise<string[]> {
  if (results.length >= maxFiles) return results;
  const ignoredDirs = new Set([".git", "node_modules", "data", ".venv", "venv", "dist", "build"]);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(fullPath, config, maxFiles, results);
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      if (fileStat.size <= (config.security?.maxReadBytes || DEFAULT_MAX_BYTES)) results.push(fullPath);
    }
  }
  return results;
}

/**
 * 保证 switch 已覆盖全部 ReadSourceKind。
 *
 * 使用方法：
 * - executeReadSource 的 default 分支调用。
 *
 * 作用：
 * - 新增来源类型时让 TypeScript 提醒我们补实现。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled read source kind: ${value}`);
}
