import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, DeepPartial, JsonObject } from "./types.js";

const rootDir = process.cwd();
const defaultConfigPath = path.join(rootDir, "config", "default.json");
const localConfigPath = path.join(rootDir, "config", "local.json");

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep<T extends JsonObject>(base: T, override: JsonObject = {}): T {
  const output: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      isJsonObject(value) &&
      isJsonObject(output[key])
    ) {
      output[key] = mergeDeep(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

async function readJsonIfExists(filePath: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function applyEnv(config: AppConfig): AppConfig {
  const next = structuredClone(config);
  if (process.env.DAX_HOST) next.app.host = process.env.DAX_HOST;
  if (process.env.DAX_PORT) next.app.port = Number(process.env.DAX_PORT);
  if (process.env.DAX_WORKSPACE) next.app.workspace = process.env.DAX_WORKSPACE;
  if (process.env.DAX_MODEL_PROVIDER) next.model.provider = process.env.DAX_MODEL_PROVIDER;
  if (process.env.DAX_MODEL) next.model.model = process.env.DAX_MODEL;
  if (process.env.DAX_MODEL_BASE_URL) next.model.baseUrl = process.env.DAX_MODEL_BASE_URL;
  if (process.env.DAX_OPENAI_BASE_URL) next.model.baseUrl = process.env.DAX_OPENAI_BASE_URL;
  if (process.env.DAX_OPENAI_API_KEY) next.model.apiKey = process.env.DAX_OPENAI_API_KEY;
  if (process.env.DAX_OLLAMA_BASE_URL) next.model.baseUrl = process.env.DAX_OLLAMA_BASE_URL;
  return next;
}

export async function loadConfig(overrides: JsonObject = {}): Promise<AppConfig> {
  const defaults = await readJsonIfExists(defaultConfigPath);
  const local = await readJsonIfExists(localConfigPath);
  return applyEnv(mergeDeep(mergeDeep(defaults, local), overrides) as unknown as AppConfig);
}

export async function saveLocalConfig(patch: DeepPartial<AppConfig>): Promise<JsonObject> {
  const current = await readJsonIfExists(localConfigPath);
  const next = mergeDeep(current, patch as JsonObject);
  await mkdir(path.dirname(localConfigPath), { recursive: true });
  await writeFile(localConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function maskConfig(config: AppConfig): AppConfig {
  const copy = structuredClone(config);
  if (copy.model?.apiKey) {
    const key = copy.model.apiKey;
    copy.model.apiKey = key.length <= 8 ? "********" : `${key.slice(0, 4)}...${key.slice(-4)}`;
    copy.model.hasApiKey = true;
  } else if (copy.model) {
    copy.model.hasApiKey = false;
  }
  return copy;
}

export function resolveWorkspace(config: AppConfig): string {
  const workspace = config.app?.workspace || ".";
  return path.resolve(rootDir, workspace);
}
