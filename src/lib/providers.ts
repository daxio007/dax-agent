import type { AppConfig, ChatCompletion, ChatMessage, Locale } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * 使用方法：completeChat() 构造请求地址前传入 provider 和配置 Base URL。
 * 作用：移除末尾斜杠，并为 OpenAI 与 Ollama 提供默认地址。
 * 边界：只规范化地址字符串，不验证网络可达性。
 *
 * @param provider 当前模型 Provider 标识，用于选择地址和调用协议。
 * @param baseUrl 模型服务的基础 URL，用于拼接兼容接口地址。
 */
function normalizeBaseUrl(provider: string, baseUrl: string): string {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

/**
 * 使用方法：echo provider 生成本地回复时传入 Locale。
 * 作用：统一判断是否应使用中文默认文案。
 * 边界：只判断 locale 前缀，不改变模型请求内容。
 *
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function isZh(locale: Locale): boolean {
  return String(locale || "").toLowerCase().startsWith("zh");
}

/**
 * 使用方法：Provider 为 echo 时传入消息历史和 locale。
 * 作用：生成无需外部模型即可显示的本地说明回复。
 * 边界：不会进行语义推理、工具调用或网络请求。
 *
 * @param messages 用于查找上下文、模型推理或界面渲染的消息列表。
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
function echoResponse(messages: ChatMessage[], locale: Locale = "zh-CN"): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = lastUser?.content || "";
  if (text.startsWith("/")) {
    if (isZh(locale)) {
      return "我已经通过本地网关处理了这条命令。";
    }
    return "I handled that local command through the gateway.";
  }
  if (isZh(locale)) {
    return [
      "DAX Agent 当前运行在 echo 模式。",
      "",
      "在设置中配置 OpenAI-compatible Provider 后，就可以获得真实模型回复。",
      "你现在已经可以尝试 `/help`、`/list .`、`/read README.md`、`/search agent` 或 `/run node --version`。"
    ].join("\n");
  }
  return [
    "DAX Agent is running in echo mode.",
    "",
    "Configure an OpenAI-compatible provider in Settings to get real model responses.",
    "You can already try local commands like `/help`, `/list .`, `/read README.md`, `/search agent`, or `/run node --version`."
  ].join("\n");
}

/**
 * 使用方法：Agent Core 或连接测试传入 AppConfig、ChatMessage[] 和 locale。
 * 作用：统一调用 echo、OpenAI-compatible 或 Ollama-compatible chat completions。
 * 边界：只返回模型文本，不信任其决策；Agent Core 仍需解析、校验和执行 Policy Gate。
 *
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 * @param messages 用于查找上下文、模型推理或界面渲染的消息列表。
 * @param locale 用户界面或消息的区域语言标识，用于选择中英文表达。
 */
export async function completeChat(
  config: AppConfig,
  messages: ChatMessage[],
  locale: Locale = "zh-CN"
): Promise<ChatCompletion> {
  const provider = config.model?.provider || "echo";
  if (provider === "echo") {
    return {
      provider,
      model: "local-echo",
      content: echoResponse(messages, locale)
    };
  }

  const baseUrl = normalizeBaseUrl(provider, config.model?.baseUrl);
  const apiKey = config.model?.apiKey || "";
  const model = config.model?.model || (provider === "ollama" ? "llama3.1" : "gpt-4.1");
  if (!baseUrl) throw new Error(`Missing baseUrl for provider ${provider}.`);
  if (provider === "openai" && !apiKey) throw new Error("Missing API key for OpenAI provider.");

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(config.model?.temperature ?? 0.2)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model request failed (${response.status}): ${detail}`);
  }

  const body = await response.json() as ChatCompletionResponse;
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Model response did not include assistant content.");
  }

  return {
    provider,
    model,
    content
  };
}
