import type { AppConfig, ChatCompletion, ChatMessage, Locale } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function normalizeBaseUrl(provider: string, baseUrl: string): string {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  if (provider === "ollama") return "http://127.0.0.1:11434/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

function isZh(locale: Locale): boolean {
  return String(locale || "").toLowerCase().startsWith("zh");
}

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
