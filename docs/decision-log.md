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
