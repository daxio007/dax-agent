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

function initialLocale(): Locale {
  return localStorage.getItem("dax.locale") === "en-US" ? "en-US" : "zh-CN";
}

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

function t(key: TranslationKey, values: Record<string, string | number> = {}): string {
  const template = messages[state.locale]?.[key] || messages["zh-CN"][key] || key;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template
  );
}

function displayTitle(title: string): string {
  if (!title || title === "New session" || title === "新会话") return t("newSessionTitle");
  return title;
}

function displayRole(role: MessageRole): string {
  const map: Record<MessageRole, string> = {
    user: t("userRole"),
    assistant: t("assistantRole"),
    system: t("systemRole")
  };
  return map[role] || role;
}

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

function formatDate(value: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(state.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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

async function loadConfig(): Promise<void> {
  state.config = await api<AppConfig>("/api/config");
  elements.statusLine.textContent = `${state.config.model.provider} ${t("statusSeparator")} ${state.config.model.model}`;
  applyConfigToForm();
}

function setSettingsFeedback(message = "", kind: "neutral" | "success" | "error" = "neutral"): void {
  elements.settingsFeedback.textContent = message;
  elements.settingsFeedback.className = `settings-feedback ${kind === "neutral" ? "" : kind}`.trim();
}

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

function settingsPayload(): Record<string, unknown> {
  return {
    provider: elements.providerInput.value,
    baseUrl: elements.baseUrlInput.value.trim(),
    model: elements.modelInput.value.trim(),
    apiKey: elements.apiKeyInput.value,
    autoRunReadTools: elements.autoRunReadToolsInput.checked
  };
}

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

async function loadSessions(): Promise<void> {
  state.sessions = await api<SessionSummary[]>("/api/sessions");
  if (!state.activeSessionId && state.sessions.length) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  renderSessions();
}

async function openSession(sessionId: string): Promise<void> {
  state.activeSessionId = sessionId;
  renderSessions();
  const session = await api<SessionDetail>(`/api/sessions/${sessionId}`);
  elements.sessionTitle.textContent = displayTitle(session.title);
  renderMessages(session.messages);
  renderTools(session.toolRuns.slice().reverse());
}

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
