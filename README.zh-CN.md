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

### 设置面板说明

- `Echo` 是本地演示模式，不会调用 Base URL、模型或 API key。
- OpenAI、DeepSeek 等兼容接口请选择 `OpenAI compatible`。
- API key 保存后不会重新显示明文；密码框保持空白，但下方会显示脱敏后的“已保存”状态。
- 密钥框留空保存会保留已有密钥，输入新值才会替换。
- 点击“测试连接”会先保存当前设置，再发送一条最小连接测试请求。

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

## Agent Core

自然语言消息现在会经过 `听 -> Agent Core -> 按需读 -> 决策 -> 嘴巴表达`。模型只生成结构化候选决策，代码负责 schema 校验、Policy Gate、能力路由、fallback 和审计。

手和脚目前仍然只接收 ActionProposal。Agent Core 不会自动修改文件或执行命令。

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

## 开发检查

所有 TypeScript 命名方法都必须有 JSDoc，并明确说明“使用方法”和“作用”。详细规则见 `docs/jsdoc-standard.md`。

提交源码改动前运行：

```bash
npm run check:jsdoc
npm run typecheck
npm run build
```

## 项目记忆

重要讨论、设计说明和决策记录保存在 `docs/`：

- `docs/project-memory.md`
- `docs/design-notes.md`
- `docs/agent-learning-model.md`
- `docs/agent-core-design.md`
- `docs/agent-core-implementation-plan.md`
- `docs/agent-core-implementation.md`
- `docs/read-capability-design.md`
- `docs/listen-capability-design.md`
- `docs/speak-capability-design.md`
- `docs/hand-capability-design.md`
- `docs/hand-capability-implementation-plan.md`
- `docs/hand-capability-implementation.md`
- `docs/foot-capability-design.md`
- `docs/foot-capability-implementation.md`
- `docs/read-capability-implementation.md`
- `docs/listen-capability-implementation.md`
- `docs/speak-capability-implementation.md`
- `docs/jsdoc-standard.md`
- `docs/decision-log.md`
- `docs/roadmap.md`
- `docs/conversation-log.md`

这些文件是项目的长期记忆。每次完成重要设计讨论或开发工作后，都应该更新它们。
