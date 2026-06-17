# 对话记录

这个文件保存重要项目对话的简洁摘要，不是逐字聊天记录。

## 2026-06-01

- 用户说明：这个项目自己不会写代码，全程由 Codex 进行开发。
- 项目方向确定为：实现一个类似 OpenClaw 的自用软件。
- Codex 检查工作区，发现项目几乎为空，只有 `.gitignore`。
- Codex 初步学习 OpenClaw 公开信息后，选择先做 local-first Gateway MVP。
- 第一版实现完成：
  - 无外部依赖 Node.js 应用。
  - 本地 WebChat 控制台。
  - Session、Message、Tool Run、Audit 的 JSON 持久化。
  - echo、OpenAI-compatible、Ollama-compatible Provider 抽象。
  - workspace list/read/search 工具。
  - shell command 工具和审批流程。
- Codex 启动本地服务：`http://127.0.0.1:18789`。
- Codex 验证 API 流程、工具审批和浏览器布局。

## 2026-06-02

- Codex 解释当前实现，并把它映射到 OpenClaw-inspired 架构。
- 用户学习后提出：现在应该先规定 Agent 在获得用户自然语言后的操作。
- Codex 提出 Agent Operation Protocol 初稿：
  - 消息标准化。
  - 读取上下文。
  - 意图分类。
  - 信息不足时追问。
  - 风险评估。
  - 生成计划。
  - 创建工具请求。
  - 必要时等待用户审批。
  - 执行并总结。
  - 记录审计。
- 用户暂停并询问：我们的对话是否已经记录在项目中。
- Codex 说明：之前没有自动写入项目文件。
- 用户要求：重要对话都要记录到项目中，避免之后忘记。
- Codex 创建 `docs/` 下的项目记忆文档，并建立后续更新规则。
- 用户询问是否可以在当前基础上增加中文版本。
- Codex 为 Web 控制台加入中文/英文界面切换，默认中文。
- Codex 新增 `README.zh-CN.md`。
- Codex 让 `/help`、本地工具提示和 echo 模式回复跟随界面语言。
- Codex 一度发现旧 Node 运行时兼容问题，用户说明已经切换到 Node 20，不需要兼容低版本 Node。
- Codex 恢复项目运行目标为 Node.js `>=20`，并完成 Node 20 语法检查和中文界面验证。

## 2026-06-16

- 用户询问上一步是否走通，Codex 重新验证了 Node 20、语法检查、服务 API 和中文 `/help`。
- 用户提出下一步讨论 MCP，并认为 Agent 应该注重 MCP 和 Skill 两个方向。
- Codex 解释 MCP 是能力接口层，Skill 是行为方法论层，Agent Core 负责调度。
- 用户提出一个大胆比喻：装上 DAX Agent 的电脑像一个刚出生的小孩；电脑磁盘像海马体；Skill 是存储下来的知识；搜索像父母或老师，应该在需要时发生；Skill 会在相似场景中被唤醒。
- Codex 将这个方向概括为按需驱动的技能学习：`Need -> Search -> Try -> Verify -> Distill -> Store -> Retrieve -> Adapt`。
- 用户决定沿这个方向继续，但先写设计文件，不急着实现。
- Codex 新增 `docs/agent-learning-model.md`，记录小孩模型、MCP/Skill 分层、记忆类型、按需搜索、Skill 沉淀、Skill 召回和未来实现顺序。
- 用户询问项目是否用 Python 写，并表示不想用 Python，希望换成 TypeScript。
- Codex 确认项目没有 Python 应用代码，随后将项目迁移为 TypeScript-first。
- 迁移内容包括后端 `src/**/*.ts`、前端 `src/web/app.ts`、TypeScript 配置、共享类型、构建脚本和编译产物。
- `npm run typecheck`、`npm run build`、编译产物语法检查和 API 冒烟验证均通过。

## 2026-06-17

- 用户提出：按照小孩模型，现在应该开始设计孩子的手脚，也就是 MCP 到底可以做什么。
- Codex 解释 MCP 是 DAX Agent 接触世界的标准神经接口，不是大脑、记忆或 Skill。
- 用户决定先完善“读”这个能力的设计文档。
- Codex 新增 `docs/read-capability-design.md`，把读能力定义为 DAX Agent 的第一类感官。
- 文档覆盖 Read Plan、ReadSource、ReadResult、ContextBlock、MCP resources 映射、只读 tools、风险分级、审批策略、记忆沉淀和未来实现顺序。
- 用户强调：现在只讨论“读”这个地方，不要先设计别的能力；同时 DAX Agent 不只是会敲代码。
- Codex 修正读能力文档：继续只设计读，但明确读能力不是 coding-only，workspace/project 只是 local context 的一种来源。
- 用户进一步确认：眼睛可以读文档、网页、电脑配置、应用内容等；文件和网页默认不需要逐次被允许。
- Codex 将读能力文档升级为“眼睛确定版”：读动作默认不逐次审批，分级用于风险标记和上下文过滤，而不是阻止读取。
- 用户要求根据文档开始写代码，并要求逻辑清晰、每个方法都有详细 doc 解释使用方法和作用。
- Codex 实现读能力第一阶段：新增 `src/lib/read.ts` 统一读取核心，补充 ReadPlan、ReadSource、ReadResult、ContextBlock、ReadEvent 类型，加入 read event 持久化和 HTTP API。
- 当前已支持本地文件、文档、workspace、memory/runtime 文件、网页、电脑配置和 workspace 搜索；应用内容、通信、日历、MCP resource 和 app state 暂时等待 connector。
- Codex 通过 `npm run typecheck`、`npm run build`、编译后核心调用和 HTTP API 调用验证读能力跑通。
- Codex 新增 `docs/read-capability-implementation.md` 记录第一阶段实现边界和验证结果。
- 用户询问听能力是否重要，以及听是否只是理解自然语言。
- Codex 解释：听不只是自然语言理解，而是接收信号、判断是否与 Agent 相关、理解意图、提取约束、识别纠正、判断是否需要触发读能力。
- 用户决定按这个方案设计“耳朵”，要求写详细设计文档。
- Codex 新增 `docs/listen-capability-design.md`，把听能力定义为 DAX Agent 的第二类感官，覆盖 ListenEvent、ListenResult、Intent、SpeechAct、Constraint、Correction、Reference、StateChange、ContextNeed、MemoryCandidate 和未来实现顺序。
- 用户要求根据听能力文档开始写代码，并强调逻辑清晰、每个方法都要有详细 doc 解释使用方法和作用。
- Codex 实现听能力第一阶段：新增 `src/lib/listen.ts` 规则驱动听力核心，补充 ListenEvent、ListenResult 等类型，加入 listen event/result 持久化和 HTTP API。
- Codex 将用户消息入口接入听能力：消息进入 slash command 或模型流程前，会先记录 `ListenEvent` 和 `ListenResult`。
- Codex 通过 `npm run typecheck`、`npm run build`、编译后核心调用、HTTP API 调用和真实消息 API 调用验证听能力跑通。
- Codex 新增 `docs/listen-capability-implementation.md` 记录第一阶段实现边界和验证结果。
- 用户补充确认：读能力和听能力都已经完成，代码已经推送到 `main` 分支。后续应以此作为新的项目基线。
- 用户提出开始思考“嘴巴”能力，并判断嘴巴可以输出什么不应该被硬限制。
- Codex 和用户共同明确：嘴巴是表达层，真正需要控制的是受众、身份、外部影响和隐私边界；嘴巴可以生成回答、解释、追问、计划、汇报和草稿，但草稿不是发送，计划不是执行。
- Codex 新增 `docs/speak-capability-design.md`，把嘴巴能力定义为 DAX Agent 的第三类表达器，覆盖 SpeakPlan、SpeakMessage、SpeakResult、表达分级、风险标记、来源引用、草稿边界和未来实现顺序。
- 用户要求根据嘴巴设计文档开始写代码，要求完全实现，并要求方法有详细 doc 解释使用方法和作用。
- Codex 实现嘴巴能力第一阶段：新增 `src/lib/speak.ts` 统一表达核心，补充 SpeakPlan、SpeakMessage、SpeakResult 等类型，加入 speak plan/message/result 持久化、审计记录和 HTTP API。
- Codex 将 assistant 可见输出接入嘴巴能力：`/help`、未知命令、待审批工具提示、工具结果、模型回复和模型错误都会先生成 `SpeakPlan`、`SpeakMessage` 和 `SpeakResult`。
- Codex 通过 TypeScript typecheck、build、编译后核心调用、HTTP API 调用和真实消息 API 调用验证嘴巴能力跑通。
- Codex 新增 `docs/speak-capability-implementation.md` 记录第一阶段实现边界和验证结果。
- 用户和 Codex 讨论下一步是否应该设计“大脑”还是先设计四肢。Codex 建议先设计最小大脑，因为四肢会改变世界，应该先有统一判断、记忆策略和安全边界。
- 用户提出大脑是否应更多使用模型而不是硬编码规则，并担心大脑要控制五官四肢，Agent 是否能承受压力。
- Codex 建议采用混合大脑：模型负责思考、方案生成和记忆候选，代码负责骨架、调度、权限、schema 校验、Policy Gate 和审计；低等级模型可承担第一版日常思考，高级模型只是未来可选升级。
- 用户要求先设计大脑初版文档。
- Codex 新增 `docs/agent-core-design.md`，定义最小大脑 Agent Core，覆盖 Model Reasoner、Working Memory、AgentDecision、MemoryDecision、SkillDecision、ActionProposal、Policy Gate、能力路由、模型使用策略和未来实现顺序。
- 用户提出开始思考“手”能力。
- Codex 建议把手定义为第一类行动器，先收窄到 workspace 写入和 patch，并强调手会改变世界，所以需要 diff preview、风险分级、审批和审计。
- 用户同意设计手能力，并要求本轮修改后把前面嘴巴运行时和大脑设计一起提交。
- Codex 新增 `docs/hand-capability-design.md`，覆盖手和嘴巴/脚/眼睛/大脑/MCP 的边界、H0-H3 分级、HandPlan、HandAction、HandPreview、HandResult、diff preview、审批策略、记忆沉淀和未来实现顺序。
- 用户提醒：应该先写设计文档再写代码，并再次强调每个方法都要写 doc 解释使用方法和作用，让代码清晰明了。
- Codex 新增 `docs/hand-capability-implementation-plan.md`，把手能力第一阶段代码实现方案先落成文档。
- 该文档明确第一阶段只实现 workspace 内文本文件创建、更新和结构化 patch apply，不实现删除、移动、外部对象、数据库、GUI 或发送消息。
- 文档规定后续实现必须采用 `HandPlan -> HandPreview -> HandResult` 三段式，所有写入先 preview，再 policy gate，再 apply 和 audit。
- 文档明确 `src/lib/hand.ts` 中每个 exported 方法，以及涉及路径、安全、风险、diff、hash、写入的关键内部 helper，都必须写 JSDoc，说明使用方法、作用和边界。
- 当前下一步应根据这份实现设计开始写手能力第一阶段代码，先作为独立 capability 和 HTTP API 跑通，再等待 Agent Core 接入。
