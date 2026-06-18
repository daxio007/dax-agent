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

export type SpeakAudience =
  | "user"
  | "developer"
  | "future_self"
  | "external_person"
  | "external_group"
  | "public"
  | "machine";

export type SpeakChannel =
  | "local_chat"
  | "web_ui"
  | "terminal"
  | "document_draft"
  | "email_draft"
  | "im_draft"
  | "external_channel_draft"
  | "voice_draft"
  | "machine_output";

export type SpeakMode =
  | "answer"
  | "explain"
  | "ask"
  | "status"
  | "plan"
  | "report"
  | "warn"
  | "draft"
  | "summarize"
  | "structured"
  | "acknowledge"
  | "decline";

export type SpeakContentType =
  | "plain_text"
  | "markdown"
  | "code"
  | "json"
  | "yaml"
  | "table"
  | "checklist"
  | "diff_summary"
  | "citation_summary"
  | "question"
  | "draft_message";

export type SpeakTone = "calm" | "friendly" | "direct" | "technical" | "teaching" | "formal" | "concise";

export type SpeakIdentity =
  | "assistant"
  | "user_draft"
  | "system_status"
  | "tool_report"
  | "external_message_draft";

export type SpeakSourceRefKind =
  | "context_block"
  | "read_result"
  | "tool_result"
  | "memory"
  | "user_message"
  | "listen_result"
  | "inference"
  | "system_status";

export interface SpeakSourcePolicy {
  citeLocalFiles: boolean;
  citeWebSources: boolean;
  distinguishFactsFromInferences: boolean;
  includeUnverifiedWarning: boolean;
}

export interface SpeakSafetyPolicy {
  redactSecrets: boolean;
  redactPrivateData: boolean;
  avoidExternalCommitment: boolean;
  avoidFalseExecutionClaim: boolean;
  requireDraftLabel: boolean;
}

export interface SpeakSourceRef {
  kind: SpeakSourceRefKind;
  id?: string;
  label: string;
  uri?: string;
}

export interface SpeakPlan {
  id: string;
  goal: string;
  reason: string;
  audience: SpeakAudience;
  channel: SpeakChannel;
  mode: SpeakMode;
  contentTypes: SpeakContentType[];
  tone: SpeakTone;
  detailLevel: "brief" | "normal" | "detailed";
  language: "zh-CN" | "en" | "mixed";
  identity: SpeakIdentity;
  sourcePolicy: SpeakSourcePolicy;
  safetyPolicy: SpeakSafetyPolicy;
  requiresApprovalBeforeDelivery: boolean;
  createdAt: string;
}

export interface SpeakMessage {
  id: string;
  planId: string;
  audience: SpeakAudience;
  channel: SpeakChannel;
  mode: SpeakMode;
  title?: string;
  content: string;
  format: "text" | "markdown" | "json" | "yaml";
  sourceRefs: SpeakSourceRef[];
  assumptions: string[];
  uncertaintyFlags: string[];
  riskFlags: string[];
  draft: boolean;
  createdAt: string;
}

export interface SpeakResult {
  id: string;
  planId: string;
  messageId: string;
  delivered: boolean;
  deliveryTarget: SpeakChannel;
  externalDelivery: false;
  auditId?: string;
  blockedReason?: string;
  createdAt: string;
}

export type HandRiskLevel = "H0" | "H1" | "H2" | "H3";

export type HandTargetKind =
  | "workspace_file"
  | "document"
  | "config"
  | "external_object"
  | "database_record"
  | "application_state"
  | "browser_state"
  | "clipboard"
  | "message_draft";

export type HandActionKind =
  | "create_file"
  | "update_file"
  | "delete_file"
  | "move_file"
  | "apply_patch"
  | "append"
  | "replace_range"
  | "structured_update"
  | "create_external_draft"
  | "update_external_object"
  | "update_database_record"
  | "update_application_state";

export type HandResultStatus = "applied" | "rejected" | "failed" | "skipped";

export type HandRollbackStrategy =
  | "none"
  | "snapshot"
  | "reverse_patch"
  | "external_revision"
  | "adapter_defined";

export interface HandAction {
  id: string;
  kind: HandActionKind;
  targetKind: HandTargetKind;
  target: string;
  reason: string;
  expectedChange: string;
  inputSummary: string;
  content?: string;
  expectedCurrentHash?: string;
  adapterId?: string;
  rollbackStrategy?: HandRollbackStrategy;
}

export interface HandPlan {
  id: string;
  goal: string;
  reason: string;
  targetKind: HandTargetKind;
  actions: HandAction[];
  riskLevel: HandRiskLevel;
  requiresPreview: boolean;
  requiresApproval: boolean;
  expectedOutcome: string;
  createdAt: string;
}

export interface HandActionPreview {
  actionId: string;
  target: string;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes: number;
  afterBytes: number;
  diff: string;
  riskFlags: string[];
  reversible: boolean;
  rollbackStrategy: HandRollbackStrategy;
  summary: string;
}

export interface HandPreview {
  id: string;
  planId: string;
  summary: string;
  affectedTargets: string[];
  actionPreviews: HandActionPreview[];
  diff: string;
  reversible: boolean;
  rollbackStrategy: HandRollbackStrategy;
  riskLevel: HandRiskLevel;
  riskFlags: string[];
  requiresApproval: boolean;
  createdAt: string;
}

export interface HandResult {
  id: string;
  planId: string;
  previewId?: string;
  status: HandResultStatus;
  changedTargets: string[];
  diffApplied?: string;
  error?: string;
  auditId?: string;
  rollbackAvailable: boolean;
  rollbackStrategy: HandRollbackStrategy;
  createdAt: string;
}

export type FootRiskLevel = "F0" | "F1" | "F2" | "F3";

export type FootActionKind =
  | "run_command"
  | "run_test"
  | "run_build"
  | "start_service"
  | "stop_process";

export type FootTargetKind =
  | "workspace"
  | "package_script"
  | "system_process"
  | "external_service";

export type FootResultStatus =
  | "completed"
  | "rejected"
  | "failed"
  | "skipped"
  | "timed_out";

export interface FootAction {
  id: string;
  kind: FootActionKind;
  targetKind: FootTargetKind;
  command: string;
  cwd: string;
  reason: string;
  expectedEffect: string;
  inputSummary: string;
  timeoutMs?: number;
}

export interface FootPlan {
  id: string;
  goal: string;
  reason: string;
  actions: FootAction[];
  riskLevel: FootRiskLevel;
  requiresPreview: boolean;
  requiresApproval: boolean;
  expectedOutcome: string;
  createdAt: string;
}

export interface FootActionPreview {
  actionId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  riskLevel: FootRiskLevel;
  riskFlags: string[];
  willExecute: boolean;
  summary: string;
}

export interface FootPreview {
  id: string;
  planId: string;
  summary: string;
  commands: string[];
  actionPreviews: FootActionPreview[];
  riskLevel: FootRiskLevel;
  riskFlags: string[];
  requiresApproval: boolean;
  createdAt: string;
}

export interface FootCommandResult {
  actionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface FootResult {
  id: string;
  planId: string;
  previewId?: string;
  status: FootResultStatus;
  commandResults: FootCommandResult[];
  output?: string;
  error?: string;
  auditId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  createdAt: string;
}

export type AgentDecisionType =
  | "answer_directly"
  | "ask_user"
  | "read_context"
  | "store_memory"
  | "recall_skill"
  | "propose_hand_action"
  | "propose_foot_action"
  | "wait_for_approval"
  | "pause"
  | "stop";

export type AgentDecisionSource = "rule" | "model" | "fallback";

export type AgentRiskLevel = "low" | "medium" | "high";

export interface MemoryDecision {
  id: string;
  sessionId: string;
  createdAt: string;
  kind: "raw" | "episodic" | "semantic" | "procedural";
  value: string;
  reason: string;
  shouldStore: boolean;
  sensitivity: AgentRiskLevel;
  sourceListenResultId?: string;
}

export interface SkillDecision {
  id: string;
  sessionId: string;
  createdAt: string;
  shouldRecall: boolean;
  shouldCreateCandidate: boolean;
  skillQuery?: string;
  reason: string;
}

export interface ActionProposal {
  id: string;
  sessionId: string;
  createdAt: string;
  kind: "hand" | "foot";
  title: string;
  reason: string;
  risk: AgentRiskLevel;
  requiresApproval: boolean;
  suggestedHandPlan?: Partial<HandPlan>;
  suggestedFootPlan?: Partial<FootPlan>;
}

export interface PolicyGateResult {
  id: string;
  sessionId: string;
  createdAt: string;
  allowed: boolean;
  decisionType: AgentDecisionType;
  risk: AgentRiskLevel;
  reasons: string[];
  requiredApprovals: string[];
  blockedCapabilities: string[];
}

export interface CapabilityRoute {
  id: string;
  sessionId: string;
  createdAt: string;
  decisionId: string;
  capability: "read" | "speak" | "hand" | "foot" | "memory" | "skill" | "none";
  mode: "execute" | "propose" | "record" | "skip";
  reason: string;
}

export interface AgentDecisionCandidate {
  type?: AgentDecisionType;
  reason?: string;
  confidence?: number;
  userVisibleSummary?: string;
  memoryKind?: MemoryDecision["kind"];
  memoryValue?: string;
  skillQuery?: string;
  actionTitle?: string;
  actionReason?: string;
  actionRisk?: AgentRiskLevel;
}

export interface ModelReasoningInput {
  locale: Locale;
  userText: string;
  listenSummary: string;
  workingMemorySummary: string;
  contextSummary: string;
  readFailure?: string;
  allowedDecisionTypes: AgentDecisionType[];
}

export interface ModelReasoningResult {
  id: string;
  createdAt: string;
  rawText: string;
  parsedDecision?: AgentDecisionCandidate;
  parseError?: string;
  provider: string;
  model: string;
}

export interface WorkingMemory {
  id: string;
  sessionId: string;
  createdAt: string;
  userGoal: string;
  activeConstraints: string[];
  recentIntentLabels: string[];
  contextSummary: string;
  contextBlockIds: string[];
  pendingQuestions: string[];
  pendingActionProposalIds: string[];
  memoryCandidates: MemoryDecision[];
}

export interface AgentCoreInput {
  sessionId: string;
  userMessageId: string;
  userText: string;
  locale: Locale;
  listenResult: ListenResult;
  recentMessages: Message[];
  contextBlocks: ContextBlock[];
  pendingToolRuns: ToolRun[];
  config: AppConfig;
  readAttempted: boolean;
  readFailure?: string;
}

export interface AgentDecision {
  id: string;
  sessionId: string;
  createdAt: string;
  type: AgentDecisionType;
  reason: string;
  confidence: number;
  userVisibleSummary: string;
  readPlan?: ReadPlan;
  speakPlan?: SpeakPlan;
  actionProposal?: ActionProposal;
  memoryDecision?: MemoryDecision;
  skillDecision?: SkillDecision;
  policyGate?: PolicyGateResult;
  source: AgentDecisionSource;
}

export interface AgentCoreResult {
  id: string;
  sessionId: string;
  createdAt: string;
  inputSummary: string;
  workingMemory: WorkingMemory;
  decision: AgentDecision;
  route: CapabilityRoute;
  policyGate: PolicyGateResult;
  modelReasoning?: ModelReasoningResult;
  warnings: string[];
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
  speakPlanId?: string;
  speakMessageId?: string;
  speakResultId?: string;
  handPlanId?: string;
  handPreviewId?: string;
  handResultId?: string;
  handRiskLevel?: HandRiskLevel;
  footPlanId?: string;
  footPreviewId?: string;
  footResultId?: string;
  footRiskLevel?: FootRiskLevel;
  agentCoreResultId?: string;
  agentDecisionId?: string;
  policyGateResultId?: string;
  capabilityRouteId?: string;
  agentDecisionType?: AgentDecisionType;
  agentDecisionSource?: AgentDecisionSource;
  agentRiskLevel?: AgentRiskLevel;
  speakMode?: SpeakMode;
  speakAudience?: SpeakAudience;
  speakChannel?: SpeakChannel;
  speakDraft?: boolean;
  listenIntent?: ListenIntent;
  readSource?: string;
  riskLevel?: ReadRiskLevel;
  riskFlags?: string[];
  tool?: string;
  status?: ToolStatus;
  approvalRequired?: boolean;
  detail?: string;
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
  speakPlans: SpeakPlan[];
  speakMessages: SpeakMessage[];
  speakResults: SpeakResult[];
  handPlans: HandPlan[];
  handPreviews: HandPreview[];
  handResults: HandResult[];
  footPlans: FootPlan[];
  footPreviews: FootPreview[];
  footResults: FootResult[];
  agentDecisions: AgentDecision[];
  policyGateResults: PolicyGateResult[];
  capabilityRoutes: CapabilityRoute[];
  agentCoreResults: AgentCoreResult[];
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
