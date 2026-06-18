# Agent Core 第一阶段实现设计

最后更新：2026-06-17

状态：设计完成，第一阶段运行时已于 2026-06-18 按本文实现。实现记录见 `docs/agent-core-implementation.md`。

相关文档：

- `docs/agent-core-design.md`
- `docs/agent-learning-model.md`
- `docs/read-capability-design.md`
- `docs/listen-capability-design.md`
- `docs/speak-capability-design.md`
- `docs/hand-capability-design.md`
- `docs/foot-capability-design.md`

## 1. 为什么需要这份文档

`docs/agent-core-design.md` 已经确定了“大脑”的总体理念：Agent Core 不是一个单独的模型调用，也不是纯规则系统，而是代码控制骨架加模型思考器的混合系统。

这份文档继续往下推进一步，专门回答第一阶段如何把 Agent Core 落到代码里。

它的目标不是把最终大脑一次性做完，而是先实现一个可以接入现有能力、可以被审计、可以继续扩展的最小控制层。这个控制层以后要统领眼睛、耳朵、嘴巴、手、脚、记忆、Skill 和 MCP，所以第一阶段最重要的是边界清晰，而不是功能贪多。

## 2. 当前基线

截至 2026-06-17，项目已经具备这些第一阶段能力：

- 读/眼睛：`src/lib/read.ts`，支持 `ReadPlan -> ReadResult -> ContextBlock`。
- 听/耳朵：`src/lib/listen.ts`，支持 `ListenEvent -> ListenResult`，可以识别 intent、constraint、correction、state change、context need 和 memory candidate。
- 嘴巴/表达：`src/lib/speak.ts`，支持 `SpeakPlan -> SpeakMessage -> SpeakResult`，并已接入 assistant 可见输出。
- 手/修改：`src/lib/hand.ts`，支持 workspace 内文本创建、更新和结构化 `apply_patch`，采用 `HandPlan -> HandPreview -> HandResult`。
- 脚/执行：`src/lib/foot.ts`，支持 workspace 内前台命令执行，采用 `FootPlan -> FootPreview -> FootResult`，并已让 `shell.run` 复用脚能力。
- 消息主流程：`src/lib/agent.ts` 当前已经先调用听能力，再进入 slash command、模型回复、工具请求解析和嘴巴表达。

因此 Agent Core 第一阶段不需要重新设计这些能力，而是要把它们放到一个统一的判断和调度结构里。

## 3. 第一阶段目标

Agent Core 第一阶段的目标是：

```text
ListenResult + session context + optional ContextBlock
  -> Agent Core
  -> AgentDecision
  -> CapabilityRoute
  -> SpeakPlan 或 ActionProposal
```

第一阶段必须实现：

- 定义 Agent Core 相关共享类型。
- 新增 `src/lib/core.ts`，作为大脑控制层入口。
- 在 `processUserMessage()` 中为自然语言主流程接入 Agent Core。
- 让 Agent Core 能处理硬控制信号，例如 pause、stop、continue、status。
- 让 Agent Core 能根据 `ListenResult.contextNeeds` 判断是否需要读上下文。
- 让 Agent Core 能把读取结果纳入 `WorkingMemory`。
- 让 Agent Core 能输出 `AgentDecision`。
- 让 `AgentDecision` 转成 `SpeakPlan`。
- 让手和脚先以 `ActionProposal` 的形式进入大脑输出，不直接执行。
- 所有 Agent Core 决策、策略检查和失败都写入 audit。
- 每个 exported 方法和关键 helper 都写详细 JSDoc，解释使用方法、作用和边界。

第一阶段不做：

- 不实现完整长期记忆库或向量检索。
- 不实现 Skill Runtime。
- 不实现 Multi-Agent Routing。
- 不让模型直接调用手或脚。
- 不让 Agent Core 自动写文件、执行命令或对外发送消息。
- 不绕过现有 hand/foot 的 preview、approval、audit 机制。
- 不声称已经修改或执行，除非存在真实 `HandResult` 或 `FootResult`。

## 4. 设计原则

### 4.1 大脑是控制平面

Agent Core 是控制平面，负责判断下一步应该做什么。它不应该把读、写、执行、表达的细节都吞进去。

能力模块仍然各自负责自己的事情：

- 读负责安全获取上下文。
- 听负责理解输入信号。
- 嘴巴负责表达。
- 手负责修改。
- 脚负责执行。

Agent Core 负责把这些能力串起来，并决定什么时候该用、用到哪里、是否需要等待用户确认。

### 4.2 模型只给候选决策

低等级模型可以承担第一阶段的日常思考，但模型输出只能是候选结果。代码必须继续负责：

- prompt 边界。
- JSON schema 校验。
- fallback。
- Policy Gate。
- 能力路由。
- 审计记录。
- 对用户可见内容的真实性边界。

换句话说，模型可以说“我建议这么做”，但代码决定“这个建议是不是合法、是不是安全、是不是要先问用户”。

### 4.3 硬控制信号优先

这些信号不应该交给模型自由解释：

- 暂停。
- 停止。
- 继续。
- 不要写代码。
- 不要执行命令。
- 不要提交。
- 只讨论。
- 只写文档。
- 先写设计文档再写代码。

Agent Core 应该先用 deterministic controller 处理这类信号，再决定是否需要模型参与。

### 4.4 行动必须比表达更严格

嘴巴可以提出计划、解释风险、生成草稿和汇报结果，但不能把尚未发生的行动说成已经完成。

手和脚会产生真实副作用，所以在 Agent Core 第一阶段只能由大脑生成 `ActionProposal`。后续是否转成 `HandPlan` 或 `FootPlan`，必须继续经过能力自身的 preview、policy 和 approval。

### 4.5 保持 echo 和本地 fallback 可用

当前项目支持 `echo` provider。Agent Core 第一阶段不能假设一定存在可用模型。

当 provider 是 echo、模型失败、模型返回非法 JSON、或配置不可用时，Agent Core 必须能用规则 fallback 输出保守决策。

## 5. 第一阶段主流程

第一阶段自然语言主流程应演进为：

```text
用户输入
  -> ListenEvent
  -> ListenResult
  -> createAgentCoreInput()
  -> decideNextStep()
  -> AgentCoreResult
  -> CapabilityRoute
  -> SpeakPlan / ActionProposal
  -> SpeakMessage
```

当需要读取上下文时，流程变为：

```text
用户输入
  -> ListenResult
  -> Agent Core 判断需要读
  -> ReadPlan
  -> ReadResult
  -> ContextBlock
  -> WorkingMemory
  -> Agent Core 二次决策
  -> SpeakPlan / ActionProposal
```

这里的“二次决策”必须有上限。第一阶段只允许一次自动读上下文，避免 Agent 在没有清晰停止条件的情况下循环读取。

## 6. 类型设计

第一阶段需要在 `src/lib/types.ts` 中新增 Agent Core 类型。下面是建议结构，最终代码可以根据现有类型风格微调命名，但语义不要偏离。

### 6.1 AgentDecisionType

```ts
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
```

含义：

- `answer_directly`：当前信息足够，可以直接回答或说明。
- `ask_user`：信息不足，应该追问。
- `read_context`：需要触发读能力补充上下文。
- `store_memory`：存在值得保存的记忆候选。
- `recall_skill`：未来用于尝试匹配已有 Skill。
- `propose_hand_action`：建议动手修改，但第一阶段不直接执行。
- `propose_foot_action`：建议执行命令，但第一阶段不直接执行。
- `wait_for_approval`：已经形成下一步候选，但必须等待用户确认。
- `pause`：暂停当前任务或进入等待状态。
- `stop`：停止当前任务或放弃后续行动。

### 6.2 AgentCoreInput

```ts
export interface AgentCoreInput {
  sessionId: string;
  userMessageId: string;
  userText: string;
  locale: "zh-CN" | "en";
  listenResult: ListenResult;
  recentMessages: ChatMessage[];
  contextBlocks: ContextBlock[];
  pendingToolRuns: ToolRun[];
  config: AppConfig;
}
```

作用：

- 给 Agent Core 提供一次决策所需的最小输入。
- 保持输入结构化，避免 `core.ts` 直接散读 store。
- 让后续 API、测试和调试可以复用同一个入口。

### 6.3 WorkingMemory

```ts
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
```

第一阶段的 `WorkingMemory` 是短期工作记忆，不是长期记忆库。

它主要保存：

- 用户当前目标。
- 当前约束。
- 已读上下文摘要。
- 待追问问题。
- 待执行动作候选。
- 记忆候选。

### 6.4 AgentDecision

```ts
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
  policyGate?: PolicyGateResult;
  source: "rule" | "model" | "fallback";
}
```

设计重点：

- `reason` 是内部解释，用于 audit 和调试。
- `userVisibleSummary` 可以进入嘴巴表达，但必须避免泄露内部 prompt 或敏感上下文。
- `source` 用于区分规则、模型和 fallback。
- `policyGate` 必须记录策略检查结果。

### 6.5 MemoryDecision

```ts
export interface MemoryDecision {
  id: string;
  createdAt: string;
  kind: "raw" | "episodic" | "semantic" | "procedural";
  value: string;
  reason: string;
  shouldStore: boolean;
  sensitivity: "low" | "medium" | "high";
  sourceListenResultId?: string;
}
```

第一阶段只生成记忆决策，不一定立即写入长期记忆。这样可以先把“值得记住什么”做成可审计对象。

### 6.6 SkillDecision

```ts
export interface SkillDecision {
  id: string;
  createdAt: string;
  shouldRecall: boolean;
  shouldCreateCandidate: boolean;
  skillQuery?: string;
  reason: string;
}
```

第一阶段只保留结构，不实现 Skill Index。

### 6.7 ActionProposal

```ts
export interface ActionProposal {
  id: string;
  createdAt: string;
  kind: "hand" | "foot";
  title: string;
  reason: string;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  suggestedHandPlan?: Partial<HandPlan>;
  suggestedFootPlan?: Partial<FootPlan>;
}
```

第一阶段的重要边界：

- `ActionProposal` 不是执行结果。
- `ActionProposal` 不是 `HandPlan` 或 `FootPlan` 的完全可信替代。
- `ActionProposal` 只能作为后续能力规划的输入。
- 嘴巴汇报时只能说“建议执行”或“需要确认”，不能说“已经执行”。

### 6.8 PolicyGateResult

```ts
export interface PolicyGateResult {
  id: string;
  createdAt: string;
  allowed: boolean;
  decisionType: AgentDecisionType;
  risk: "low" | "medium" | "high";
  reasons: string[];
  requiredApprovals: string[];
  blockedCapabilities: string[];
}
```

第一阶段 policy 的重点不是做完整安全沙箱，而是明确每个决策为什么允许、为什么阻止、需要谁确认。

### 6.9 CapabilityRoute

```ts
export interface CapabilityRoute {
  id: string;
  createdAt: string;
  decisionId: string;
  capability: "read" | "speak" | "hand" | "foot" | "memory" | "none";
  mode: "execute" | "propose" | "record" | "skip";
  reason: string;
}
```

第一阶段允许自动执行的 route：

- `read` with `execute`，但只允许一次自动读，并遵循读能力边界。
- `speak` with `execute`，因为表达已经是本地可见消息，不对外发送。
- `memory` with `record`，仅记录候选或轻量记忆事件。

第一阶段只能 propose 的 route：

- `hand`。
- `foot`。

### 6.10 AgentCoreResult

```ts
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
```

这个结果应成为后续调试、API 返回和审计的主对象。

### 6.11 ModelReasoningInput 和 ModelReasoningResult

```ts
export interface ModelReasoningInput {
  locale: "zh-CN" | "en";
  userText: string;
  listenSummary: string;
  workingMemorySummary: string;
  contextSummary: string;
  allowedDecisionTypes: AgentDecisionType[];
}

export interface ModelReasoningResult {
  id: string;
  createdAt: string;
  rawText: string;
  parsedDecision?: Partial<AgentDecision>;
  parseError?: string;
  provider: string;
}
```

模型思考器只接收摘要和必要结构，不直接接收无限制上下文。

## 7. `src/lib/core.ts` 方法设计

所有 exported 方法和关键 helper 都必须写 JSDoc。JSDoc 必须至少包含：

- 使用方法：谁会调用、传入什么、返回什么。
- 作用：它在 Agent Core 流程中负责哪一步。
- 边界：它不会做什么，哪些副作用不会发生。

建议 JSDoc 模板：

```ts
/**
 * 使用方法：由 processUserMessage() 或调试 API 在完成 listen 分析后调用。
 * 作用：把一次用户输入、听能力结果和已知上下文整理成 Agent Core 决策输入。
 * 边界：该方法只组装结构化输入，不调用模型、不读取文件、不写入 audit，也不执行任何行动。
 */
export function createAgentCoreInput(...): AgentCoreInput
```

### 7.1 createAgentCoreInput()

用途：

- 把 session、message、listen result、recent messages、context blocks、pending tool runs 和 config 合成 `AgentCoreInput`。
- 隔离 `agent.ts` 和 `core.ts` 之间的数据边界。

边界：

- 不调用模型。
- 不执行读写。
- 不改变 store。

### 7.2 createWorkingMemory()

用途：

- 从 `AgentCoreInput` 创建第一版 `WorkingMemory`。
- 抽取用户目标、显式约束、最近 intent 和上下文摘要。

边界：

- 只构建短期工作记忆。
- 不写入长期记忆。
- 不触发 Skill。

### 7.3 updateWorkingMemoryWithContext()

用途：

- 当 Agent Core 已经触发一次读能力后，把 `ContextBlock[]` 合并进工作记忆。
- 生成适合模型和嘴巴使用的短摘要。

边界：

- 不保留完整大段上下文给模型。
- 不把敏感块无过滤地加入 prompt。

### 7.4 applyHardControl()

用途：

- 根据 `ListenResult.stateChanges`、用户约束和原始文本识别暂停、停止、继续、只讨论、只写文档、不要执行、不要提交等硬控制信号。
- 直接返回规则型 `AgentDecision`。

边界：

- 不调用模型。
- 不让模型覆盖用户的明确控制。

### 7.5 shouldReadContext()

用途：

- 根据 `ListenResult.contextNeeds`、用户请求和现有上下文判断是否需要读。
- 第一阶段只允许生成一个 `ReadPlan`。

边界：

- 不直接执行读取。
- 不做网络搜索决策扩张。
- 不连续循环读取。

### 7.6 createReadPlanFromDecision()

用途：

- 将 `read_context` 类型的 `AgentDecision` 转成 `ReadPlan`。
- 尽量复用听能力给出的建议 source。

边界：

- 只创建计划，不读取。
- 不绕过读能力已有的 source、risk 和 filter 逻辑。

### 7.7 buildModelReasoningInput()

用途：

- 把 `AgentCoreInput` 和 `WorkingMemory` 压缩成模型可消费的 `ModelReasoningInput`。
- 控制模型看到的字段，减少泄露和噪音。

边界：

- 不传入完整 store。
- 不传入 API key、环境变量原文或大段未过滤上下文。

### 7.8 reasonWithModel()

用途：

- 调用现有 provider，要求模型输出严格 JSON 候选决策。
- 适配 echo、OpenAI-compatible 和 Ollama-compatible provider。

边界：

- 模型输出不能直接执行。
- 模型失败时必须返回带错误的 `ModelReasoningResult`，由 fallback 接手。

### 7.9 parseModelDecision()

用途：

- 从模型 raw text 中提取 JSON。
- 把 JSON 转成 `Partial<AgentDecision>` 候选。

边界：

- 不信任模型字段。
- 不接受超出白名单的 decision type。

### 7.10 validateAgentDecision()

用途：

- 校验候选 `AgentDecision` 是否符合第一阶段 schema。
- 补全 id、createdAt、confidence、source 等字段。

边界：

- 不执行 route。
- 不写入 store。

### 7.11 createFallbackDecision()

用途：

- 在模型不可用、模型输出非法、上下文不足或策略不允许时生成保守决策。
- 默认倾向于追问、解释边界、或直接回答低风险问题。

边界：

- 不生成会导致真实副作用的执行。
- 不声称完成未发生的动作。

### 7.12 applyPolicyGate()

用途：

- 对 `AgentDecision` 做第一阶段策略检查。
- 明确 allowed、risk、reasons、requiredApprovals 和 blockedCapabilities。

边界：

- 不替代 hand/foot 自己的风险识别。
- 不绕过现有 approval。

### 7.13 routeAgentDecision()

用途：

- 把 `AgentDecision` 映射为 `CapabilityRoute`。
- 决定下一步是 speak、read、memory record、hand proposal、foot proposal 还是 none。

边界：

- 不执行 hand 或 foot。
- 不把 proposal 当 result。

### 7.14 createSpeakPlanFromDecision()

用途：

- 把 `AgentDecision` 转成 `SpeakPlan`。
- 根据 decision type 选择回答、追问、警告、计划、确认或状态汇报表达模式。

边界：

- 不对外发送。
- 不把内部 reasoning 全量暴露给用户。
- 不声称没有结果的行动已经完成。

### 7.15 createActionProposalFromDecision()

用途：

- 将模型或规则产生的行动意图收敛成 `ActionProposal`。
- 第一阶段只输出 proposal，供后续 hand/foot 集成使用。

边界：

- 不生成最终 `HandPlan` 或 `FootPlan` 的所有字段。
- 不应用 patch。
- 不执行命令。

### 7.16 decideNextStep()

用途：

- Agent Core 第一阶段的主入口。
- 组合 hard control、working memory、read 判断、model reasoning、fallback、policy gate 和 route。

边界：

- 默认不执行真实世界副作用。
- 允许返回需要读的决策，但是否执行读由上层流程控制。
- 只允许一次自动 read round。

### 7.17 recordAgentCoreResult()

用途：

- 将 `AgentCoreResult`、`AgentDecision`、`PolicyGateResult` 和 route 写入 store/audit。

边界：

- 不重复记录 hand/foot/read/speak 自己的能力结果。
- 不保存敏感原文，除非字段已经脱敏或只保存摘要。

## 8. Store 和 Audit 设计

需要在 `src/lib/store.ts` 中新增持久化能力：

- `recordAgentDecision(decision: AgentDecision): Promise<AgentDecision>`
- `listAgentDecisions(limit?: number): Promise<AgentDecision[]>`
- `recordPolicyGateResult(result: PolicyGateResult): Promise<PolicyGateResult>`
- `listPolicyGateResults(limit?: number): Promise<PolicyGateResult[]>`
- `recordAgentCoreResult(result: AgentCoreResult): Promise<AgentCoreResult>`
- `listAgentCoreResults(limit?: number): Promise<AgentCoreResult[]>`

建议 audit event：

- `agent.core.input.created`
- `agent.core.hard_control.detected`
- `agent.core.model_reasoning.completed`
- `agent.core.model_reasoning.failed`
- `agent.decision.created`
- `agent.policy.checked`
- `agent.route.created`
- `agent.core.completed`
- `agent.core.failed`

审计记录要回答三件事：

- Agent 为什么选择这一步。
- 这一步有没有被策略允许。
- 这一步有没有产生真实副作用。

## 9. HTTP API 设计

第一阶段可以新增调试 API，便于手工验证和前端未来展示：

### 9.1 POST /api/core/decide

用途：

- 输入一个 session/message/listen result 的组合，返回 `AgentCoreResult`。
- 用于开发期调试 Agent Core，不作为最终用户主要入口。

边界：

- 不自动执行 hand/foot。
- 如果需要 read，可以返回 read decision，也可以在显式参数允许下执行一次 read round。

### 9.2 GET /api/agent-core-results

用途：

- 查看最近 Agent Core 决策结果。

### 9.3 GET /api/agent-decisions

用途：

- 查看最近 `AgentDecision`。

### 9.4 GET /api/policy-gate-results

用途：

- 查看最近 policy gate 检查结果。

## 10. `processUserMessage()` 接入设计

当前 `processUserMessage()` 已经做了：

```text
userText
  -> analyzeAndRecordUserText()
  -> add user message
  -> slash command 或 model reply
  -> addSpokenAssistantMessage()
```

第一阶段建议改成：

```text
userText
  -> analyzeAndRecordUserText()
  -> add user message
  -> if slash command: keep existing direct command path
  -> createAgentCoreInput()
  -> decideNextStep()
  -> if read_context: execute one ReadPlan, update WorkingMemory, decide again
  -> route decision
  -> create SpeakPlan
  -> addSpokenAssistantMessage()
```

为什么 slash command 暂时保持原路径：

- slash command 是用户显式命令，当前已有可运行语义。
- 第一阶段先让自然语言主流程经过 Agent Core，避免一次性改动过大。
- 后续可以让 slash command 也生成 `AgentDecision`，但不是第一阶段必须项。

## 11. 模型思考器设计

模型 prompt 第一阶段应该非常收敛，只要求输出 JSON。

建议输出格式：

```json
{
  "type": "answer_directly",
  "reason": "用户在询问设计建议，当前上下文足够。",
  "confidence": 0.72,
  "userVisibleSummary": "可以先给出设计建议，并说明后续实现边界。",
  "needsRead": false,
  "memoryCandidate": null,
  "actionProposal": null
}
```

模型允许做：

- 判断用户语义。
- 生成回答思路。
- 建议是否需要读上下文。
- 建议是否有记忆候选。
- 建议是否形成手/脚行动候选。

模型不允许做：

- 输出最终执行命令并要求直接执行。
- 输出任意文件写入并要求直接应用。
- 跳过 approval。
- 声称已完成真实动作。
- 写入长期记忆。

当模型输出非法 JSON：

- 记录 `agent.core.model_reasoning.failed`。
- 使用 `createFallbackDecision()`。
- 嘴巴可以提示“我先按保守方式处理”。

## 12. 记忆第一阶段设计

第一阶段的记忆重点是“形成可审计记忆候选”，不是马上做长期记忆系统。

可记录的候选：

- 用户稳定偏好，例如语言、实现方式、流程习惯。
- 项目稳定事实，例如某能力已经完成。
- 成功任务经验，例如某类实现必须先写设计文档。

不应该自动记忆：

- 密钥、token、cookie、凭据。
- 临时情绪化表达。
- 未确认的推测。
- 大段原文聊天。

第一阶段可以把记忆候选放入 `AgentDecision.memoryDecision`，并由 audit 记录。真正写入 `docs/project-memory.md` 仍然由 Codex 在开发协作中显式编辑，暂不做自动文档写入。

## 13. 手和脚接入边界

Agent Core 第一阶段可以识别“这件事可能需要动手或执行”，但只生成：

- `ActionProposal(kind: "hand")`
- `ActionProposal(kind: "foot")`

不能直接生成并执行：

- `HandResult`
- `FootResult`

后续完整接入时应走：

```text
AgentDecision
  -> ActionProposal
  -> HandPlan / FootPlan
  -> Preview
  -> Policy Gate
  -> Approval
  -> Result
  -> SpeakPlan
```

嘴巴表达必须遵守：

- 有 `ActionProposal` 只能说“建议修改”或“需要确认”。
- 有 `HandPreview` 只能说“已生成预览”。
- 有 `HandResult` 才能说“已修改”。
- 有 `FootPreview` 只能说“已生成执行预览”。
- 有 `FootResult` 才能说“已执行”。

## 14. Policy Gate 第一阶段规则

第一阶段 policy 可以先做保守规则：

- `answer_directly`：默认允许。
- `ask_user`：默认允许。
- `read_context`：默认允许一次，但必须遵守读能力 source 边界。
- `store_memory`：只允许记录候选，不自动长期保存敏感信息。
- `recall_skill`：暂时降级为 no-op 或说明尚未实现。
- `propose_hand_action`：允许 proposal，不允许 apply。
- `propose_foot_action`：允许 proposal，不允许 execute。
- `wait_for_approval`：允许。
- `pause`：允许。
- `stop`：允许。

高风险条件：

- 用户要求修改文件。
- 用户要求执行命令。
- 用户要求提交、推送或发布。
- 用户要求访问外部服务。
- 用户要求处理密钥或凭据。
- 用户要求删除、覆盖、迁移或批量变更。

这些条件第一阶段都应让 policy 记录 required approval 或 blocked capabilities。

## 15. 验证计划

实现 Agent Core 第一阶段时至少要验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `applyHardControl()` 能识别暂停、停止、只讨论、不执行。
- `shouldReadContext()` 能从 `ListenResult.contextNeeds` 生成读决策。
- 模型返回非法 JSON 时会 fallback。
- echo provider 下主流程仍然可用。
- `answer_directly` 会生成 `SpeakPlan`。
- `ask_user` 会生成追问型 `SpeakPlan`。
- `propose_hand_action` 不会调用 `applyHandPlan()`。
- `propose_foot_action` 不会调用 `executeFootPlan()`。
- 没有 `HandResult` 时不会说“已修改”。
- 没有 `FootResult` 时不会说“已执行”。
- Agent Core 决策、policy gate 和 route 会进入 store/audit。
- 现有 `/help`、`/read`、`/search`、`/run` slash command 仍保持现有行为。

## 16. 实现顺序

建议下一步按这个顺序写代码：

1. 在 `src/lib/types.ts` 增加 Agent Core 类型。
2. 在 `src/lib/store.ts` 增加 Agent Core 结果、决策和 policy gate 持久化。
3. 新增 `src/lib/core.ts`，先实现 deterministic controller、working memory、fallback 和 policy gate。
4. 接入 `reasonWithModel()`，但保留 echo/fallback 可用。
5. 在 `src/server.ts` 增加 Agent Core 调试 API。
6. 在 `src/lib/agent.ts` 中让自然语言主流程经过 Agent Core。
7. 验证一次 read round、speak route 和 hand/foot proposal 边界。
8. 新增 `docs/agent-core-implementation.md` 记录代码入口、API、验证结果和当前边界。
9. 更新 `docs/project-memory.md`、`docs/roadmap.md`、`docs/decision-log.md` 和 `docs/conversation-log.md`。

## 17. 完成标准

Agent Core 第一阶段完成时，应满足：

- 项目有清晰的 `src/lib/core.ts` 大脑入口。
- 自然语言消息不再直接从 listen 跳到模型回复，而是经过 Agent Core 决策。
- Agent Core 能选择回答、追问、读上下文、暂停、停止和生成行动候选。
- 手和脚仍然不会被自然语言主流程自动执行。
- 所有核心方法都有详细 JSDoc。
- 主要决策可在 audit 和调试 API 中看到。
- 现有读、听、说、手、脚能力不被破坏。

## 18. 后续阶段预留

第一阶段完成后，后续可以继续推进：

- 把 slash command 也纳入 AgentDecision。
- 建立 Episode Store。
- 建立 Skill Index 和 Skill Recall。
- 把 MemoryDecision 接入长期记忆。
- 让手/脚 proposal 在用户确认后转成真实 plan。
- 为多轮任务加入 task state。
- 为 MCP Client Manager 增加能力发现和路由。
- 为前端增加 Agent Core 决策可视化。
