import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEARCH_TIMEOUT_MS = 15000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1]?.trim() || "");
}

function parseBingRss(xml: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] || "";
    const title = xmlTag(block, "title");
    const url = xmlTag(block, "link");
    const description = xmlTag(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, description });
    if (results.length >= limit) break;
  }
  return results;
}

async function searchWeb(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const variants = normalizedQuery.includes(" ")
    ? [`"${normalizedQuery}"`, normalizedQuery]
    : [normalizedQuery];
  const combined: WebSearchResult[] = [];
  for (const variant of variants) {
    combined.push(...await searchBingRss(variant, MAX_RESULTS));
  }
  const seen = new Set<string>();
  const tokens = normalizedQuery.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  return combined
    .filter((result) => {
      const key = result.url.replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((result, index) => {
      const haystack = `${result.title} ${result.description} ${result.url}`.toLowerCase();
      const exact = haystack.includes(normalizedQuery.toLowerCase()) ? 20 : 0;
      const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 3 : 0), 0);
      return { result, score: exact + tokenScore - index * 0.01 };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults)
    .map((entry) => entry.result);
}

async function searchBingRss(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "rss");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/rss+xml, application/xml, text/xml",
        "User-Agent": "DAX-Agent/0.1 (+local MCP web search)"
      }
    });
    if (!response.ok) throw new Error(`Bing RSS returned HTTP ${response.status}.`);
    return parseBingRss(await response.text(), maxResults);
  } finally {
    clearTimeout(timeout);
  }
}

const server = new McpServer({
  name: "dax-web-search",
  version: "0.1.0"
});

server.registerTool(
  "web_search",
  {
    title: "Search the public web",
    description: "Search the public web and return a bounded list of result titles, URLs, and snippets.",
    inputSchema: {
      query: z.string().min(2).max(500),
      maxResults: z.number().int().min(1).max(MAX_RESULTS).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ query, maxResults }) => {
    const results = await searchWeb(query, maxResults || DEFAULT_RESULTS);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ query, results }, null, 2)
        }
      ],
      structuredContent: { query, results }
    };
  }
);

await server.connect(new StdioServerTransport());
