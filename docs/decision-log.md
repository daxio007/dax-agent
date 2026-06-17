# 决策日志

这个文件按时间记录项目里的重要决策。

## 2026-06-01：先做 Local-First MVP

决策：

先实现一个无外部依赖的 Node.js 本地应用，而不是一开始就做完整 OpenClaw 克隆。

原因：

当时工作区几乎为空，也没有可直接使用的包管理器。Node.js 可以运行，因此无依赖应用能最快跑起来，并且方便学习和检查架构。

影响：

第一版使用 Node 内置模块、本地 JSON 持久化和静态前端文件。

## 2026-06-01：把 DAX Agent 设计成 Gateway，而不是聊天页面

决策：

使用 Gateway-centered 架构：sessions、providers、tools、audit、control UI 分层。

原因：

OpenClaw 的核心设计是自托管 Gateway，用来协调 Channel、Model Provider、Agent Runtime、Tool 和状态。

影响：

实现中拆分了 server、agent、providers、tools、config、store、frontend。

## 2026-06-01：Shell 命令必须审批

决策：

只读 workspace 工具可以自动执行，但 shell 命令必须创建 pending tool run，等待用户审批。

原因：

Agent 一旦拥有 shell 权限，就可能影响文件、进程、凭证和外部系统。用户必须能看到并批准危险动作。

影响：

`/run` 会创建 pending `shell.run` 工具请求。控制台可以 approve 或 reject。

## 2026-06-02：把项目记忆持久化到 docs

决策：

在 `docs/` 下维护长期项目记忆文档。

原因：

用户希望重要讨论和决策被记录在项目里，避免长时间开发后忘记上下文。

影响：

新增这些文件：

- `docs/project-memory.md`
- `docs/design-notes.md`
- `docs/decision-log.md`
- `docs/roadmap.md`
- `docs/conversation-log.md`

以后 Codex 在重要讨论或开发后，都应该更新这些文档。

## 2026-06-02：加入中文版本，并明确目标运行时为 Node 20

决策：

为 Web 控制台加入中文/英文界面切换，默认中文；新增 `README.zh-CN.md`；项目运行目标明确为 Node.js `>=20`。

原因：

用户希望在当前基础上增加中文版本，并且已经切换到 Node 20，不需要为了旧版本 Node 做兼容牺牲。

影响：

- 前端增加 locale 状态、翻译表和语言选择控件。
- `/help`、本地工具提示、echo 模式回复会跟随当前界面语言。
- `package.json` 保持 Node.js `>=20`。
- 不再为了 Node 14 等低版本改写现代 Node API。

## 2026-06-16：采用“小孩模型”作为 MCP + Skill 长期设计隐喻

决策：

把 DAX Agent 的长期成长方向定义为：像一个刚出生的小孩一样，通过 MCP 触达世界，通过搜索和用户反馈按需学习，通过本地记忆沉淀 Skill。

原因：

用户提出这个比喻能更好解释 Agent 的成长方式：不是预先知道一切，也不是无目的地搜索一切，而是在遇到具体需求和障碍时学习，并把成功经验沉淀为未来可复用的 Skill。

影响：

- 新增 `docs/agent-learning-model.md`。
- 明确 MCP 是能力接口层，Skill 是行为方法论层。
- 明确 Raw Memory、Episodic Memory、Semantic Memory、Procedural Memory 四类记忆。
- 明确搜索应该按需触发，搜索结果不能直接成为 Skill。
- 当前阶段先设计，不急着实现运行时。

## 2026-06-16：项目迁移为 TypeScript-first，不使用 Python

决策：

项目实现语言明确为 TypeScript-first。后端源码迁移到 `src/**/*.ts`，Web 控制台源码迁移到 `src/web/app.ts`，编译产物分别输出到 `dist/` 和 `public/app.js`。

原因：

用户明确表示不想用 Python 实现。项目此前也没有 Python 运行时代码，只是 `.gitignore` 残留了 Python 模板内容，容易造成误解。TypeScript 更适合后续定义 Agent Decision、MCP Client、Skill Index、Tool Schema 等结构化类型。

影响：

- 新增 TypeScript 配置：`tsconfig.base.json`、`tsconfig.server.json`、`tsconfig.web.json`。
- 新增共享类型文件：`src/lib/types.ts`。
- `package.json` 增加 `build`、`typecheck`、`start`、`dev` 脚本。
- 安装 `typescript` 和 `@types/node` 作为 dev dependencies。
- `npm run typecheck` 和 `npm run build` 已通过。
- 编译后的 `dist/server.js` 已通过 API 冒烟验证。

## 2026-06-17：先完善读能力设计

决策：

在实现 MCP Client Manager 之前，先设计 DAX Agent 的“读”能力，把它作为孩子最早长出的感官。

原因：

读能力是 Agent 理解世界的入口。它决定 Agent 什么时候读取、读哪里、如何过滤、如何审计、如何把读取结果变成工作上下文，以及如何避免把敏感信息或垃圾信息塞进模型。

影响：

- 新增 `docs/read-capability-design.md`。
- 明确读能力来源包括 workspace、runtime state、MCP resources、web/search 和 memory。
- 明确 Read Plan、ReadResult、ContextBlock、风险分级和审批边界。
- 后续实现 MCP resources 前，应先让现有 workspace list/read/search 进入统一 Read Capability 模型。

## 2026-06-17：实现读能力第一阶段运行时

决策：
根据 `docs/read-capability-design.md` 先实现 DAX Agent 的“眼睛”运行时，不提前实现嘴巴、手、写入、执行或自动化能力。

原因：
用户要求开始把确定文档落到代码里，并强调逻辑要清晰，每个方法都要有详细 doc。读能力是后续 MCP resource、Skill required_reads、记忆沉淀和自然语言上下文获取的基础层。

影响：
- 新增 `src/lib/read.ts`，作为统一 Read Capability 核心。
- 新增 ReadPlan、ReadSource、ReadResult、ContextBlock、ReadEvent 类型。
- 新增 read event 持久化和 audit 记录。
- 新增 `/api/read/plan`、`/api/read/execute`、`/api/read-events` API。
- 当前实现覆盖 local file/document、workspace、web page、computer config、memory/runtime 文件和 workspace search。
- app content、communication、calendar task、MCP resource、app state 暂时只保留类型和 connector 错误，等待后续接入。
- 新增 `docs/read-capability-implementation.md` 记录实现边界和验证结果。

## 2026-06-17：设计听能力作为第二类感官

决策：
在读能力之后，设计 DAX Agent 的“听/耳朵”能力。听能力不是单纯自然语言理解，也不是语音转文字，而是把用户和环境输入统一成结构化的意图、约束、纠正、状态变化、上下文需求和记忆候选。

原因：
眼睛解决“Agent 应该看什么”，耳朵解决“用户或环境信号对 Agent 意味着什么”。如果没有听能力，Agent 会把所有用户输入直接当成普通聊天或普通任务，容易忽略暂停、继续、纠正、范围限制和长期偏好。

影响：
- 新增 `docs/listen-capability-design.md`。
- 明确 `ListenEvent` 是所有输入事件的统一入口。
- 明确 `ListenResult` 是 Agent Core 之前的结构化理解结果。
- 明确听能力会识别 Intent、SpeechAct、Constraint、Correction、Reference、StateChange、ContextNeed 和 MemoryCandidate。
- 明确听是感知，不是执行；听到不等于保存，听到不等于同意执行。
- 后续 Natural Language Operation Protocol 应先经过听能力，再决定是否触发 ReadPlan 或其他能力。

## 2026-06-17：实现听能力第一阶段运行时

决策：
根据 `docs/listen-capability-design.md` 实现 DAX Agent 的“耳朵”第一阶段运行时。这个阶段只做输入事件归一化和结构化理解，不做回答、写入、执行或自动化动作。

原因：
用户要求把听能力设计落到代码里，并要求逻辑清晰、每个方法都有详细 doc。听能力是 Natural Language Operation Protocol 的入口，只有先把用户输入理解成 intent、constraint、correction 和 contextNeed，后续 Agent Core 才能稳定决定是否触发 ReadPlan。

影响：
- 新增 `src/lib/listen.ts`，作为统一 Listen Capability 核心。
- 新增 ListenEvent、ListenResult、ListenIntent、SpeechAct、ListenConstraint、ListenCorrection、ListenReference、ListenStateChange、ListenContextNeed、ListenMemoryCandidate 类型。
- 新增 listen event/result 持久化和 audit 记录。
- 新增 `/api/listen/analyze`、`/api/listen-events`、`/api/listen-results` API。
- `processUserMessage()` 已接入听能力，用户消息进入原有流程前会先生成 `ListenEvent` 和 `ListenResult`。
- 当前实现采用规则驱动分类器，后续可替换或叠加模型驱动理解。
- 新增 `docs/listen-capability-implementation.md` 记录实现边界和验证结果。

## 2026-06-17：设计嘴巴能力作为第三类表达器

决策：
在读/眼睛和听/耳朵第一阶段完成并推送到 `main` 后，开始设计 DAX Agent 的“嘴巴/表达”能力。嘴巴不在内容形态上做硬限制，而是控制受众、身份、外部影响、事实透明度和隐私边界。

原因：
眼睛解决“Agent 看见什么”，耳朵解决“输入信号意味着什么”，嘴巴解决“Agent 如何把理解、判断、计划、问题和结果表达出来”。如果没有嘴巴能力，Agent 的输出仍只是模型直接回复，缺少草稿边界、来源标记、不确定性说明和对外影响控制。

影响：
- 新增 `docs/speak-capability-design.md`。
- 明确嘴巴是表达，不是执行；草稿不是发送，计划不是执行，汇报必须基于真实发生的事。
- 明确嘴巴可以回答、解释、追问、计划、汇报、说明风险、生成草稿和结构化输出。
- 明确真正对外发送、写入、执行属于后续 Channel send、手或工具执行能力。
- 明确后续类型设计可围绕 `SpeakPlan`、`SpeakMessage` 和 `SpeakResult` 展开。
- 后续完整流程应演进为 `ListenResult -> ReadPlan -> ContextBlock -> AgentDecision -> SpeakPlan -> SpeakMessage`。

## 2026-06-17：实现嘴巴能力第一阶段运行时

决策：
根据 `docs/speak-capability-design.md` 实现 DAX Agent 的“嘴巴/表达”第一阶段运行时。这个阶段只做本地表达和草稿候选，不做外部发送、写入、执行或发布。

原因：
用户要求把嘴巴设计落到代码里，并强调要完全实现、逻辑清晰、每个方法都有详细 doc。嘴巴能力是 Agent 输出层的基础，必须让回答、追问、计划、汇报、警告和草稿都经过统一表达模型，而不是直接裸写 assistant message。

影响：
- 新增 `src/lib/speak.ts`，作为统一 Speak Capability 核心。
- 新增 SpeakPlan、SpeakMessage、SpeakResult 及相关受众、Channel、模式、身份、来源策略和安全策略类型。
- 新增 speak plan/message/result 持久化和 audit 记录。
- 新增 `/api/speak/plan`、`/api/speak/compose`、`/api/speak-plans`、`/api/speak-messages`、`/api/speak-results` API。
- `processUserMessage()` 的 assistant 输出已接入嘴巴能力，所有可见 assistant 回复都会生成 `SpeakPlan`、`SpeakMessage` 和 `SpeakResult`。
- 嘴巴能力会默认脱敏密钥，给草稿加“尚未发送”标签，外部投递候选会标记需要确认。
- `SpeakResult.externalDelivery` 固定为 `false`，明确嘴巴不是发送能力。
- 新增 `docs/speak-capability-implementation.md` 记录实现边界和验证结果。

## 2026-06-17：设计最小大脑 Agent Core

决策：
在读/眼睛、听/耳朵和嘴巴/表达三类基础能力之后，开始设计 DAX Agent 的“最小大脑” Agent Core。大脑不完全由模型实现，也不完全由规则实现，而是采用“模型负责思考，代码负责骨架和边界”的混合架构。

原因：
大脑未来要控制五官和四肢。如果直接设计四肢，Agent 可能在缺少统一判断、记忆策略和安全边界的情况下开始写入、执行或发送。先设计最小大脑，可以让后续四肢动作都经过 AgentDecision、Policy Gate、MemoryDecision 和 ActionProposal。

影响：
- 新增 `docs/agent-core-design.md`。
- 明确 Agent Core 由 deterministic controller、model reasoner、working memory、memory policy、skill router、capability router、safety policy 和 audit trail 组成。
- 明确低等级模型可以承担第一版日常思考，但模型输出只能是候选决策，必须经过 schema 校验和 Policy Gate。
- 明确大脑先真正路由听、读、说三类能力；四肢暂时只输出 `ActionProposal`，不直接执行。
- 明确后续实现应新增 `AgentDecision`、`WorkingMemory`、`MemoryDecision`、`SkillDecision`、`ActionProposal` 和 `PolicyGateResult` 等类型。

## 2026-06-17：设计手能力作为第一类行动器

决策：
在最小大脑设计之后，开始设计 DAX Agent 的“手/修改”能力。手是第一类行动器，负责对本地或外部对象进行可审计、可预览、可确认的修改。第一版手先收窄到 workspace 文件写入和 patch。

原因：
手会真正改变世界，风险高于读、听和说。为了避免 Agent 听到用户请求后直接乱改文件或外部系统，必须先定义修改分级、diff preview、审批边界、审计记录，以及手和大脑、嘴巴、脚、MCP 的关系。

影响：
- 新增 `docs/hand-capability-design.md`。
- 明确手的核心结构为 `HandPlan`、`HandAction`、`HandPreview` 和 `HandResult`。
- 明确 H0-H3 修改风险分级：H0 不动手，H1 低风险可自动，H2 中风险需要 preview，H3 高风险必须审批。
- 明确第一阶段只设计 workspace 创建、更新和 patch；外部对象、数据库、GUI 应用和发送消息暂不实现。
- 明确大脑先生成 `ActionProposal`，手再转成 `HandPlan`，不能绕过 Agent Core 和 Policy Gate。
- 明确嘴巴不能声称修改已完成，除非有真实 `HandResult`。

## 2026-06-17：先设计手能力第一阶段实现方案

决策：

在真正编写手能力运行时代码前，先新增 `docs/hand-capability-implementation-plan.md`，把第一阶段实现范围、类型、方法、API、审计、验证计划和 JSDoc 规范固定下来。

原因：

手能力会修改 workspace 文件，比读、听、说更容易造成真实副作用。用户也明确提醒：应该先写设计文档再写代码，并且每个方法都要有 doc 解释使用方法和作用。先做实现设计可以避免后续编码时把“能写文件”误当成“安全地动手”。

影响：

- 下一步实现手能力时，必须遵循 `HandPlan -> HandPreview -> HandResult` 三段式。
- 第一阶段只实现 workspace 内文本文件创建、更新和结构化 patch apply。
- 第一阶段暂不解析任意手写 unified diff，`apply_patch` 只应用 DAX Agent 已结构化生成、绑定目标内容 hash 的文本修改。
- 第一阶段手能力先作为独立 capability 和 HTTP API 跑通，暂时不接入 `src/lib/agent.ts` 自然语言主流程。
- 后续每个 exported 方法，以及涉及路径、安全、风险、diff、hash、写入的关键内部 helper，都必须写 JSDoc，说明使用方法、作用和边界。

## 2026-06-17：设计并实现脚能力第一阶段运行时

决策：

将 DAX Agent 的“脚/执行”定义为第一类执行器，负责在受控边界内启动、观察和结束本地执行过程。第一阶段只实现 workspace 内前台命令执行，并采用 `FootPlan -> FootPreview -> FootResult` 三段式。

原因：

用户要求脚能力按同样流程推进：先写设计文档，再修改代码，最后提交。脚能力和手能力一样会产生真实副作用，但它改变的是过程而不是对象。为了避免命令执行散落在 `tools.ts`、API 或未来 Agent Core 中，需要把执行计划、风险、审批、timeout、输出和审计统一到脚能力核心。

影响：

- 新增 `docs/foot-capability-design.md` 和 `docs/foot-capability-implementation.md`。
- 新增 `src/lib/foot.ts`，实现 `FootPlan`、`FootPreview`、`FootResult` 的核心流程。
- 新增 foot 类型、store 持久化、audit 字段和 foot HTTP API。
- 原有 `shell.run` 工具复用脚能力，审批后的 shell 命令会记录 `FootPlan`、`FootPreview` 和 `FootResult`。
- 第一阶段不实现长期后台进程、GUI、远程执行、MCP execution tool、流式输出或交互式 stdin。
- 后续每个脚能力 exported 方法和关键内部 helper 都必须保留 JSDoc，说明使用方法、作用和边界。

## 2026-06-17：补充完整版手能力设计并实现第一阶段运行时

决策：

把“完整版手能力”补充进 `docs/hand-capability-design.md`，并实现 `src/lib/hand.ts` 第一阶段运行时。手能力第一阶段只支持 workspace 内文本文件创建、更新和结构化 `apply_patch`，但类型和设计为完整版 adapter、rollback、外部对象和 Agent Core 接入预留空间。

原因：

用户认可“完整版手应该是所有修改行为的统一安全执行层”这个设计，并要求补充到手设计文档，同时更新代码。手能力此前只有设计文档和实现计划，没有运行时代码；为了让手和脚一样进入可审计能力体系，需要先落地 `HandPlan -> HandPreview -> HandResult`。

影响：

- `docs/hand-capability-design.md` 新增完整版目标、对象模型、adapter、动作模型、rollback、与脚/大脑/记忆/Skill 的关系和多维风险等级。
- 新增 `src/lib/hand.ts`，实现计划、预览、风险标记、workspace 路径边界、hash guard、diff、应用和结果记录。
- 新增 hand 类型、store 持久化、audit 字段和 hand HTTP API。
- 新增 `docs/hand-capability-implementation.md` 记录代码入口、API、验证结果和当前边界。
- 第一阶段仍不支持删除、移动、外部对象、数据库、GUI、剪贴板、消息草稿和 rollback 执行。
- 手能力尚未接入 Agent Core，自然语言主流程暂不自动动手。
