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

export type ListenEventKind =
  | "user_text"
  | "user_voice_transcript"
  | "ui_control"
  | "channel_message"
  | "mcp_notification"
  | "tool_result"
  | "app_state"
  | "timer"
  | "system_event";

export type ListenPrivacyLevel = "public" | "personal" | "sensitive";

export type ListenTrust = "high" | "medium" | "low";

export type ListenIntent =
  | "chat"
  | "ask"
  | "explain"
  | "design"
  | "implement"
  | "review"
  | "inspect"
  | "read"
  | "commit"
  | "push"
  | "configure"
  | "pause"
  | "continue"
  | "stop"
  | "correct"
  | "approve"
  | "reject"
  | "remember"
  | "forget"
  | "status"
  | "unknown";

export type SpeechAct =
  | "request"
  | "question"
  | "instruction"
  | "constraint"
  | "correction"
  | "confirmation"
  | "rejection"
  | "preference"
  | "status_request"
  | "brainstorm"
  | "casual";

export type ListenNextStep =
  | "answer_directly"
  | "read_then_answer"
  | "plan"
  | "implement"
  | "ask_clarifying_question"
  | "pause"
  | "resume"
  | "record_memory"
  | "ignore_noise"
  | "agent_core";

export interface ListenEvent {
  id: string;
  kind: ListenEventKind;
  channelId: string;
  sessionId?: string;
  userId?: string;
  locale?: string;
  rawText?: string;
  payload?: JsonObject;
  sourceLabel: string;
  privacyLevel: ListenPrivacyLevel;
  trust: ListenTrust;
  capturedAt: string;
}

export interface ListenReference {
  text: string;
  resolvedTo?: string;
  confidence: number;
  needsRead: boolean;
}

export interface ListenConstraint {
  kind: "scope" | "permission" | "technology" | "style" | "language" | "pace" | "privacy" | "process";
  content: string;
  duration: "turn" | "session" | "project" | "permanent";
  strength: "soft" | "hard";
  sourceText?: string;
}

export interface ListenCorrection {
  wrong?: string;
  correct?: string;
  target: "terminology" | "scope" | "assumption" | "implementation" | "memory" | "behavior";
  shouldUpdateMemory: boolean;
  sourceText: string;
}

export interface ListenStateChange {
  kind: "pause" | "resume" | "stop" | "scope_change" | "mode_change" | "priority_change";
  value: string;
  appliesTo: "current_turn" | "current_task" | "session" | "project";
}

export interface ListenContextNeed {
  kind:
    | "workspace"
    | "memory"
    | "document"
    | "web_page"
    | "computer_config"
    | "app_content"
    | "mcp_resource"
    | "none";
  reason: string;
  suggestedTarget?: string;
  required: boolean;
}

export interface ListenMemoryCandidate {
  kind: "user_preference" | "project_constraint" | "decision" | "terminology" | "correction" | "workflow";
  content: string;
  importance: "low" | "medium" | "high";
  suggestedStore: "none" | "conversation_log" | "project_memory" | "decision_log";
}

export interface ListenResult {
  id: string;
  eventId: string;
  primaryIntent: ListenIntent;
  intents: ListenIntent[];
  speechActs: SpeechAct[];
  target?: string;
  references: ListenReference[];
  constraints: ListenConstraint[];
  corrections: ListenCorrection[];
  stateChanges: ListenStateChange[];
  contextNeeds: ListenContextNeed[];
  memoryCandidates: ListenMemoryCandidate[];
  riskFlags: string[];
  confidence: number;
  nextStep: ListenNextStep;
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
  listenEventId?: string;
  listenResultId?: string;
  listenIntent?: ListenIntent;
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
  listenEvents: ListenEvent[];
  listenResults: ListenResult[];
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
