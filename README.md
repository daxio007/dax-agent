# DAX Agent

[中文说明](README.zh-CN.md)

DAX Agent is a local-first personal AI agent gateway. The first milestone focuses on a self-hosted WebChat control console, model-provider configuration, durable sessions, auditable tool requests, and a permission gate before commands can run.

The project is TypeScript-first. There is no Python runtime or Python application code.

## Run

```bash
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:18789
```

The default provider is `echo`, so the app works without an API key. Configure an OpenAI-compatible endpoint in the settings panel, or set values in `config/local.json`.

## OpenAI-compatible config

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

For Ollama with an OpenAI-compatible endpoint:

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

### Settings notes

- `Echo` is a local demo provider and never calls the Base URL, model, or API key.
- Select `OpenAI compatible` for OpenAI, DeepSeek, and similar endpoints.
- A saved API key is never displayed again in plaintext. The password field stays empty while a masked saved-key status is shown below it.
- Leaving the key field blank preserves the saved key; entering a new value replaces it.
- `Test connection` saves the current settings and sends one minimal connection-test request.

## Built-in chat commands

These commands work even before a real model is configured:

```text
/help
/list .
/read README.md
/search agent
/run node --version
```

Read-only tools run automatically inside the workspace. Shell commands are always created as pending tool runs and must be approved in the control console.

## Agent Core

Natural-language messages now follow `listen -> Agent Core -> optional read -> decision -> speak`. The model only proposes structured decisions; code validates them, applies the Policy Gate, creates an auditable capability route, and falls back locally when the model is unavailable.

Hand and foot decisions remain proposals. Agent Core does not automatically modify files or execute commands.

## Safety model

- The gateway only serves `127.0.0.1` by default.
- Tool execution is scoped to the project workspace.
- Read/search/list tools cannot escape the workspace.
- Shell commands require explicit approval and are written to the audit log.
- Runtime state is stored under `data/` and ignored by git.

This is intentionally a small, inspectable foundation. More channels, richer skills, scheduled tasks, and mobile/IM bridges can be added on top of this gateway.

## Development checks

Every named TypeScript method must have JSDoc that explains its usage and purpose, with one descriptive `@param` entry for every parameter. See `docs/jsdoc-standard.md` for the complete rules.

Run these checks before committing source changes:

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
