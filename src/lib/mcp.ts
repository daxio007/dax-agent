import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonObject } from "./types.js";

type McpServerId = "web-search" | "browser";

interface ManagedClient {
  client: Client;
  transport: StdioClientTransport;
}

interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
}

const clients = new Map<McpServerId, Promise<ManagedClient>>();
let browserQueue: Promise<void> = Promise.resolve();

/**
 * 使用方法：在 serverCommand 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param serverId 当前方法使用的 serverId 参数。
 */

function serverCommand(serverId: McpServerId): { command: string; args: string[] } {
  if (serverId === "web-search") {
    return {
      command: process.execPath,
      args: [path.resolve(process.cwd(), "dist", "mcp", "web-search-server.js")]
    };
  }
  return {
    command: process.execPath,
    args: [
      path.resolve(process.cwd(), "node_modules", "@playwright", "mcp", "cli.js"),
      "--headless",
      "--browser",
      "msedge",
      "--isolated",
      "--output-mode",
      "stdout"
    ]
  };
}

/**
 * 使用方法：在 connectClient 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param serverId 当前方法使用的 serverId 参数。
 */

async function connectClient(serverId: McpServerId): Promise<ManagedClient> {
  const command = serverCommand(serverId);
  const transport = new StdioClientTransport({
    ...command,
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({
    name: `dax-agent-${serverId}`,
    version: "0.1.0"
  });
  await client.connect(transport);
  return { client, transport };
}

/**
 * 使用方法：在 getClient 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param serverId 当前方法使用的 serverId 参数。
 */

async function getClient(serverId: McpServerId): Promise<Client> {
  let pending = clients.get(serverId);
  if (!pending) {
    pending = connectClient(serverId);
    clients.set(serverId, pending);
  }
  try {
    return (await pending).client;
  } catch (error) {
    clients.delete(serverId);
    throw error;
  }
}

/**
 * 使用方法：在 toolText 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param result 当前方法使用的 result 参数。
 */

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result && Array.isArray(result.content)
    ? result.content
    : [];
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

/**
 * 使用方法：在 callTool 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param serverId 当前方法使用的 serverId 参数。
 * @param name 当前方法使用的 name 参数。
 * @param args 当前方法使用的 args 参数。
 */

async function callTool(serverId: McpServerId, name: string, args: JsonObject): Promise<string> {
  const client = await getClient(serverId);
  const result = await client.callTool({
    name,
    arguments: args
  });
  if (result.isError) {
    throw new Error(toolText(result) || `${serverId}.${name} failed.`);
  }
  return toolText(result);
}

/**
 * 使用方法：在 searchWebWithMcp 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param query 当前方法使用的 query 参数。
 * @param maxResults 当前方法使用的 maxResults 参数。
 */

export async function searchWebWithMcp(query: string, maxResults = 5): Promise<WebSearchResponse> {
  const text = await callTool("web-search", "web_search", {
    query,
    maxResults
  });
  const parsed = JSON.parse(text) as Partial<WebSearchResponse>;
  return {
    query: typeof parsed.query === "string" ? parsed.query : query,
    results: Array.isArray(parsed.results)
      ? parsed.results.filter(
          (item): item is WebSearchResult =>
            Boolean(item) &&
            typeof item.title === "string" &&
            typeof item.url === "string" &&
            /^https?:\/\//i.test(item.url) &&
            typeof item.description === "string"
        )
      : []
  };
}

/**
 * 使用方法：在 readWebPageWithMcp 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param url 当前方法使用的 url 参数。
 * @param maxChars 当前方法使用的 maxChars 参数。
 */

export async function readWebPageWithMcp(url: string, maxChars = 30000): Promise<string> {
  /**
   * 使用方法：作为 readWebPageWithMcp 队列释放回调的默认占位函数。
   * 作用：保证 finally 阶段始终可以安全调用队列释放逻辑。
   */
  function noopResolveQueue(): void {}

  let resolveQueue: () => void = noopResolveQueue;
  const previous = browserQueue;
  browserQueue = new Promise<void>((resolve) => {
    resolveQueue = resolve;
  });
  await previous;
  try {
    await callTool("browser", "browser_navigate", { url });
    const snapshot = await callTool("browser", "browser_snapshot", { depth: 16 });
    return snapshot.length <= maxChars
      ? snapshot
      : `${snapshot.slice(0, maxChars)}\n\n[page snapshot truncated]`;
  } finally {
    resolveQueue();
  }
}

/**
 * 使用方法：在 closeMcpClients 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 */

export async function closeMcpClients(): Promise<void> {
  const active = [...clients.values()];
  clients.clear();
  await Promise.allSettled(
    active.map(async (pending) => {
      const managed = await pending;
      await managed.client.close();
    })
  );
}
