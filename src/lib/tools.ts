import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveWorkspace } from "./config.js";
import { executeAndRecordFootPlan, formatFootResultOutput } from "./foot.js";
import { updateToolRun } from "./store.js";
import type { AppConfig, JsonObject, ToolDefinition, ToolRun } from "./types.js";

const ignoredDirs = new Set([".git", "node_modules", "data", ".venv", "venv", "dist", "build"]);

export const toolManifest: ToolDefinition[] = [
  {
    name: "workspace.list",
    description: "List files and folders inside the workspace.",
    approvalRequired: false,
    inputSchema: { path: "string optional, defaults to ." }
  },
  {
    name: "workspace.read",
    description: "Read a text file inside the workspace.",
    approvalRequired: false,
    inputSchema: { path: "string required" }
  },
  {
    name: "workspace.search",
    description: "Search text files inside the workspace.",
    approvalRequired: false,
    inputSchema: { query: "string required", path: "string optional, defaults to ." }
  },
  {
    name: "shell.run",
    description: "Run a shell command inside the workspace after explicit user approval.",
    approvalRequired: true,
    inputSchema: { command: "string required", cwd: "string optional, defaults to workspace root" }
  }
];

/**
 * 使用方法：根据模型路由或 slash command 的工具名称查询 manifest。
 * 作用：返回匹配的 ToolDefinition，供审批和执行流程检查。
 * 边界：未知工具返回 null，不进行模糊匹配。
 *
 * @param name 需要查找或执行的工具、资源或配置名称。
 */
export function getTool(name: string): ToolDefinition | null {
  return toolManifest.find((tool) => tool.name === name) || null;
}

/**
 * 使用方法：工具实现从 JsonObject 读取 path、query、command 等字符串字段时调用。
 * 作用：只接受字符串并过滤空值。
 * 边界：不做路径解析、命令验证或类型转换。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param key 要读取、翻译、索引或匹配的字段键名。
 */
function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 使用方法：workspace list/read/search 处理用户目标路径前调用。
 * 作用：解析绝对路径并确认目标没有逃出 workspace。
 * 边界：只保护路径边界，不检查文件内容、权限或符号链接的外部语义。
 *
 * @param target 需要解析、读取、修改、执行或校验的目标。
 * @param workspace 限制文件读取、搜索、修改和命令执行范围的 workspace 根目录。
 */
function ensureInsideWorkspace(target: string | undefined, workspace: string): string {
  const resolved = path.resolve(workspace, target || ".");
  const relative = path.relative(workspace, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("Path escapes the configured workspace.");
}

/**
 * 使用方法：executeTool() 处理 workspace.list 时调用。
 * 作用：列出目标目录的一层文件和子目录并返回文本结果。
 * 边界：不会递归读取内容，也不会显示被忽略目录内部信息。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
async function listWorkspace(input: JsonObject, config: AppConfig): Promise<string> {
  const workspace = resolveWorkspace(config);
  const target = ensureInsideWorkspace(stringInput(input, "path") || ".", workspace);
  const entries = await readdir(target, { withFileTypes: true });
  const rows = entries
    .filter((entry) => !ignoredDirs.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
  return rows.length ? rows.join("\n") : "(empty)";
}

/**
 * 使用方法：executeTool() 处理 workspace.read 时调用。
 * 作用：读取 workspace 内普通文件并限制最大字节数。
 * 边界：拒绝目录和超大文件，不负责解析文档格式。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
async function readWorkspaceFile(input: JsonObject, config: AppConfig): Promise<string> {
  const requestedPath = stringInput(input, "path");
  if (!requestedPath) throw new Error("workspace.read requires input.path.");
  const workspace = resolveWorkspace(config);
  const target = ensureInsideWorkspace(requestedPath, workspace);
  const fileStat = await stat(target);
  if (!fileStat.isFile()) throw new Error("Target is not a file.");
  const maxBytes = Number(config.security?.maxReadBytes || 120000);
  if (fileStat.size > maxBytes) {
    throw new Error(`File is ${fileStat.size} bytes, above the ${maxBytes} byte read limit.`);
  }
  return readFile(target, "utf8");
}

/**
 * 使用方法：workspace.search 需要递归文件清单时调用。
 * 作用：遍历 workspace，跳过忽略目录并收集普通文件。
 * 边界：只返回路径，不读取内容；结果受 workspace 边界保护。
 *
 * @param root 递归读取或扫描开始时使用的根目录。
 * @param workspace 限制文件读取、搜索、修改和命令执行范围的 workspace 根目录。
 * @param results 需要汇总、格式化或返回的多个能力结果。
 */
async function walkFiles(root: string, workspace: string, results: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, workspace, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 使用方法：搜索或读取候选 Buffer 前调用。
 * 作用：通过空字节和不可打印字符比例判断文件是否可能是二进制。
 * 边界：这是启发式检测，不替代 MIME 或专业文件识别。
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
 * 使用方法：executeTool() 处理 workspace.search 时调用。
 * 作用：在 workspace 文本文件中查找关键词并限制结果数量。
 * 边界：跳过二进制和读取失败文件，不执行正则表达式。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
async function searchWorkspace(input: JsonObject, config: AppConfig): Promise<string> {
  const query = stringInput(input, "query");
  if (!query) throw new Error("workspace.search requires input.query.");
  const workspace = resolveWorkspace(config);
  const target = ensureInsideWorkspace(stringInput(input, "path") || ".", workspace);
  const maxResults = Number(config.security?.maxSearchResults || 50);
  const files = await walkFiles(target, workspace);
  const matches = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    const fileStat = await stat(file);
    if (fileStat.size > Number(config.security?.maxReadBytes || 120000)) continue;
    const buffer = await readFile(file);
    if (looksBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] || "").toLowerCase().includes(query.toLowerCase())) {
        const relative = path.relative(workspace, file);
        matches.push(`${relative}:${index + 1}: ${(lines[index] || "").trim()}`);
        if (matches.length >= maxResults) break;
      }
    }
  }
  return matches.length ? matches.join("\n") : "No matches.";
}

/**
 * 使用方法：审批后的 shell.run ToolRun 由 executeTool() 调用。
 * 作用：把命令转换成 FootPlan 并复用脚能力执行、审计和输出格式化。
 * 边界：调用此方法前必须已经完成工具审批；它不接受未审批的直接自然语言执行。
 *
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
async function runShell(input: JsonObject, config: AppConfig): Promise<string> {
  const command = stringInput(input, "command");
  if (!command) throw new Error("shell.run requires input.command.");
  const execution = await executeAndRecordFootPlan(
    {
      goal: "Run an approved shell command.",
      reason: "A shell.run tool request was approved by the user.",
      actions: [
        {
          kind: "run_command",
          targetKind: "workspace",
          command,
          cwd: stringInput(input, "cwd") || ".",
          reason: "Execute the approved shell.run command.",
          expectedEffect: "Produce command output for the tool run.",
          inputSummary: command
        }
      ],
      expectedOutcome: "The command completes and returns stdout or stderr."
    },
    { approved: true },
    config
  );
  const output = formatFootResultOutput(execution.result);
  if (execution.result.status !== "completed" && execution.result.status !== "skipped") {
    throw new Error(output);
  }
  return output;
}

/**
 * 使用方法：已确定工具名称和输入后调用。
 * 作用：把 workspace.list/read/search 和 shell.run 路由到对应实现。
 * 边界：未知工具会抛错；该入口不创建审批记录。
 *
 * @param name 需要查找或执行的工具、资源或配置名称。
 * @param input 当前方法所需的结构化输入，字段含义由对应输入类型定义。
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export async function executeTool(
  name: string,
  input: JsonObject = {},
  config: AppConfig | null = null
): Promise<string> {
  const activeConfig = config || (await loadConfig());
  switch (name) {
    case "workspace.list":
      return listWorkspace(input || {}, activeConfig);
    case "workspace.read":
      return readWorkspaceFile(input || {}, activeConfig);
    case "workspace.search":
      return searchWorkspace(input || {}, activeConfig);
    case "shell.run":
      return runShell(input || {}, activeConfig);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * 使用方法：工具面板批准请求后传入 runId。
 * 作用：读取 ToolRun、更新 running/completed/failed 状态并执行对应工具。
 * 边界：只执行 approved 或无需审批的请求，不会绕过状态检查。
 *
 * @param runId 需要查询、审批或执行的工具运行唯一标识。
 */
export async function executeToolRun(runId: string): Promise<ToolRun | null> {
  const { getToolRun } = await import("./store.js");
  const run = await getToolRun(runId);
  if (!run) throw new Error("Tool run not found.");
  await updateToolRun(
    runId,
    {
      status: "running",
      approvedAt: run.approvedAt || new Date().toISOString()
    },
    "tool.running"
  );
  try {
    const output = await executeTool(run.tool, run.input);
    return updateToolRun(
      runId,
      {
        status: "completed",
        output,
        error: "",
        completedAt: new Date().toISOString()
      },
      "tool.completed"
    );
  } catch (error) {
    return updateToolRun(
      runId,
      {
        status: "failed",
        output: "",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      },
      "tool.failed"
    );
  }
}
