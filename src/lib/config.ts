import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, DeepPartial, JsonObject } from "./types.js";

const rootDir = process.cwd();
const defaultConfigPath = path.join(rootDir, "config", "default.json");
const localConfigPath = path.join(rootDir, "config", "local.json");

/**
 * 使用方法：配置合并前传入 unknown 值进行类型收窄。
 * 作用：区分普通 JSON 对象与 null、数组和基础类型。
 * 边界：只做运行时形状判断，不验证具体配置字段。
 *
 * @param value 当前要校验、转换、清洗或格式化的输入值。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 使用方法：将默认配置、local 配置和调用方 overrides 依次传入合并。
 * 作用：递归合并普通 JSON 对象，同时让后传值覆盖先传值。
 * 边界：数组和基础值整体覆盖，不执行 schema 校验或秘密脱敏。
 *
 * @param base 深度合并时保留默认值的基础对象。
 * @param override 覆盖基础对象对应字段的增量配置。
 */
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

/**
 * 使用方法：loadConfig() 或 saveLocalConfig() 读取 JSON 配置文件时调用。
 * 作用：读取并解析存在的 JSON 文件；文件不存在时返回空对象。
 * 边界：只忽略 ENOENT，格式错误和其他 I/O 错误会继续抛出。
 *
 * @param filePath 需要读取、识别 MIME 或执行路径校验的文件路径。
 */
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

/**
 * 使用方法：完成文件配置合并后传入 AppConfig。
 * 作用：让 DAX_* 环境变量覆盖本地配置，并返回独立副本。
 * 边界：不会修改输入对象，也不会把环境变量写回 config/local.json。
 *
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
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

/**
 * 使用方法：服务器、能力模块和测试需要有效配置时调用，可传入临时 overrides。
 * 作用：按 default -> local -> overrides -> environment 顺序生成最终 AppConfig。
 * 边界：返回值包含运行时密钥，不能直接发送给浏览器；HTTP API 必须先调用 maskConfig()。
 *
 * @param overrides 调用方提供、优先级高于本地和环境配置的覆盖项。
 */
export async function loadConfig(overrides: JsonObject = {}): Promise<AppConfig> {
  const defaults = await readJsonIfExists(defaultConfigPath);
  const local = await readJsonIfExists(localConfigPath);
  return applyEnv(mergeDeep(mergeDeep(defaults, local), overrides) as unknown as AppConfig);
}

/**
 * 使用方法：设置 API 校验 patch 后调用。
 * 作用：把局部配置深度合并进 config/local.json 并持久化。
 * 边界：只保存调用方明确传入的字段，不负责验证 Provider 或测试模型连接。
 *
 * @param patch 需要合并到现有配置、记录或对象中的增量字段。
 */
export async function saveLocalConfig(patch: DeepPartial<AppConfig>): Promise<JsonObject> {
  const current = await readJsonIfExists(localConfigPath);
  const next = mergeDeep(current, patch as JsonObject);
  await mkdir(path.dirname(localConfigPath), { recursive: true });
  await writeFile(localConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * 使用方法：GET/PUT /api/config 返回配置前调用。
 * 作用：复制配置并把 API key 替换为掩码，同时设置 hasApiKey。
 * 边界：绝不能用返回的掩码值覆盖真实密钥；该结果只适合展示。
 *
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
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

/**
 * 使用方法：读、手、脚和工具模块需要 workspace 根目录时调用。
 * 作用：把配置中的相对 workspace 转为基于进程根目录的绝对路径。
 * 边界：只解析根路径，具体目标是否越界仍由各能力模块检查。
 *
 * @param config 当前生效的应用配置，提供 workspace、模型和安全策略等设置。
 */
export function resolveWorkspace(config: AppConfig): string {
  const workspace = config.app?.workspace || ".";
  return path.resolve(rootDir, workspace);
}
