# 项目记忆

最后更新：2026-06-17

这个文件是 DAX Agent 的长期记忆。它用来保存那些应该跨越长对话、上下文压缩和未来开发会话继续有效的重要信息。

## 用户偏好

- 用户不会为这个项目写代码，设计、实现、验证和文档都由 Codex 负责。
- 用户希望一边开发一个类似 OpenClaw 的自用软件，一边学习 OpenClaw 背后的设计理念。
- 项目需要把重要讨论和关键决策记录到仓库文档里，避免时间久了忘记上下文。
- 学习笔记、设计说明和项目记忆优先使用中文。代码、API 名称、文件名和技术标识可以继续使用英文。
- 用户提出 DAX Agent 可以被理解成一个“刚出生的小孩”：MCP 是感官和手脚，电脑磁盘是海马体式记忆空间，Skill 是被消化后的做事方法。当前已开始把确定设计逐步落到 TypeScript 运行时。
- 用户不希望项目用 Python 实现。项目方向已明确为 TypeScript-first。
- 读/眼睛第一阶段运行时已完成。眼睛可以读文档、网页、电脑配置、应用内容、沟通内容、日历任务、结构化资源和自身记忆。读动作默认不需要逐次审批，但要记录来源、标记风险、控制读取量并过滤上下文。
- 听/耳朵第一阶段运行时已完成。听不是单纯自然语言理解，而是接收用户和环境信号，并转换成意图、约束、纠正、状态变化、上下文需求和记忆候选。
- 嘴巴/表达第一阶段运行时已完成。嘴巴不应限制内容形态，而应控制受众、身份、外部影响、事实透明度和隐私边界。嘴巴可以回答、解释、追问、计划、汇报和生成草稿，但不能把草稿当发送、把计划当执行，或代表用户对外产生影响。
- 2026-06-17 开始设计“大脑/Agent Core”。大脑不应全靠硬编码规则，也不应完全交给模型；模型负责思考和方案生成，代码负责骨架、边界、调度、schema 校验、Policy Gate 和审计。第一版大脑应支持低等级模型作为日常 Model Reasoner，高级模型只是未来可选升级。
- 2026-06-17 开始设计“手/修改”能力。手是第一类行动器，负责对本地或外部对象进行可审计、可预览、可确认的修改。第一版手应收窄到 workspace 写入和 patch，外部对象、数据库、GUI 应用和发送消息暂不实现。
- 2026-06-17 明确手能力代码实现也必须先写实现设计文档，再写运行时代码。后续每个 exported 方法，以及涉及路径、安全、风险、diff、hash、写入的关键内部 helper，都必须有详细 JSDoc，解释使用方法、作用和边界。

## 产品目标

DAX Agent 的长期方向是一个 local-first、自托管的个人 AI Agent Gateway，设计灵感来自 OpenClaw。

它不应该只是一个聊天页面，而应该逐步成为一个可以做这些事的网关：

- 从一个或多个入口接收用户自然语言。
- 把不同入口的消息统一成内部 Session。
- 把 Session 消息交给 Agent Runtime 处理。
- 让 Agent 可以读取上下文、制定计划、调用工具、请求审批、执行动作并汇报结果。
- 保留可见的 Audit Trail，记录 Agent 做了什么、为什么做。
- 支持可替换的模型 Provider，以及未来的 Channel、Plugin、Skill 扩展。
- 通过 MCP 触达外部世界，通过 Skill 沉淀可复用经验，形成按需学习能力。

## 当前实现

第一版已经迁移为 TypeScript-first 的 Node.js 本地应用。

截至 2026-06-17，“读/眼睛”“听/耳朵”和“嘴巴/表达”的第一阶段运行时已经完成。读和听已经推送到 `main` 分支；嘴巴运行时、大脑设计和手能力设计已经在本地提交。后续讨论和开发应把这三项能力视为当前基线，而不是待设计事项。

主要模块：

- `src/server.ts`：本地 Gateway HTTP 服务和 API 路由。
- `public/`：WebChat 控制台。
- `src/web/app.ts`：WebChat 控制台 TypeScript 源码，编译为 `public/app.js`。
- `src/lib/store.ts`：本地 JSON 持久化，保存 sessions、messages、toolRuns、audit。
- `src/lib/agent.ts`：消息处理、slash command、模型调用流程、工具请求解析。
- `src/lib/tools.ts`：内置 workspace 工具和 shell 工具。
- `src/lib/read.ts`：统一读能力核心。
- `src/lib/listen.ts`：统一听能力核心。
- `src/lib/speak.ts`：统一嘴巴表达能力核心。
- `src/lib/providers.ts`：echo、OpenAI-compatible、Ollama-compatible 模型 Provider 抽象。
- `src/lib/config.ts`：默认配置、本地配置、环境变量配置和 API key 脱敏。
- `src/lib/types.ts`：共享 TypeScript 类型。
- `dist/`：TypeScript 编译后的后端运行产物。
- `README.zh-CN.md`：中文项目说明。
- `docs/agent-learning-model.md`：DAX Agent 的小孩模型、MCP/Skill 分层和按需学习设计。
- `docs/agent-core-design.md`：DAX Agent 的最小大脑设计，定义 Agent Core、Model Reasoner、Working Memory、MemoryDecision、Policy Gate 和能力路由。
- `docs/read-capability-design.md`：DAX Agent 的第一类感官，也就是安全读能力设计。
- `docs/listen-capability-design.md`：DAX Agent 的第二类感官，也就是听能力设计。
- `docs/speak-capability-design.md`：DAX Agent 的第三类表达器，也就是嘴巴能力设计。
- `docs/hand-capability-design.md`：DAX Agent 的第一类行动器，也就是手能力设计。
- `docs/hand-capability-implementation-plan.md`：手能力第一阶段代码实现设计，规定类型、方法、API、审计、验证计划和 JSDoc 要求。
- `docs/read-capability-implementation.md`：读能力第一阶段运行时实现记录。
- `docs/listen-capability-implementation.md`：听能力第一阶段运行时实现记录。
- `docs/speak-capability-implementation.md`：嘴巴能力第一阶段运行时实现记录。

运行目标：

- Node.js `>=20`。
- TypeScript `>=5.5`。

当前本地地址：

```text
http://127.0.0.1:18789
```

## 已验证行为

第一版已经验证过：

- server、agent、tools、frontend script 的 Node 语法检查。
- TypeScript `typecheck` 和 `build`。
- API health check。
- 创建 Session。
- `/help` 返回正常。
- `/read README.md` 作为只读工具自动执行。
- `/run node --version` 创建 pending shell tool run。
- 审批后执行 pending shell 命令。
- 浏览器桌面和移动布局检查，没有横向溢出。
- 浏览器控制台没有错误日志。

## 当前边界

这个项目目前是学习型 MVP，不是完整 OpenClaw 克隆。

已经实现：

- 本地 WebChat 控制台。
- 中文/英文界面切换，默认中文。
- TypeScript-first 源码结构。
- Session 和 Message。
- 基础 Provider 设置。
- read/search/list 工具。
- 读/眼睛第一阶段运行时。
- 听/耳朵第一阶段运行时。
- 嘴巴/表达第一阶段运行时。
- 需要审批的 shell 工具。
- Audit Trail。

尚未实现：

- 多 Channel Adapter。
- WebSocket 或 SSE 流式输出。
- 设备配对或用户身份。
- 强 Sandbox。
- Plugin/Skill Runtime。
- Multi-Agent Routing。
- 长期记忆或向量搜索。
- 完整的自然语言操作协议。

## 项目记忆规则

以后每次有重要讨论或开发完成后，Codex 都应该更新项目记忆文档，然后再认为这一轮工作完成。

使用这些文件：

- `docs/project-memory.md`：长期上下文、用户偏好、当前状态。
- `docs/design-notes.md`：架构和设计说明。
- `docs/agent-learning-model.md`：MCP、Skill、记忆和按需学习模型。
- `docs/agent-core-design.md`：最小大脑、AgentDecision、Model Reasoner、Working Memory、MemoryDecision、Policy Gate 和能力路由。
- `docs/read-capability-design.md`：读能力、Read Plan、Context Filter 和 MCP resource 映射。
- `docs/listen-capability-design.md`：听能力、ListenEvent、ListenResult、Intent、Constraint、Correction 和 Context Need。
- `docs/speak-capability-design.md`：嘴巴能力、SpeakPlan、SpeakMessage、SpeakResult、受众、草稿和表达边界。
- `docs/hand-capability-design.md`：手能力、HandPlan、HandAction、HandPreview、HandResult、diff preview 和审批边界。
- `docs/hand-capability-implementation-plan.md`：手能力第一阶段实现设计，尤其是 workspace 写入、preview、apply、audit 和方法 JSDoc 规范。
- `docs/read-capability-implementation.md`：读能力代码入口、API、验证结果和当前边界。
- `docs/listen-capability-implementation.md`：听能力代码入口、API、验证结果和当前边界。
- `docs/speak-capability-implementation.md`：嘴巴能力代码入口、API、验证结果和当前边界。
- `docs/decision-log.md`：按时间记录关键决策和原因。
- `docs/roadmap.md`：下一步开发计划和优先级。
- `docs/conversation-log.md`：简洁的对话摘要。

不要记录密钥、API key、私有凭证，也不要记录没有必要的逐字聊天全文。

## 2026-06-17 读能力第一阶段实现

本轮根据 `docs/read-capability-design.md` 开始实现“读/眼睛”能力，但仍然只实现读取，不设计写入、执行、发送消息或自动化动作。

已实现：
- `src/lib/types.ts` 新增 `ReadSource`、`ReadPlan`、`ReadResult`、`ContextBlock`、`ReadEvent` 等统一类型。
- `src/lib/read.ts` 新增读取核心，每个方法都有 JSDoc，说明使用方法和作用。
- `src/lib/store.ts` 新增 `recordReadEvent()` 和 `listReadEvents()`，把读取事件纳入持久化和 audit。
- `src/server.ts` 新增 `POST /api/read/plan`、`POST /api/read/execute`、`GET /api/read-events`。
- `docs/read-capability-implementation.md` 记录第一阶段实现边界、入口、风险标记和验证结果。

当前支持读取本地文件、文档、workspace 路径、memory/runtime 文件、网页、电脑配置和 workspace 搜索。`app_content`、`communication`、`calendar_task`、`mcp_resource`、`app_state` 只保留类型和错误提示，等待后续 connector 或 MCP adapter。

验证结果：
- `npm run typecheck` 通过。
- `npm run build` 通过。
- 编译后读取核心可读取 `README.md` 和电脑配置。
- HTTP API `/api/read/execute` 可返回 `ReadResult` 和 `ContextBlock`。
- `/api/read-events` 可返回最近读取事件。

## 2026-06-17 听能力设计

本轮新增 `docs/listen-capability-design.md`，把“听/耳朵”定义为 DAX Agent 的第二类感官。

核心定义：

```text
听 = 接收信号，并判断它对 Agent 意味着什么。
```

听能力覆盖：
- 用户文本和语音转写。
- UI 控制事件。
- Channel 消息。
- MCP 通知。
- 工具结果事件。
- 应用状态事件。
- 时间和任务事件。

听能力输出：
- `ListenEvent`：统一输入事件。
- `ListenResult`：结构化理解结果。
- `Intent`：用户或事件的主要意图。
- `SpeechAct`：话语动作。
- `Constraint`：用户设定的约束。
- `Correction`：用户纠正 Agent 的信息。
- `Reference`：上下文指代。
- `StateChange`：暂停、继续、停止、范围变化。
- `ContextNeed`：是否需要触发读能力。
- `MemoryCandidate`：是否应该沉淀到项目记忆。

设计边界：
- 听是感知，不是执行。
- 听到不等于保存。
- 听到不等于同意执行。
- 听能力可以建议下一步触发 ReadPlan，但不自己读取或执行。

## 2026-06-17 听能力第一阶段实现

本轮根据 `docs/listen-capability-design.md` 实现“听/耳朵”能力第一阶段运行时。

已实现：
- `src/lib/types.ts` 新增 `ListenEvent`、`ListenResult`、`ListenIntent`、`SpeechAct`、`ListenConstraint`、`ListenCorrection`、`ListenReference`、`ListenStateChange`、`ListenContextNeed`、`ListenMemoryCandidate`。
- `src/lib/listen.ts` 新增规则驱动的听能力核心，每个方法都有 JSDoc，说明使用方法和作用。
- `src/lib/store.ts` 新增 `recordListenAnalysis()`、`listListenEvents()`、`listListenResults()`，把听事件和听结果纳入持久化和 audit。
- `src/server.ts` 新增 `POST /api/listen/analyze`、`GET /api/listen-events`、`GET /api/listen-results`。
- `src/lib/agent.ts` 已把用户消息入口接入听能力，用户消息进入 slash command 或模型流程前会先生成 `ListenEvent` 和 `ListenResult`。
- `docs/listen-capability-implementation.md` 记录第一阶段实现边界、入口和验证结果。

当前能力：
- 能识别 ask、explain、design、implement、commit、push、pause、continue、stop、correct、status 等基础意图。
- 能识别请求、问题、指令、约束、纠正、偏好等话语动作。
- 能提取 scope、process、technology、language、style、pace 等约束。
- 能把上下文需求映射成建议 `ReadSource`，为“先听，再读”打通接口。

验证结果：
- `npm run typecheck` 通过。
- `npm run build` 通过。
- 编译后听能力核心可分析用户输入。
- HTTP API `/api/listen/analyze` 可返回 `ListenEvent`、`ListenResult` 和建议 `ReadSource`。
- 用户消息 API `/api/sessions/:id/messages` 已确认会返回 `listenResult`。

## 2026-06-17 嘴巴能力设计

本轮新增 `docs/speak-capability-design.md`，把“嘴巴/表达”定义为 DAX Agent 的第三类表达器。

核心定义：

```text
嘴巴 = 把 Agent 内部状态和判断转化为用户或目标对象可以理解的表达。
```

设计结论：
- 嘴巴不应在内容形态上硬限制。它可以回答、解释、追问、计划、汇报、说明风险、生成草稿和结构化输出。
- 真正需要控制的是说给谁、用什么身份说、是否会造成外部影响、是否泄露不该输出的信息。
- 嘴巴是表达，不是执行。草稿不是发送，计划不是执行，汇报必须基于真实发生的事。
- 嘴巴可以生成邮件、IM、PR 描述、commit message 等草稿，但真正对外发送属于后续 Channel send、手或执行能力。
- 后续类型设计可围绕 `SpeakPlan`、`SpeakMessage`、`SpeakResult` 展开。

## 2026-06-17 嘴巴能力第一阶段实现

本轮根据 `docs/speak-capability-design.md` 实现“嘴巴/表达”能力第一阶段运行时。

已实现：
- `src/lib/types.ts` 新增 `SpeakAudience`、`SpeakChannel`、`SpeakMode`、`SpeakContentType`、`SpeakTone`、`SpeakIdentity`、`SpeakSourcePolicy`、`SpeakSafetyPolicy`、`SpeakSourceRef`、`SpeakPlan`、`SpeakMessage`、`SpeakResult`。
- `src/lib/speak.ts` 新增嘴巴能力核心，每个公开入口和关键内部方法都有 JSDoc，说明使用方法和作用。
- `src/lib/store.ts` 新增 `recordSpeakInteraction()`、`listSpeakPlans()`、`listSpeakMessages()`、`listSpeakResults()`，把表达计划、消息和结果纳入持久化和 audit。
- `src/server.ts` 新增 `POST /api/speak/plan`、`POST /api/speak/compose`、`GET /api/speak-plans`、`GET /api/speak-messages`、`GET /api/speak-results`。
- `src/lib/agent.ts` 已把所有 assistant 可见输出接入嘴巴能力，`/help`、未知命令、工具提示、工具结果、模型回复和模型错误都会生成 `SpeakPlan`、`SpeakMessage`、`SpeakResult`。
- `docs/speak-capability-implementation.md` 记录第一阶段实现边界、入口和验证结果。

当前能力：
- 支持回答、解释、追问、状态、计划、汇报、警告、草稿、总结、结构化、确认和拒绝等表达模式。
- 支持受众、Channel、身份、详细程度、语言、来源策略和安全策略。
- 支持草稿自动标记，外部受众或外部草稿 Channel 会标记需要投递前确认。
- 支持敏感值脱敏、私密数据弱化、风险标记和来源引用。
- `SpeakResult.externalDelivery` 固定为 `false`，明确嘴巴不会真正对外发送。

验证结果：
- server TypeScript typecheck 通过。
- web TypeScript typecheck 通过。
- server build 通过。
- web build 通过。
- 编译后的嘴巴核心可生成草稿表达、脱敏敏感值、标记风险，并保持 `externalDelivery: false`。
- HTTP API `/api/speak/compose` 可返回 `SpeakPlan`、`SpeakMessage`、`SpeakResult`。
- 用户消息 API `/api/sessions/:id/messages` 已确认会返回 `speakMessage`，assistant message meta 中有 `speakMessageId`。

## 2026-06-17 Agent Core 初版大脑设计

本轮新增 `docs/agent-core-design.md`，设计 DAX Agent 的“最小大脑”。

核心定义：

```text
大脑 = 在听、读、说、记忆、Skill 和行动之间做判断、计划、调度和自我校验的 Agent Core。
```

设计结论：
- 大脑不是单纯模型调用，也不是纯规则系统，而是 deterministic controller、model reasoner、working memory、memory policy、skill router、capability router、safety policy 和 audit trail 的组合。
- 模型负责自然语言深层意义、方案思考、计划生成、记忆候选和 Skill 候选；代码负责硬边界、schema 校验、能力路由、审批、脱敏和审计。
- 第一版大脑应支持低等级模型作为日常思考器，高级模型只是未来复杂任务的可选升级。
- 大脑应先真正控制听、读、说三类能力；四肢暂时只输出 `ActionProposal`，不直接执行。
- 大脑需要引入 `AgentDecision`、`WorkingMemory`、`MemoryDecision`、`SkillDecision`、`ActionProposal` 和 `PolicyGateResult` 等结构。

## 2026-06-17 手能力设计

本轮新增 `docs/hand-capability-design.md`，把“手/修改”定义为 DAX Agent 的第一类行动器。

核心定义：

```text
手 = 对本地或外部对象进行可审计、可预览、可确认的修改能力。
```

设计结论：
- 手和读、听、说不同，手会改变世界，因此不能默认全自动。
- 第一版手应收窄到 workspace 文件创建、更新和 patch，不急着做外部对象、数据库、GUI 应用或发送消息。
- 手的核心结构是 `HandPlan`、`HandAction`、`HandPreview` 和 `HandResult`。
- 手的分级为 H0-H3：H0 不修改，H1 低风险可自动，H2 中风险需要 preview，H3 高风险必须审批。
- 手优先使用 diff/patch，修改前预览，修改后记录结果和 audit。
- 手不能绕过大脑和 Policy Gate；大脑先生成 `ActionProposal`，手再转成 `HandPlan`。

## 2026-06-17 手能力第一阶段实现设计

本轮新增 `docs/hand-capability-implementation-plan.md`，把“手/修改”第一阶段应该如何落到代码里先设计清楚，暂时不写运行时代码。

设计结论：
- 第一阶段只实现 workspace 内文本文件创建、更新和结构化 patch apply，不实现删除、移动、外部对象、数据库、GUI 或发送消息。
- 第一阶段采用 `HandPlan -> HandPreview -> HandResult` 三段式，所有写入必须先有 preview。
- `apply_patch` 第一阶段不是解析任意手写 unified diff，而是应用 DAX Agent 已结构化生成、绑定目标内容 hash 的文本修改。
- 后续要在 `src/lib/types.ts` 增加 Hand 类型，在 `src/lib/hand.ts` 新增核心，在 `src/lib/store.ts` 增加持久化和 audit，在 `src/server.ts` 增加 hand API。
- 每个 exported 方法，以及涉及路径、安全、风险、diff、hash、写入的关键内部 helper，都必须写 JSDoc，说明使用方法、作用和边界。
- 第一阶段手能力先作为独立 capability 和 HTTP API 跑通，暂时不接入 `src/lib/agent.ts` 自然语言主流程；等 Agent Core 第一阶段出现后，再接 `ActionProposal -> HandPlan`。
