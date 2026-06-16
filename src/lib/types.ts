export type Locale = "zh-CN" | "en-US" | string;

export type MessageRole = "system" | "user" | "assistant";

export type ToolStatus =
  | "pending"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

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
