export type Locale = "zh-CN" | "en-US" | string;

export type MessageRole = "system" | "user" | "assistant";

export type ToolStatus =
  | "pending"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

export type ReadRiskLevel = "L0" | "L1" | "L2" | "L3";

export type ReadPermissionMode = "no_per_read_approval";

export type ReadSourceKind =
  | "local_file"
  | "document"
  | "workspace"
  | "web_page"
  | "computer_config"
  | "app_content"
  | "communication"
  | "calendar_task"
  | "memory"
  | "mcp_resource"
  | "search"
  | "runtime"
  | "app_state";

export interface ReadSource {
  kind: ReadSourceKind;
  target: string;
  purpose: string;
  required: boolean;
}

export interface ReadPlan {
  id: string;
  goal: string;
  reason: string;
  sources: ReadSource[];
  maxBytes: number;
  maxFiles: number;
  allowNetwork: boolean;
  permissionMode: ReadPermissionMode;
  expectedSignals: string[];
  riskLevel: ReadRiskLevel;
  createdAt: string;
}

export interface ReadResult {
  id: string;
  planId?: string;
  source: ReadSource;
  title?: string;
  uri?: string;
  mimeType?: string;
  content: string;
  summary?: string;
  extractedSignals: string[];
  riskLevel: ReadRiskLevel;
  riskFlags: string[];
  tokenEstimate: number;
  createdAt: string;
}

export interface ContextBlock {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  relevance: number;
  trust: "high" | "medium" | "low";
  freshness: "fresh" | "unknown" | "stale";
  riskFlags: string[];
}

export interface ReadEvent {
  id: string;
  planId?: string;
  resultId?: string;
  action: "read.planned" | "read.completed" | "read.failed";
  source: ReadSource;
  reason: string;
  riskLevel: ReadRiskLevel;
  riskFlags: string[];
  createdAt: string;
}

export interface AppConfig {
  app: {
    name: string;
    host: string;
    port: number;
    workspace: string;
  };
  model: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    hasApiKey?: boolean;
  };
  security: {
    autoRunReadTools: boolean;
    allowShell: boolean;
    commandTimeoutMs: number;
    maxReadBytes: number;
    maxSearchResults: number;
  };
}

export type JsonObject = Record<string, unknown>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary extends Session {
  messageCount: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  meta: JsonObject;
  createdAt: string;
}

export interface ToolRun {
  id: string;
  sessionId: string;
  messageId: string;
  tool: string;
  input: JsonObject;
  status: ToolStatus;
  approvalRequired: boolean;
  output: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
}

export interface AuditRecord {
  id: string;
  type: string;
  sessionId?: string;
  toolRunId?: string;
  readEventId?: string;
  readSource?: string;
  riskLevel?: ReadRiskLevel;
  riskFlags?: string[];
  tool?: string;
  status?: ToolStatus;
  approvalRequired?: boolean;
  createdAt: string;
}

export interface Store {
  version: number;
  sessions: Session[];
  messages: Message[];
  toolRuns: ToolRun[];
  readEvents: ReadEvent[];
  audit: AuditRecord[];
}

export interface SessionDetail extends Session {
  messages: Message[];
  toolRuns: ToolRun[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  approvalRequired: boolean;
  inputSchema: Record<string, string>;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ChatCompletion {
  provider: string;
  model: string;
  content: string;
}
