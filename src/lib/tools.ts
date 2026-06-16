import { exec } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveWorkspace } from "./config.js";
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

export function getTool(name: string): ToolDefinition | null {
  return toolManifest.find((tool) => tool.name === name) || null;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function ensureInsideWorkspace(target: string | undefined, workspace: string): string {
  const resolved = path.resolve(workspace, target || ".");
  const relative = path.relative(workspace, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("Path escapes the configured workspace.");
}

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

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

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

async function runShell(input: JsonObject, config: AppConfig): Promise<string> {
  if (!config.security?.allowShell) {
    throw new Error("Shell execution is disabled in config.");
  }
  const command = stringInput(input, "command");
  if (!command) throw new Error("shell.run requires input.command.");
  const workspace = resolveWorkspace(config);
  const cwd = ensureInsideWorkspace(stringInput(input, "cwd") || ".", workspace);
  const timeout = Number(config.security?.commandTimeoutMs || 30000);

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (error) {
          const message = combined || error.message;
          reject(new Error(message));
          return;
        }
        resolve(combined || "(command completed with no output)");
      }
    );
  });
}

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
