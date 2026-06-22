type Locale = "zh-CN" | "en-US";
type MessageRole = "system" | "user" | "assistant";
type ToolStatus = "pending" | "approved" | "running" | "completed" | "failed" | "rejected";
type TranslationKey =
  | "brandSubtitle"
  | "newSession"
  | "sessionFallback"
  | "checkingGateway"
  | "refresh"
  | "settings"
  | "chatAria"
  | "toolRunsAria"
  | "messagePlaceholder"
  | "send"
  | "toolRuns"
  | "pendingCount"
  | "noSessions"
  | "messageCount"
  | "emptyChat"
  | "noToolRuns"
  | "approve"
  | "reject"
  | "provider"
  | "baseUrl"
  | "model"
  | "apiKey"
  | "apiKeyPlaceholder"
  | "apiKeyStored"
  | "apiKeyMissing"
  | "apiKeyWillReplace"
  | "providerHintEcho"
  | "providerHintOpenAI"
  | "providerHintOllama"
  | "autoRunReadTools"
  | "cancel"
  | "testConnection"
  | "testingConnection"
  | "saveSettings"
  | "savingSettings"
  | "settingsSaved"
  | "connectionSuccess"
  | "echoNotExternal"
  | "baseUrlRequired"
  | "baseUrlInvalid"
  | "modelRequired"
  | "apiKeyRequired"
  | "close"
  | "languageLabel"
  | "newSessionTitle"
  | "statusSeparator"
  | "userRole"
  | "assistantRole"
  | "systemRole"
  | "statusPending"
  | "statusApproved"
  | "statusRunning"
  | "statusCompleted"
  | "statusFailed"
  | "statusRejected";

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
}

interface ToolRun {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  error: string;
}

interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  toolRuns: ToolRun[];
}

interface AppConfig {
  model: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    hasApiKey?: boolean;
  };
  security?: {
    autoRunReadTools?: boolean;
  };
}

interface AppState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  config: AppConfig | null;
  sending: boolean;
  locale: Locale;
}

interface ConfigTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  message: string;
}

/**
 * 使用方法：Web 应用初始化 state 前调用。
 * 作用：从 localStorage 恢复中文或英文界面偏好。
 * 边界：未知值统一回退到 zh-CN，不读取系统语言。
 */
function initialLocale(): Locale {
  return localStorage.getItem("dax.locale") === "en-US" ? "en-US" : "zh-CN";
}

/**
 * 使用方法：初始化 elements 映射时传入稳定 CSS selector。
 * 作用：返回带泛型类型的必需 DOM 元素。
 * 边界：元素缺失会立即抛错，避免后续静默空引用。
 */
function qs<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const state: AppState = {
  sessions: [],
  activeSessionId: null,
  config: null,
  sending: false,
  locale: initialLocale()
};

const elements = {
  brandSubtitle: qs<HTMLElement>("#brandSubtitle"),
  sessionList: qs<HTMLElement>("#sessionList"),
  newSessionButton: qs<HTMLButtonElement>("#newSessionButton"),
  sessionTitle: qs<HTMLElement>("#sessionTitle"),
  statusLine: qs<HTMLElement>("#statusLine"),
  languageInput: qs<HTMLSelectElement>("#languageInput"),
  refreshButton: qs<HTMLButtonElement>("#refreshButton"),
  settingsButton: qs<HTMLButtonElement>("#settingsButton"),
  messages: qs<HTMLElement>("#messages"),
  composer: qs<HTMLFormElement>("#composer"),
  messageInput: qs<HTMLTextAreaElement>("#messageInput"),
  sendButton: qs<HTMLButtonElement>("#sendButton"),
  toolPanelTitle: qs<HTMLElement>("#toolPanelTitle"),
  toolList: qs<HTMLElement>("#toolList"),
  pendingCount: qs<HTMLElement>("#pendingCount"),
  settingsDialog: qs<HTMLDialogElement>("#settingsDialog"),
  settingsForm: qs<HTMLFormElement>("#settingsForm"),
  closeSettingsButton: qs<HTMLButtonElement>("#closeSettingsButton"),
  cancelSettingsButton: qs<HTMLButtonElement>("#cancelSettingsButton"),
  providerInput: qs<HTMLSelectElement>("#providerInput"),
  baseUrlInput: qs<HTMLInputElement>("#baseUrlInput"),
  modelInput: qs<HTMLInputElement>("#modelInput"),
  apiKeyInput: qs<HTMLInputElement>("#apiKeyInput"),
  apiKeyStatus: qs<HTMLElement>("#apiKeyStatus"),
  providerHint: qs<HTMLElement>("#providerHint"),
  settingsFeedback: qs<HTMLElement>("#settingsFeedback"),
  providerLabel: qs<HTMLElement>("#providerLabel"),
  baseUrlLabel: qs<HTMLElement>("#baseUrlLabel"),
  modelLabel: qs<HTMLElement>("#modelLabel"),
  apiKeyLabel: qs<HTMLElement>("#apiKeyLabel"),
  autoRunReadToolsInput: qs<HTMLInputElement>("#autoRunReadToolsInput"),
  autoRunReadToolsLabel: qs<HTMLElement>("#autoRunReadToolsLabel"),
  saveSettingsButton: qs<HTMLButtonElement>("#saveSettingsButton"),
  testSettingsButton: qs<HTMLButtonElement>("#testSettingsButton"),
  settingsTitle: qs<HTMLElement>("#settingsTitle")
};

const messages: Record<Locale, Record<TranslationKey, string>> = {
  "zh-CN": {
    brandSubtitle: "本地网关",
    newSession: "新会话",
    sessionFallback: "会话",
    checkingGateway: "正在检查网关...",
    refresh: "刷新",
    settings: "设置",
    chatAria: "聊天",
    toolRunsAria: "工具运行记录",
    messagePlaceholder: "询问 DAX Agent，或试试 /help",
    send: "发送",
    toolRuns: "工具运行",
    pendingCount: "{count} 个待审批",
    noSessions: "还没有会话。",
    messageCount: "{count} 条消息",
    emptyChat: "可以先输入 /help，或者在设置中配置模型。",
    noToolRuns: "还没有工具运行记录。",
    approve: "批准",
    reject: "拒绝",
    provider: "Provider",
    baseUrl: "Base URL",
    model: "Model",
    apiKey: "API key",
    apiKeyPlaceholder: "留空则保留当前密钥",
    apiKeyStored: "已保存：{masked}。留空会继续使用该密钥。",
    apiKeyMissing: "尚未保存 API key。",
    apiKeyWillReplace: "保存后会替换当前 API key。",
    providerHintEcho: "Echo 是本地演示模式，不会调用 Base URL、模型或 API key。",
    providerHintOpenAI: "适用于 OpenAI、DeepSeek 和其他 OpenAI-compatible 接口。",
    providerHintOllama: "适用于本机 Ollama 的 OpenAI-compatible 接口，通常不需要 API key。",
    autoRunReadTools: "自动运行只读工具",
    cancel: "取消",
    testConnection: "测试连接",
    testingConnection: "正在测试...",
    saveSettings: "保存设置",
    savingSettings: "正在保存...",
    settingsSaved: "设置已保存。当前 Provider：{provider}。",
    connectionSuccess: "连接成功：{provider} · {model}（{latency} ms）。",
    echoNotExternal: "Echo 模式只会返回本地演示内容，不会测试外部模型。",
    baseUrlRequired: "请选择真实模型 Provider 并填写 Base URL。",
    baseUrlInvalid: "Base URL 必须是有效的 http:// 或 https:// 地址。",
    modelRequired: "请填写模型名称。",
    apiKeyRequired: "OpenAI-compatible Provider 需要 API key；已有密钥可以留空保留。",
    close: "关闭",
    languageLabel: "界面语言",
    newSessionTitle: "新会话",
    statusSeparator: "·",
    userRole: "用户",
    assistantRole: "助手",
    systemRole: "系统",
    statusPending: "待审批",
    statusApproved: "已批准",
    statusRunning: "运行中",
    statusCompleted: "已完成",
    statusFailed: "失败",
    statusRejected: "已拒绝"
  },
  "en-US": {
    brandSubtitle: "Local gateway",
    newSession: "New session",
    sessionFallback: "Session",
    checkingGateway: "Checking gateway...",
    refresh: "Refresh",
    settings: "Settings",
    chatAria: "Chat",
    toolRunsAria: "Tool runs",
    messagePlaceholder: "Ask DAX Agent, or try /help",
    send: "Send",
    toolRuns: "Tool Runs",
    pendingCount: "{count} pending",
    noSessions: "No sessions yet.",
    messageCount: "{count} messages",
    emptyChat: "Start with /help, or configure a model in Settings.",
    noToolRuns: "No tool runs yet.",
    approve: "Approve",
    reject: "Reject",
    provider: "Provider",
    baseUrl: "Base URL",
    model: "Model",
    apiKey: "API key",
    apiKeyPlaceholder: "Leave blank to keep current key",
    apiKeyStored: "Saved: {masked}. Leave this field blank to keep using it.",
    apiKeyMissing: "No API key is saved.",
    apiKeyWillReplace: "Saving will replace the current API key.",
    providerHintEcho: "Echo is a local demo mode and does not call the Base URL, model, or API key.",
    providerHintOpenAI: "Use for OpenAI, DeepSeek, and other OpenAI-compatible endpoints.",
    providerHintOllama: "Use for a local Ollama OpenAI-compatible endpoint; an API key is usually unnecessary.",
    autoRunReadTools: "Auto-run read-only tools",
    cancel: "Cancel",
    testConnection: "Test connection",
    testingConnection: "Testing...",
    saveSettings: "Save settings",
    savingSettings: "Saving...",
    settingsSaved: "Settings saved. Active provider: {provider}.",
    connectionSuccess: "Connection succeeded: {provider} · {model} ({latency} ms).",
    echoNotExternal: "Echo mode only returns local demo content and does not test an external model.",
    baseUrlRequired: "Select a real model provider and enter a Base URL.",
    baseUrlInvalid: "Base URL must be a valid http:// or https:// address.",
    modelRequired: "Enter a model name.",
    apiKeyRequired: "The OpenAI-compatible provider requires an API key; leave it blank to retain an existing key.",
    close: "Close",
    languageLabel: "Interface language",
    newSessionTitle: "New session",
    statusSeparator: "·",
    userRole: "User",
    assistantRole: "Assistant",
    systemRole: "System",
    statusPending: "Pending",
    statusApproved: "Approved",
    statusRunning: "Running",
    statusCompleted: "Completed",
    statusFailed: "Failed",
    statusRejected: "Rejected"
  }
};

/**
 * 使用方法：渲染界面文案时传入 TranslationKey 和可选插值参数。
 * 作用：按当前 locale 读取模板并替换 `{name}` 占位符。
 * 边界：只处理项目内静态文案，不做自动翻译或 HTML 转义。
 */
function t(key: TranslationKey, values: Record<string, string | number> = {}): string {
  const template = messages[state.locale]?.[key] || messages["zh-CN"][key] || key;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template
  );
}

/**
 * 使用方法：渲染 Session 标题时传入存储标题。
 * 作用：把默认英文或中文占位标题转换成当前语言。
 * 边界：非默认标题保持原样，不修改持久化 Session。
 */
function displayTitle(title: string): string {
  if (!title || title === "New session" || title === "新会话") return t("newSessionTitle");
  return title;
}

/**
 * 使用方法：渲染聊天消息时传入 MessageRole。
 * 作用：把 user、assistant、system 转换成当前界面语言。
 * 边界：只返回标签，不改变消息角色。
 */
function displayRole(role: MessageRole): string {
  const map: Record<MessageRole, string> = {
    user: t("userRole"),
    assistant: t("assistantRole"),
    system: t("systemRole")
  };
  return map[role] || role;
}

/**
 * 使用方法：渲染 ToolRun 状态徽标时调用。
 * 作用：把内部 ToolStatus 映射到本地化文字。
 * 边界：不推断状态，也不触发审批或轮询。
 */
function displayStatus(status: ToolStatus): string {
  const map: Record<ToolStatus, TranslationKey> = {
    pending: "statusPending",
    approved: "statusApproved",
    running: "statusRunning",
    completed: "statusCompleted",
    failed: "statusFailed",
    rejected: "statusRejected"
  };
  return t(map[status]);
}

/**
 * 使用方法：所有前端 HTTP 请求传入路径和 fetch options。
 * 作用：统一 JSON headers、响应解析和非 2xx 错误转换。
 * 边界：不自动重试或刷新身份；响应必须是 JSON。
 */
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body as T;
}

/**
 * 使用方法：渲染会话更新时间时传入 ISO 时间字符串。
 * 作用：按当前 locale 输出月、日、小时和分钟。
 * 边界：空值返回空字符串，无效日期由浏览器 Intl 行为决定。
 */
function formatDate(value: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(state.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/**
 * 使用方法：把消息、工具输出或动态字段写入 innerHTML 前调用。
 * 作用：转义 HTML 特殊字符，降低注入风险。
 * 边界：只适用于文本上下文，不是 URL、CSS 或脚本转义器。
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * 使用方法：state.sessions 或活动会话变化后调用。
 * 作用：重建侧边栏会话按钮、数量、时间和选中状态。
 * 边界：只渲染现有 state，不主动请求服务器。
 */
function renderSessions(): void {
  elements.sessionList.innerHTML = "";
  if (!state.sessions.length) {
    elements.sessionList.innerHTML = `<div class="empty-state">${escapeHtml(t("noSessions"))}</div>`;
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-button ${session.id === state.activeSessionId ? "active" : ""}`;
    button.innerHTML = `
      <div class="session-name">${escapeHtml(displayTitle(session.title))}</div>
      <div class="session-meta">${escapeHtml(t("messageCount", { count: session.messageCount }))} ${t("statusSeparator")} ${formatDate(session.updatedAt)}</div>
    `;
    button.addEventListener("click", () => openSession(session.id));
    elements.sessionList.append(button);
  }
}

/**
 * 使用方法：打开会话后传入该会话消息列表。
 * 作用：渲染角色和经过转义的消息内容，并滚动到底部。
 * 边界：当前按纯文本展示 Markdown，不执行消息中的 HTML 或脚本。
 */
function renderMessages(messages: ChatMessage[]): void {
  elements.messages.innerHTML = "";
  if (!messages.length) {
    elements.messages.innerHTML = `
      <div class="empty-state">
        ${escapeHtml(t("emptyChat"))}
      </div>
    `;
    return;
  }
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message ${message.role}`;
    item.innerHTML = `
      <div class="message-role">${escapeHtml(displayRole(message.role))}</div>
      <div class="message-content">${escapeHtml(message.content)}</div>
    `;
    elements.messages.append(item);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

/**
 * 使用方法：打开会话后传入 ToolRun 列表。
 * 作用：渲染状态、输入、输出和 pending 请求的审批按钮。
 * 边界：按钮只发起 API 请求；不会在浏览器直接执行工具。
 */
function renderTools(toolRuns: ToolRun[]): void {
  const pending = toolRuns.filter((run) => run.status === "pending").length;
  elements.pendingCount.textContent = t("pendingCount", { count: pending });
  elements.toolList.innerHTML = "";
  if (!toolRuns.length) {
    elements.toolList.innerHTML = `<div class="empty-state">${escapeHtml(t("noToolRuns"))}</div>`;
    return;
  }

  for (const run of toolRuns) {
    const item = document.createElement("article");
    item.className = `tool-run ${run.status}`;
    const output = run.output || run.error || "";
    item.innerHTML = `
      <div class="tool-title">
        <span>${escapeHtml(run.tool)}</span>
        <span class="status-pill">${escapeHtml(displayStatus(run.status))}</span>
      </div>
      <pre class="tool-json">${escapeHtml(JSON.stringify(run.input, null, 2))}</pre>
      ${output ? `<pre class="tool-output">${escapeHtml(output)}</pre>` : ""}
      ${
        run.status === "pending"
          ? `<div class="tool-actions">
              <button class="approve-button" type="button" data-action="approve" data-id="${run.id}">${escapeHtml(t("approve"))}</button>
              <button class="reject-button" type="button" data-action="reject" data-id="${run.id}">${escapeHtml(t("reject"))}</button>
            </div>`
          : ""
      }
    `;
    elements.toolList.append(item);
  }
}

/**
 * 使用方法：加载配置或打开设置对话框时调用。
 * 作用：把有效 Provider、Base URL、模型、密钥状态和安全选项同步到表单。
 * 边界：API key 明文不会回填，空密码框表示保留当前密钥。
 */
function applyConfigToForm(): void {
  if (!state.config) return;
  elements.providerInput.value = state.config.model.provider || "echo";
  elements.baseUrlInput.value = state.config.model.baseUrl || "";
  elements.modelInput.value = state.config.model.model || "";
  elements.apiKeyInput.value = "";
  elements.autoRunReadToolsInput.checked = Boolean(state.config.security?.autoRunReadTools);
  updateProviderFields();
  updateApiKeyStatus();
}

/**
 * 使用方法：应用刷新和保存设置后调用。
 * 作用：从 `/api/config` 读取脱敏配置并更新顶部状态与表单。
 * 边界：只接收脱敏密钥，不能据此恢复真实 API key。
 */
async function loadConfig(): Promise<void> {
  state.config = await api<AppConfig>("/api/config");
  elements.statusLine.textContent = `${state.config.model.provider} ${t("statusSeparator")} ${state.config.model.model}`;
  applyConfigToForm();
}

/**
 * 使用方法：保存、校验或连接测试过程中传入消息和状态类型。
 * 作用：统一更新设置面板的 aria-live 反馈区域和颜色。
 * 边界：只显示状态，不记录日志或关闭对话框。
 */
function setSettingsFeedback(message = "", kind: "neutral" | "success" | "error" = "neutral"): void {
  elements.settingsFeedback.textContent = message;
  elements.settingsFeedback.className = `settings-feedback ${kind === "neutral" ? "" : kind}`.trim();
}

/**
 * 使用方法：Provider 变化、语言变化或配置回填后调用。
 * 作用：更新提示文字，并在 Echo 模式禁用无效的外部模型字段。
 * 边界：只改变表单可用性，不自动保存 Provider。
 */
function updateProviderFields(): void {
  const provider = elements.providerInput.value;
  const isEcho = provider === "echo";
  elements.baseUrlInput.disabled = isEcho;
  elements.modelInput.disabled = isEcho;
  elements.apiKeyInput.disabled = isEcho;
  elements.testSettingsButton.disabled = isEcho;
  elements.providerHint.textContent =
    provider === "openai"
      ? t("providerHintOpenAI")
      : provider === "ollama"
        ? t("providerHintOllama")
        : t("providerHintEcho");
  if (isEcho) {
    setSettingsFeedback(t("echoNotExternal"));
  } else if (
    !elements.settingsFeedback.classList.contains("success") &&
    !elements.settingsFeedback.classList.contains("error")
  ) {
    setSettingsFeedback();
  }
  updateApiKeyStatus();
}

/**
 * 使用方法：配置回填或 API key 输入变化时调用。
 * 作用：显示尚未保存、已脱敏保存或将替换密钥的状态。
 * 边界：不会把真实密钥写入 DOM 或日志。
 */
function updateApiKeyStatus(): void {
  if (elements.apiKeyInput.value) {
    elements.apiKeyStatus.textContent = t("apiKeyWillReplace");
    return;
  }
  if (state.config?.model.hasApiKey) {
    elements.apiKeyStatus.textContent = t("apiKeyStored", {
      masked: state.config.model.apiKey || "********"
    });
    return;
  }
  elements.apiKeyStatus.textContent = t("apiKeyMissing");
}

/**
 * 使用方法：保存或测试连接前调用。
 * 作用：从设置表单收集 Provider、地址、模型、可选新密钥和安全选项。
 * 边界：返回值尚未验证，必须先经过 validateSettings()。
 */
function settingsPayload(): Record<string, unknown> {
  return {
    provider: elements.providerInput.value,
    baseUrl: elements.baseUrlInput.value.trim(),
    model: elements.modelInput.value.trim(),
    apiKey: elements.apiKeyInput.value,
    autoRunReadTools: elements.autoRunReadToolsInput.checked
  };
}

/**
 * 使用方法：persistSettings() 发出请求前调用。
 * 作用：验证真实 Provider 的 Base URL、模型名和已有或新输入的 API key。
 * 边界：Echo 不需要外部配置；最终安全校验仍由服务器重复执行。
 */
function validateSettings(): void {
  const provider = elements.providerInput.value;
  if (provider === "echo") return;
  const baseUrl = elements.baseUrlInput.value.trim();
  if (!baseUrl) throw new Error(t("baseUrlRequired"));
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(t("baseUrlInvalid"));
    }
  } catch {
    throw new Error(t("baseUrlInvalid"));
  }
  if (!elements.modelInput.value.trim()) throw new Error(t("modelRequired"));
  if (provider === "openai" && !elements.apiKeyInput.value && !state.config?.model.hasApiKey) {
    throw new Error(t("apiKeyRequired"));
  }
}

/**
 * 使用方法：保存按钮和测试连接流程共同调用。
 * 作用：验证并 PUT 配置，随后更新内存状态、顶部状态和脱敏表单。
 * 边界：只保存设置，不主动调用模型；连接测试由 testSettings() 单独发起。
 */
async function persistSettings(): Promise<AppConfig> {
  validateSettings();
  const saved = await api<AppConfig>("/api/config", {
    method: "PUT",
    body: JSON.stringify(settingsPayload())
  });
  state.config = saved;
  elements.statusLine.textContent = `${saved.model.provider} ${t("statusSeparator")} ${saved.model.model}`;
  applyConfigToForm();
  return saved;
}

/**
 * 使用方法：应用刷新、新建或发送消息后调用。
 * 作用：获取会话摘要、选择默认活动会话并刷新侧边栏。
 * 边界：不加载具体消息，详情由 openSession() 获取。
 */
async function loadSessions(): Promise<void> {
  state.sessions = await api<SessionSummary[]>("/api/sessions");
  if (!state.activeSessionId && state.sessions.length) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  renderSessions();
}

/**
 * 使用方法：点击会话或刷新活动会话时传入 sessionId。
 * 作用：加载 SessionDetail 并渲染标题、消息和工具运行。
 * 边界：不会创建会话；不存在时让 API 错误向上抛出。
 */
async function openSession(sessionId: string): Promise<void> {
  state.activeSessionId = sessionId;
  renderSessions();
  const session = await api<SessionDetail>(`/api/sessions/${sessionId}`);
  elements.sessionTitle.textContent = displayTitle(session.title);
  renderMessages(session.messages);
  renderTools(session.toolRuns.slice().reverse());
}

/**
 * 使用方法：应用首次加载或用户点击刷新时调用。
 * 作用：依次刷新配置、会话列表，并确保存在一个可打开的活动会话。
 * 边界：可能在没有会话时创建默认会话，但不会发送消息。
 */
async function refreshActive(): Promise<void> {
  await loadConfig();
  await loadSessions();
  if (!state.activeSessionId) {
    const session = await api<SessionSummary>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: t("newSessionTitle") })
    });
    state.activeSessionId = session.id;
    await loadSessions();
  }
  if (state.activeSessionId) await openSession(state.activeSessionId);
}

/**
 * 使用方法：用户点击“新会话”按钮时调用。
 * 作用：创建会话、刷新列表、打开新会话并聚焦输入框。
 * 边界：只创建空会话，不自动调用模型。
 */
async function createNewSession(): Promise<void> {
  const session = await api<SessionSummary>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: t("newSessionTitle") })
  });
  state.activeSessionId = session.id;
  await loadSessions();
  await openSession(session.id);
  elements.messageInput.focus();
}

/**
 * 使用方法：聊天 composer 提交时传入 SubmitEvent。
 * 作用：防止重复发送，调用消息 API，并在成功后刷新会话。
 * 边界：失败时恢复输入内容；不在浏览器直接运行 Agent 能力。
 */
async function sendMessage(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const content = elements.messageInput.value.trim();
  if (!content || !state.activeSessionId || state.sending) return;
  state.sending = true;
  elements.sendButton.disabled = true;
  elements.messageInput.value = "";
  try {
    await api(`/api/sessions/${state.activeSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, locale: state.locale })
    });
    await loadSessions();
    await openSession(state.activeSessionId);
  } catch (error) {
    elements.messageInput.value = content;
    alert(error instanceof Error ? error.message : String(error));
  } finally {
    state.sending = false;
    elements.sendButton.disabled = false;
    elements.messageInput.focus();
  }
}

/**
 * 使用方法：初始化或语言选择变化时调用。
 * 作用：更新所有静态文案、placeholder、aria label 和现有会话展示。
 * 边界：只改变 UI 语言并保存偏好，不翻译历史消息。
 */
function applyLocale(): void {
  document.documentElement.lang = state.locale;
  elements.brandSubtitle.textContent = t("brandSubtitle");
  elements.newSessionButton.textContent = t("newSession");
  elements.refreshButton.textContent = t("refresh");
  elements.settingsButton.textContent = t("settings");
  elements.messageInput.placeholder = t("messagePlaceholder");
  elements.sendButton.textContent = t("send");
  elements.toolPanelTitle.textContent = t("toolRuns");
  elements.providerLabel.textContent = t("provider");
  elements.baseUrlLabel.textContent = t("baseUrl");
  elements.modelLabel.textContent = t("model");
  elements.apiKeyLabel.textContent = t("apiKey");
  elements.apiKeyInput.placeholder = t("apiKeyPlaceholder");
  elements.autoRunReadToolsLabel.textContent = t("autoRunReadTools");
  elements.cancelSettingsButton.textContent = t("cancel");
  elements.testSettingsButton.textContent = t("testConnection");
  elements.saveSettingsButton.textContent = t("saveSettings");
  elements.settingsTitle.textContent = t("settings");
  elements.closeSettingsButton.setAttribute("aria-label", t("close"));
  elements.languageInput.setAttribute("aria-label", t("languageLabel"));
  elements.languageInput.value = state.locale;
  updateProviderFields();
  updateApiKeyStatus();
  if (!state.config) {
    elements.statusLine.textContent = t("checkingGateway");
  }
  renderSessions();
}

/**
 * 使用方法：工具列表 click 事件委托传入 MouseEvent。
 * 作用：识别 approve/reject 按钮、调用对应 API 并刷新活动会话。
 * 边界：只处理带 data-action 和 data-id 的按钮，不能绕过后端审批规则。
 */
async function handleToolClick(event: MouseEvent): Promise<void> {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (!action || !id) return;
  button.disabled = true;
  try {
    await api(`/api/tool-runs/${id}/${action}`, { method: "POST" });
    if (state.activeSessionId) await openSession(state.activeSessionId);
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 使用方法：设置表单 submit 时调用。
 * 作用：显示保存进度，持久化配置并在对话框内反馈成功或错误。
 * 边界：保存不等于连接成功；需要用户点击测试连接验证端点。
 */
async function saveSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  elements.saveSettingsButton.disabled = true;
  elements.testSettingsButton.disabled = true;
  elements.saveSettingsButton.textContent = t("savingSettings");
  setSettingsFeedback();
  try {
    const saved = await persistSettings();
    setSettingsFeedback(t("settingsSaved", { provider: saved.model.provider }), "success");
  } catch (error) {
    setSettingsFeedback(error instanceof Error ? error.message : String(error), "error");
  } finally {
    elements.saveSettingsButton.disabled = false;
    elements.saveSettingsButton.textContent = t("saveSettings");
    updateProviderFields();
  }
}

/**
 * 使用方法：用户点击“测试连接”时调用。
 * 作用：先保存并校验当前表单，再调用 `/api/config/test` 显示延迟和结果。
 * 边界：会发送一条最小模型请求，可能产生服务商计费；不会发送聊天历史。
 */
async function testSettings(): Promise<void> {
  elements.saveSettingsButton.disabled = true;
  elements.testSettingsButton.disabled = true;
  elements.testSettingsButton.textContent = t("testingConnection");
  setSettingsFeedback();
  try {
    await persistSettings();
    const result = await api<ConfigTestResult>("/api/config/test", {
      method: "POST",
      body: JSON.stringify({})
    });
    setSettingsFeedback(
      t("connectionSuccess", {
        provider: result.provider,
        model: result.model,
        latency: result.latencyMs
      }),
      "success"
    );
  } catch (error) {
    setSettingsFeedback(error instanceof Error ? error.message : String(error), "error");
  } finally {
    elements.saveSettingsButton.disabled = false;
    elements.testSettingsButton.textContent = t("testConnection");
    updateProviderFields();
  }
}

elements.newSessionButton.addEventListener("click", createNewSession);
elements.refreshButton.addEventListener("click", refreshActive);
elements.composer.addEventListener("submit", sendMessage);
elements.toolList.addEventListener("click", handleToolClick);
elements.settingsButton.addEventListener("click", () => {
  applyConfigToForm();
  setSettingsFeedback(elements.providerInput.value === "echo" ? t("echoNotExternal") : "");
  elements.settingsDialog.showModal();
});
elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.cancelSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsForm.addEventListener("submit", saveSettings);
elements.testSettingsButton.addEventListener("click", testSettings);
elements.providerInput.addEventListener("change", updateProviderFields);
elements.apiKeyInput.addEventListener("input", updateApiKeyStatus);
elements.languageInput.addEventListener("change", async () => {
  state.locale = elements.languageInput.value === "en-US" ? "en-US" : "zh-CN";
  localStorage.setItem("dax.locale", state.locale);
  applyLocale();
  if (state.activeSessionId) {
    await openSession(state.activeSessionId);
  }
  if (state.config) {
    elements.statusLine.textContent = `${state.config.model.provider} ${t("statusSeparator")} ${state.config.model.model}`;
  }
});
elements.messageInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    elements.composer.requestSubmit();
  }
});

applyLocale();
refreshActive().catch((error: unknown) => {
  elements.statusLine.textContent = error instanceof Error ? error.message : String(error);
});

export {};
