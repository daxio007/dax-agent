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
  publishedAt?: string;
}

const NEWS_FEEDS = [
  "https://www.chinanews.com.cn/rss/china.xml",
  "https://www.chinanews.com.cn/rss/world.xml",
  "https://www.chinanews.com.cn/rss/finance.xml",
  "https://www.chinanews.com.cn/rss/culture.xml"
];

const preferredNewsDomains = [
  "chinanews.com.cn",
  "news.cctv.com",
  "xinhuanet.com",
  "news.cn",
  "people.com.cn",
  "thepaper.cn",
  "yicai.com",
  "caixin.com",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "cnn.com",
  "aljazeera.com",
  "dw.com",
  "france24.com"
];

/**
 * 使用方法：在 decodeXml 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param value 当前方法使用的 value 参数。
 */

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

/**
 * 使用方法：在 xmlTag 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param block 当前方法使用的 block 参数。
 * @param tag 当前方法使用的 tag 参数。
 */

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1]?.trim() || "");
}

/**
 * 使用方法：在 parseBingRss 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param xml 当前方法使用的 xml 参数。
 * @param limit 当前方法使用的 limit 参数。
 */

function parseBingRss(xml: string, limit: number): WebSearchResult[] {
  return parseRssItems(xml, limit);
}

/**
 * 使用方法：解析 RSS XML 时传入原始 XML 和最大条数。
 * 作用：从 Bing 或新闻站 RSS 中提取可展示、可去重的搜索结果。
 * @param xml 当前需要解析的 RSS XML 字符串。
 * @param limit 最多返回的条目数量。
 */
function parseRssItems(xml: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] || "";
    const title = xmlTag(block, "title");
    const url = xmlTag(block, "link");
    const description = xmlTag(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const publishedAt = xmlTag(block, "pubDate");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, description, ...(publishedAt ? { publishedAt } : {}) });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * 使用方法：在 searchWeb 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param query 当前方法使用的 query 参数。
 * @param maxResults 当前方法使用的 maxResults 参数。
 */

async function searchWeb(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const newsQuery = isNewsQuery(normalizedQuery);
  const variants = newsQuery
    ? newsQueryVariants(normalizedQuery)
    : normalizedQuery.includes(" ")
      ? [normalizedQuery, `"${normalizedQuery}"`]
      : [normalizedQuery];
  const combined: WebSearchResult[] = [];
  if (newsQuery) {
    const feedResults = await Promise.allSettled(
      NEWS_FEEDS.map((feed) => fetchRssUrl(feed, Math.max(maxResults, DEFAULT_RESULTS)))
    );
    const buckets = feedResults
      .filter((result): result is PromiseFulfilledResult<WebSearchResult[]> => result.status === "fulfilled")
      .map((result) => result.value);
    const bucketSize = Math.max(0, ...buckets.map((bucket) => bucket.length));
    for (let index = 0; index < bucketSize; index += 1) {
      for (const bucket of buckets) {
        const result = bucket[index];
        if (result) combined.push(result);
      }
    }
  }
  for (const variant of variants) {
    combined.push(...await searchBingRss(variant, MAX_RESULTS).catch(() => []));
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
      const newsScore = newsQuery ? scoreNewsResult(result, haystack) : 0;
      return { result, score: exact + tokenScore + newsScore - index * 0.01 };
    })
    .filter((entry) => entry.score > (newsQuery ? -5 : 0))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults)
    .map((entry) => entry.result);
}

/**
 * 使用方法：搜索前传入用户 query。
 * 作用：判断是否应启用新闻源、新闻站点加权和百科降权。
 * @param query 当前搜索关键词。
 */
function isNewsQuery(query: string): boolean {
  return /新闻|资讯|咨询|消息|热点|头条|latest|news/i.test(query);
}

/**
 * 使用方法：新闻搜索时传入清洗后的 query。
 * 作用：生成多组更容易命中新闻站点和新闻频道的搜索词。
 * @param query 当前搜索关键词。
 */
function newsQueryVariants(query: string): string[] {
  const normalized = query
    .replace(/\b20\d{2}年\d{1,2}月\d{1,2}[日号]?\b/g, "")
    .replace(/星期[一二三四五六日天]|周[一二三四五六日天]/g, "")
    .replace(/咨询/g, "资讯")
    .replace(/\s+/g, " ")
    .trim();
  const variants = [
    normalized || "今日新闻 最新",
    "今日 国内 新闻 最新",
    "今日 国际 新闻 最新",
    "国内 国际 今日新闻 最新",
    "site:www.chinanews.com.cn 今日 新闻",
    "site:news.cctv.com 今日 新闻",
    "site:www.xinhuanet.com 今日 新闻",
    "site:www.people.com.cn 今日 新闻",
    "site:reuters.com world news today",
    "site:bbc.com/news world news today"
  ];
  return [...new Set(variants.filter(Boolean))].slice(0, 10);
}

/**
 * 使用方法：新闻查询结果排序时传入单条结果和已拼接的小写文本。
 * 作用：优先真实新闻源和带发布时间的 RSS 条目，降低百科、赛程等非新闻结果。
 * @param result 当前搜索结果。
 * @param haystack 当前搜索结果拼接后的可匹配文本。
 */
function scoreNewsResult(result: WebSearchResult, haystack: string): number {
  let score = result.publishedAt ? 12 : 0;
  if (preferredNewsDomains.some((domain) => haystack.includes(domain))) score += 18;
  if (/\/20\d{2}\/\d{2}(?:-\d{2}|\/\d{2})\//i.test(result.url)) score += 28;
  if (/\/(?:news|world|china|gj|gn|cj|fortune|finance)\//i.test(result.url)) score += 6;
  if (/\/(?:china|world|news|gn|gj|finance|fortune|native|jsxw)\/?$|\/index\.html$/i.test(result.url)) score -= 18;
  if (/百科|baike|wikipedia|赛程|世界杯赛程|calendar|schedule|fixture/i.test(haystack)) score -= 40;
  if (/新闻|资讯|快讯|时政|国际|国内|world|latest|today/i.test(haystack)) score += 6;
  return score;
}

/**
 * 使用方法：在 searchBingRss 的调用点传入所需参数并调用。
 * 作用：支撑当前模块的业务流程并保持调用入口可审计。
 * @param query 当前方法使用的 query 参数。
 * @param maxResults 当前方法使用的 maxResults 参数。
 */

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

/**
 * 使用方法：新闻搜索兜底时传入 RSS feed URL 和最大条数。
 * 作用：直接读取可用新闻源，避免普通网页搜索只返回百科或门户首页。
 * @param url 当前需要读取的 RSS feed URL。
 * @param maxResults 最多返回的新闻条目数量。
 */
async function fetchRssUrl(url: string, maxResults: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/rss+xml, application/xml, text/xml",
        "User-Agent": "DAX-Agent/0.1 (+local MCP web search)"
      }
    });
    if (!response.ok) throw new Error(`RSS returned HTTP ${response.status}.`);
    return parseRssItems(await response.text(), maxResults);
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
