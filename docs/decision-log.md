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
