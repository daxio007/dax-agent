# 项目记忆

最后更新：2026-06-16

这个文件是 DAX Agent 的长期记忆。它用来保存那些应该跨越长对话、上下文压缩和未来开发会话继续有效的重要信息。

## 用户偏好

- 用户不会为这个项目写代码，设计、实现、验证和文档都由 Codex 负责。
- 用户希望一边开发一个类似 OpenClaw 的自用软件，一边学习 OpenClaw 背后的设计理念。
- 项目需要把重要讨论和关键决策记录到仓库文档里，避免时间久了忘记上下文。
- 学习笔记、设计说明和项目记忆优先使用中文。代码、API 名称、文件名和技术标识可以继续使用英文。
- 用户提出 DAX Agent 可以被理解成一个“刚出生的小孩”：MCP 是感官和手脚，电脑磁盘是海马体式记忆空间，Skill 是被消化后的做事方法。当前阶段先写设计，不急着实现运行时。
- 用户不希望项目用 Python 实现。项目方向已明确为 TypeScript-first。

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
- `docs/decision-log.md`：按时间记录关键决策和原因。
- `docs/roadmap.md`：下一步开发计划和优先级。
- `docs/conversation-log.md`：简洁的对话摘要。

不要记录密钥、API key、私有凭证，也不要记录没有必要的逐字聊天全文。
