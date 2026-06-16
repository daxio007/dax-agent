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
  | "autoRunReadTools"
  | "cancel"
  | "saveSettings"
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
  providerLabel: qs<HTMLElement>("#providerLabel"),
  baseUrlLabel: qs<HTMLElement>("#baseUrlLabel"),
  modelLabel: qs<HTMLElement>("#modelLabel"),
  apiKeyLabel: qs<HTMLElement>("#apiKeyLabel"),
  autoRunReadToolsInput: qs<HTMLInputElement>("#autoRunReadToolsInput"),
  autoRunReadToolsLabel: qs<HTMLElement>("#autoRunReadToolsLabel"),
  saveSettingsButton: qs<HTMLButtonElement>("#saveSettingsButton"),
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
    autoRunReadTools: "自动运行只读工具",
    cancel: "取消",
    saveSettings: "保存设置",
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
    autoRunReadTools: "Auto-run read-only tools",
    cancel: "Cancel",
    saveSettings: "Save settings",
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
}

async function loadConfig(): Promise<void> {
  state.config = await api<AppConfig>("/api/config");
  elements.statusLine.textContent = `${state.config.model.provider} ${t("statusSeparator")} ${state.config.model.model}`;
  applyConfigToForm();
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
  elements.saveSettingsButton.textContent = t("saveSettings");
  elements.settingsTitle.textContent = t("settings");
  elements.closeSettingsButton.setAttribute("aria-label", t("close"));
  elements.languageInput.setAttribute("aria-label", t("languageLabel"));
  elements.languageInput.value = state.locale;
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
  await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      provider: elements.providerInput.value,
      baseUrl: elements.baseUrlInput.value,
      model: elements.modelInput.value,
      apiKey: elements.apiKeyInput.value,
      autoRunReadTools: elements.autoRunReadToolsInput.checked
    })
  });
  elements.settingsDialog.close();
  await loadConfig();
}

elements.newSessionButton.addEventListener("click", createNewSession);
elements.refreshButton.addEventListener("click", refreshActive);
elements.composer.addEventListener("submit", sendMessage);
elements.toolList.addEventListener("click", handleToolClick);
elements.settingsButton.addEventListener("click", () => {
  applyConfigToForm();
  elements.settingsDialog.showModal();
});
elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.cancelSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsForm.addEventListener("submit", saveSettings);
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
