# 项目记忆

最后更新：2026-06-17

这个文件是 DAX Agent 的长期记忆。它用来保存那些应该跨越长对话、上下文压缩和未来开发会话继续有效的重要信息。

## 用户偏好

- 用户不会为这个项目写代码，设计、实现、验证和文档都由 Codex 负责。
- 用户希望一边开发一个类似 OpenClaw 的自用软件，一边学习 OpenClaw 背后的设计理念。
- 项目需要把重要讨论和关键决策记录到仓库文档里，避免时间久了忘记上下文。
- 学习笔记、设计说明和项目记忆优先使用中文。代码、API 名称、文件名和技术标识可以继续使用英文。
- 用户提出 DAX Agent 可以被理解成一个“刚出生的小孩”：MCP 是感官和手脚，电脑磁盘是海马体式记忆空间，Skill 是被消化后的做事方法。当前阶段先写设计，不急着实现运行时。
- 用户不希望项目用 Python 实现。项目方向已明确为 TypeScript-first。
- 当前正在专注完善“读/眼睛”能力设计；不要提前展开其他能力。眼睛可以读文档、网页、电脑配置、应用内容、沟通内容、日历任务、结构化资源和自身记忆。读动作默认不需要逐次审批，但要记录来源、标记风险、控制读取量并过滤上下文。
- 2026-06-17 开始设计“听/耳朵”能力。听不是单纯自然语言理解，而是接收用户和环境信号，并转换成意图、约束、纠正、状态变化、上下文需求和记忆候选。当前只设计听，不设计嘴巴、手、脚、执行或发送消息。

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

主要模块：

- `src/server.ts`：本地 Gateway HTTP 服务和 API 路由。
- `public/`：WebChat 控制台。
- `src/web/app.ts`：WebChat 控制台 TypeScript 源码，编译为 `public/app.js`。
- `src/lib/store.ts`：本地 JSON 持久化，保存 sessions、messages、toolRuns、audit。
- `src/lib/agent.ts`：消息处理、slash command、模型调用流程、工具请求解析。
- `src/lib/tools.ts`：内置 workspace 工具和 shell 工具。
- `src/lib/providers.ts`：echo、OpenAI-compatible、Ollama-compatible 模型 Provider 抽象。
- `src/lib/config.ts`：默认配置、本地配置、环境变量配置和 API key 脱敏。
- `src/lib/types.ts`：共享 TypeScript 类型。
- `dist/`：TypeScript 编译后的后端运行产物。
- `README.zh-CN.md`：中文项目说明。
- `docs/agent-learning-model.md`：DAX Agent 的小孩模型、MCP/Skill 分层和按需学习设计。
- `docs/read-capability-design.md`：DAX Agent 的第一类感官，也就是安全读能力设计。
- `docs/listen-capability-design.md`：DAX Agent 的第二类感官，也就是听能力设计。
- `docs/listen-capability-implementation.md`：听能力第一阶段运行时实现记录。

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
- `docs/read-capability-design.md`：读能力、Read Plan、Context Filter 和 MCP resource 映射。
- `docs/listen-capability-design.md`：听能力、ListenEvent、ListenResult、Intent、Constraint、Correction 和 Context Need。
- `docs/listen-capability-implementation.md`：听能力代码入口、API、验证结果和当前边界。
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
