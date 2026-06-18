# Agent Core 第一阶段实现记录

最后更新：2026-06-18

状态：第一阶段运行时已完成。

相关文档：

- `docs/agent-core-design.md`
- `docs/agent-core-implementation-plan.md`
- `docs/read-capability-implementation.md`
- `docs/listen-capability-implementation.md`
- `docs/speak-capability-implementation.md`
- `docs/hand-capability-implementation.md`
- `docs/foot-capability-implementation.md`

## 1. 实现结果

本轮已经根据 `docs/agent-core-implementation-plan.md` 完成 Agent Core 第一阶段运行时。

自然语言消息主流程现在是：

```text
用户消息
  -> ListenEvent
  -> ListenResult
  -> AgentCoreInput
  -> WorkingMemory
  -> AgentDecision
  -> PolicyGateResult
  -> CapabilityRoute
  -> 可选的一次 ReadPlan
  -> 第二次 AgentDecision
  -> SpeakPlan
  -> SpeakMessage
```

当前大脑已经能：

- 处理 stop、pause、纯 resume 和 status 等确定性控制信号。
- 根据 `ListenResult.contextNeeds` 判断是否需要读取。
- 自动执行最多一次受限 `ReadPlan`。
- 把 `ContextBlock` 加入短期 `WorkingMemory`。
- 使用低等级模型生成严格 JSON 的候选决策。
- 在 echo、模型错误或非法 JSON 时使用本地 fallback。
- 对每个决策执行 Policy Gate。
- 把决策路由到 read、speak、hand proposal、foot proposal、memory candidate、skill skip 或 none。
- 让 `SpeakPlan` 承接最终 `AgentDecision`。
- 持久化 Agent Core 结果、决策、策略检查、能力路由和审计。

当前大脑不会：

- 自动写文件。
- 自动执行命令。
- 自动提交或推送。
- 自动写入长期记忆文档。
- 自动调用尚未实现的 Skill Runtime。
- 把 `ActionProposal` 说成 `HandResult` 或 `FootResult`。

## 2. 新增和修改的代码

### 2.1 `src/lib/types.ts`

新增类型：

- `AgentDecisionType`
- `AgentDecisionSource`
- `AgentRiskLevel`
- `MemoryDecision`
- `SkillDecision`
- `ActionProposal`
- `PolicyGateResult`
- `CapabilityRoute`
- `AgentDecisionCandidate`
- `ModelReasoningInput`
- `ModelReasoningResult`
- `WorkingMemory`
- `AgentCoreInput`
- `AgentDecision`
- `AgentCoreResult`

`AuditRecord` 新增 Agent Core 关联字段。

`Store` 新增：

- `agentDecisions`
- `policyGateResults`
- `capabilityRoutes`
- `agentCoreResults`

现有旧 `data/store.json` 不需要手工迁移。`readStore()` 会继续用 `emptyStore()` 的默认结构补全新增数组。

### 2.2 `src/lib/core.ts`

新增 Agent Core 核心模块。

这个模块不是单一模型调用，而是按顺序组合：

```text
输入收敛
  -> 工作记忆
  -> 硬控制
  -> 读判断
  -> 模型候选
  -> schema 校验
  -> fallback
  -> Policy Gate
  -> CapabilityRoute
  -> SpeakPlan
  -> store/audit
```

### 2.3 `src/lib/store.ts`

新增持久化方法：

- `recordAgentDecision()`
- `listAgentDecisions()`
- `recordPolicyGateResult()`
- `listPolicyGateResults()`
- `recordCapabilityRoute()`
- `listCapabilityRoutes()`
- `recordAgentCoreResult()`
- `recordAgentCoreFailure()`
- `listAgentCoreResults()`

删除 Session 时也会删除该 Session 对应的 Agent Core 结果。

### 2.4 `src/lib/agent.ts`

`processUserMessage()` 已从：

```text
listen -> model -> speak
```

升级为：

```text
listen -> Agent Core -> optional read -> Agent Core -> speak
```

slash command 暂时保持原直接路径：

- `/help`
- `/list`
- `/read`
- `/search`
- `/run`

这样可以保留已经稳定的显式命令语义，同时把自然语言主流程先接入大脑。

### 2.5 `src/server.ts`

新增 Agent Core 调试 API 和查询 API。

## 3. Agent Core 核心方法

`src/lib/core.ts` 的 exported 方法和关键 helper 都有 JSDoc，说明使用方法、作用和边界。

### 3.1 `createAgentCoreInput()`

使用方法：

- 在完成 Listen 分析后调用。
- 传入 session、用户消息、ListenResult、消息历史、上下文、待处理工具请求和配置。

作用：

- 创建稳定的 `AgentCoreInput`。
- 隔离 `agent.ts`、API 和 `core.ts` 的输入边界。

边界：

- 不调用模型。
- 不读取文件。
- 不写入 store。

### 3.2 `createWorkingMemory()`

作用：

- 创建本轮短期工作记忆。
- 保存用户目标、约束、意图、上下文摘要、待追问事项和记忆候选。

边界：

- 不是长期记忆。
- 不自动修改项目文档。

### 3.3 `updateWorkingMemoryWithContext()`

作用：

- 将一次读取产生的 `ContextBlock[]` 合并到工作记忆。
- 对内容做摘要、截断和秘密样式脱敏。

边界：

- 不把无限长度原文塞给模型。

### 3.4 `applyHardControl()`

当前确定性处理：

- stop
- pause
- 没有附加新任务的 resume
- status
- “只讨论、不写代码”硬约束

这些信号优先于模型。

### 3.5 `shouldReadContext()`

作用：

- 判断当前是否需要 read round。

边界：

- 同一轮最多读取一次。
- 已经读取过或已有 ContextBlock 时不会再次触发。

### 3.6 `createReadPlanFromDecision()`

作用：

- 将 Listen 层的 ContextNeed 转成 `ReadPlan`。

第一阶段自动读取支持：

- local file
- document
- workspace
- web page
- computer config
- memory
- search
- runtime

尚无 connector 的 app content、communication、MCP resource 等来源不会进入自动读取。

### 3.7 `buildModelReasoningInput()`

作用：

- 将复杂输入压缩成模型所需摘要。

模型不会收到：

- AppConfig 原对象。
- API key。
- 完整 store。
- 无限长度消息历史。
- 无限长度 ContextBlock。

### 3.8 `reasonWithModel()`

作用：

- 调用现有 OpenAI-compatible 或 Ollama-compatible Provider。
- 要求模型只返回严格 JSON。

echo provider 不会伪造思考结果，而是明确返回 parse error，让本地 fallback 接管。

### 3.9 `parseModelDecision()`

作用：

- 解析普通 JSON 或 fenced JSON。
- 只保留 `AgentDecisionCandidate` 白名单字段。

非法 JSON 不会被宽松修复为可信决策。

### 3.10 `validateAgentDecision()`

作用：

- 校验 decision type、置信度、用户可见文本和当前约束。
- 为 read、memory、skill、hand proposal 和 foot proposal 补全结构。

模型不能通过输出未知 type 扩展自己的能力。

### 3.11 `createFallbackDecision()`

fallback 支持：

- echo provider。
- 模型请求失败。
- 非法 JSON。
- 候选 schema 校验失败。
- 读取失败。

fallback 的原则是保守：

- 实现请求只形成 hand proposal。
- commit/push 只形成 foot proposal。
- 记忆请求只形成候选。
- 审批意图不会隐式选中某个工具请求。
- 不会声称任何行动已经完成。

### 3.12 `applyPolicyGate()`

当前策略：

- answer、ask、pause、stop 默认允许。
- read 最多允许一次。
- hand proposal 允许，但阻止 `hand.apply`。
- foot proposal 允许，但阻止 `foot.execute`。
- memory 只允许候选，阻止长期自动写入。
- Skill Runtime 尚未实现，因此 recall skill 会被阻止并说明原因。
- 用户明确说不要写、不要修改、不要执行时，行动 proposal 也会被阻止。
- 敏感或 secret-like 输入会提升风险等级。

### 3.13 `routeAgentDecision()`

当前 route：

- `read_context -> read/execute`
- `answer_directly -> speak/execute`
- `ask_user -> speak/execute`
- `propose_hand_action -> hand/propose`
- `propose_foot_action -> foot/propose`
- `store_memory -> memory/record`
- `recall_skill -> skill/skip`
- `pause/stop -> none/skip`

route 只是调度判断，不是能力结果。

### 3.14 `createSpeakPlanFromDecision()`

作用：

- 将决策转换成 answer、ask、status、plan、warn、report 或 acknowledge 表达。
- 打开避免虚假执行声明、脱敏和外部承诺保护。

当 Policy Gate 阻止候选时，模型原文会被替换成明确的阻止说明。

### 3.15 `createActionProposalFromDecision()`

作用：

- 创建 hand 或 foot 的行动建议。
- 保留目标、原因、风险、审批要求和未来 plan 的最小建议字段。

边界：

- 不创建完整 action。
- 不生成 preview。
- 不 apply。
- 不 execute。

### 3.16 `decideNextStep()`

这是 Agent Core 主入口。

默认会记录：

- AgentDecision
- PolicyGateResult
- CapabilityRoute
- AgentCoreResult
- model reasoning completed/failed audit
- core completed audit

传入 `{ record: false }` 时可用于纯测试。

### 3.17 `recordAgentCoreResult()` 和 `recordAgentCoreFailure()`

作用：

- 显式保存完整结果。
- 在尚未形成结果时记录不可恢复的 core failure。

## 4. 模型输出协议

模型被要求返回：

```json
{
  "type": "answer_directly",
  "reason": "当前上下文足够。",
  "confidence": 0.8,
  "userVisibleSummary": "给用户的完整回答。",
  "memoryKind": "semantic",
  "memoryValue": "可选记忆候选",
  "skillQuery": "可选 Skill 查询",
  "actionTitle": "可选行动标题",
  "actionReason": "可选行动原因",
  "actionRisk": "medium"
}
```

模型输出仍然必须经过：

```text
parse -> validate -> Policy Gate -> route
```

模型没有直接执行能力。

## 5. 自然语言消息行为

`processUserMessage()` 现在会返回：

- `listenEvent`
- `listenResult`
- `agentCoreResult`
- `agentCoreResults`
- `contextBlocks`
- `readResults`
- `speakPlan`
- `speakMessage`
- `speakResult`
- `toolRuns`

当需要读取时：

- `agentCoreResults[0]` 是 read decision。
- 执行一次 ReadPlan。
- `agentCoreResults[1]` 是读取后的最终 decision。
- `agentCoreResult` 指向最终 decision。

自然语言模型不再通过旧 `tool_request` 文本块直接创建工具运行。

这是有意的边界变化：

- 读由 Agent Core 明确路由。
- 手和脚只能先生成 ActionProposal。
- 真正修改和执行需要后续 proposal -> plan -> preview -> approval 接入。

## 6. API

### 6.1 POST `/api/core/decide`

请求：

```json
{
  "content": "根据项目文档实现 Agent Core",
  "sessionId": "debug-session",
  "locale": "zh-CN",
  "executeReadRound": true
}
```

返回：

- ListenEvent
- ListenResult
- 最终 AgentCoreResult
- 所有 AgentCoreResult
- ContextBlock[]
- ReadResult[]

`executeReadRound` 默认为 false。

### 6.2 GET `/api/agent-core-results`

查看完整大脑结果。

别名：

```text
GET /api/core/results
```

### 6.3 GET `/api/agent-decisions`

查看决策历史。

别名：

```text
GET /api/core/decisions
```

### 6.4 GET `/api/policy-gate-results`

查看策略检查。

别名：

```text
GET /api/core/policy-gates
```

### 6.5 GET `/api/capability-routes`

查看能力路由。

别名：

```text
GET /api/core/routes
```

所有 GET API 支持 `?limit=20`。

## 7. Audit

新增事件：

- `agent.core.model_reasoning.completed`
- `agent.core.model_reasoning.failed`
- `agent.decision.created`
- `agent.policy.checked`
- `agent.route.created`
- `agent.core.completed`
- `agent.core.failed`

Audit 可以回答：

- 大脑为什么这样决定。
- 决策来自 rule、model 还是 fallback。
- Policy Gate 是否允许。
- 哪些能力被阻止。
- route 是 execute、propose、record 还是 skip。

## 8. JSDoc 规范

本轮继续执行用户要求：

```text
每个 exported 方法和关键 helper 必须解释使用方法、作用和边界。
```

尤其覆盖：

- Agent Core 输入。
- 工作记忆。
- 模型 prompt。
- JSON 解析。
- 决策校验。
- Policy Gate。
- CapabilityRoute。
- ActionProposal。
- 脱敏和摘要。
- store 和 audit。
- API 调试入口。
- `processUserMessage()` 主流程。

## 9. 验证结果

已通过：

- 服务端 TypeScript typecheck。
- Web TypeScript typecheck。
- 服务端 build。
- Web build。

核心函数冒烟验证：

- stop 决策为 `stop`。
- stop route 为 `none/skip`。
- 实现请求第一次决策为 `read_context`。
- read decision 包含 ReadPlan。
- 读取后 echo fallback 决策为 `propose_hand_action`。
- proposal kind 为 `hand`。
- route 为 `hand/propose`。
- Policy Gate 阻止 `hand.apply`。
- malformed JSON 会抛出解析错误并进入 fallback。

真实 `processUserMessage()` 验证：

- stop 消息正常进入 Agent Core。
- SpeakMessage id 与 SpeakResult.messageId 一致。
- 实现请求产生两次 Agent Core 结果。
- 真实执行了一次 ReadPlan。
- 最终只生成 hand ActionProposal。
- 没有创建模型工具请求。
- 没有新增 HandResult。

HTTP API 验证：

- `POST /api/core/decide` 返回完整结构。
- ASCII stop 输入正确识别为 rule source 的 `stop`。
- Agent Core results 查询正常。
- Agent decisions 查询正常。
- Policy Gate results 查询正常。
- Capability routes 查询正常。

测试服务使用端口 `18802`，验证后已停止。

## 10. 当前边界

Agent Core 第一阶段已经完成，但还不是最终大脑。

尚未实现：

- `ActionProposal -> HandPlan/FootPlan` 自动转换。
- proposal preview UI。
- 自然语言审批和具体 tool run 安全绑定。
- 长期 WorkingMemory 或 Task State。
- Episode Store。
- Skill Index 和 Skill Runtime。
- MemoryDecision 自动写入长期记忆。
- 多轮自主循环。
- 多模型分级路由。
- 多 Agent。

## 11. 下一步

下一阶段建议优先实现：

```text
ActionProposal
  -> HandPlan / FootPlan
  -> Preview
  -> Policy Gate
  -> 用户审批
  -> HandResult / FootResult
  -> SpeakPlan 汇报
```

这一阶段仍然需要坚持：

- proposal 不是执行。
- preview 不是执行。
- approval 必须绑定具体 plan。
- 只有真实 result 才能汇报“已修改”或“已执行”。
