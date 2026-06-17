# DAX Agent

[English README](README.md)

DAX Agent 是一个 local-first 的个人 AI Agent Gateway。第一阶段重点是实现一个自托管 WebChat 控制台、模型 Provider 配置、持久化会话、可审计工具请求，以及命令执行前的审批机制。

项目现在是 TypeScript-first。没有 Python 运行时，也没有 Python 应用代码。

## 运行

```bash
npm install
npm run build
npm start
```

然后打开：

```text
http://127.0.0.1:18789
```

默认 Provider 是 `echo`，所以不需要 API key 也可以运行。你可以在设置面板里配置 OpenAI-compatible endpoint，也可以把配置写入 `config/local.json`。

## OpenAI-compatible 配置

```json
{
  "model": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4.1",
    "temperature": 0.2
  }
}
```

Ollama 的 OpenAI-compatible endpoint 示例：

```json
{
  "model": {
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "",
    "model": "qwen2.5-coder:7b",
    "temperature": 0.2
  }
}
```

## 内置聊天命令

这些命令在还没有配置真实模型时也可以使用：

```text
/help
/list .
/read README.md
/search agent
/run node --version
```

只读工具会在工作区内自动执行。Shell 命令会创建 pending tool run，必须在控制台批准后才会执行。

## 中文界面

Web 控制台现在支持中文和英文界面：

- 默认界面语言是中文。
- 顶部工具栏可以切换 `中文` / `English`。
- 语言偏好会保存到浏览器 `localStorage`。
- `/help`、工具结果提示和 echo 模式回复会跟随当前界面语言。

## 安全模型

- Gateway 默认只监听 `127.0.0.1`。
- 工具执行被限制在项目 workspace 内。
- read/search/list 工具不能逃出 workspace。
- Shell 命令需要明确审批，并会写入 audit log。
- 运行时状态保存在 `data/`，该目录被 git 忽略。

这个项目目前是一个小而可检查的基础版本。之后可以继续增加更多 Channel、更丰富的 Skill、定时任务，以及移动端或 IM 桥接能力。

## 项目记忆

重要讨论、设计说明和决策记录保存在 `docs/`：

- `docs/project-memory.md`
- `docs/design-notes.md`
- `docs/agent-learning-model.md`
- `docs/agent-core-design.md`
- `docs/read-capability-design.md`
- `docs/listen-capability-design.md`
- `docs/speak-capability-design.md`
- `docs/hand-capability-design.md`
- `docs/hand-capability-implementation-plan.md`
- `docs/foot-capability-design.md`
- `docs/foot-capability-implementation.md`
- `docs/read-capability-implementation.md`
- `docs/listen-capability-implementation.md`
- `docs/speak-capability-implementation.md`
- `docs/decision-log.md`
- `docs/roadmap.md`
- `docs/conversation-log.md`

这些文件是项目的长期记忆。每次完成重要设计讨论或开发工作后，都应该更新它们。
