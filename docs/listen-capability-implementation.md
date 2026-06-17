# Listen Capability Implementation

最后更新：2026-06-17

这份文档记录“听/耳朵”能力第一阶段已经落地到代码里的部分。它只描述听力运行时，不描述回答、写入、执行、发送消息或自动化动作。

## 已实现代码

- `src/lib/types.ts`
  - 新增 `ListenEvent`、`ListenResult`、`ListenIntent`、`SpeechAct`、`ListenConstraint`、`ListenCorrection`、`ListenReference`、`ListenStateChange`、`ListenContextNeed`、`ListenMemoryCandidate`。
  - `Store` 新增 `listenEvents` 和 `listenResults`。
  - `AuditRecord` 可关联 `listenEventId`、`listenResultId` 和 `listenIntent`。
- `src/lib/listen.ts`
  - 新增统一听能力核心。
  - 每个方法都有 JSDoc，解释使用方法和作用。
  - 当前采用规则驱动的第一阶段分类器，不依赖模型。
- `src/lib/store.ts`
  - 新增 `recordListenAnalysis()`，记录一次听力事件和理解结果。
  - 新增 `listListenEvents()` 和 `listListenResults()`。
- `src/server.ts`
  - 新增 `POST /api/listen/analyze`。
  - 新增 `GET /api/listen-events` 和 `GET /api/listen-results`。
- `src/lib/agent.ts`
  - 用户消息进入原有 slash command 或模型流程前，会先生成并记录 `ListenEvent` 和 `ListenResult`。
  - `processUserMessage()` 返回值中包含 `listenEvent` 和 `listenResult`。

## 当前听力流程

```text
User / UI / system input
-> createListenEvent()
-> analyzeListenEvent()
-> recordListenAnalysis()
-> ListenResult
-> optional ReadSource suggestions
-> Agent Core
```

## 当前支持的判断

- 基础意图：
  - `ask`
  - `explain`
  - `design`
  - `implement`
  - `review`
  - `inspect`
  - `read`
  - `commit`
  - `push`
  - `configure`
  - `pause`
  - `continue`
  - `stop`
  - `correct`
  - `approve`
  - `reject`
  - `remember`
  - `forget`
  - `status`
  - `chat`
  - `unknown`
- 基础话语动作：
  - 请求、问题、指令、约束、纠正、确认、拒绝、偏好、状态询问、头脑风暴、闲聊。
- 基础约束：
  - scope、process、technology、language、style、pace。
- 基础纠正：
  - “不是 X，是 Y”。
  - “我没有提到 X”。
  - “不对/纠正/更正”。
  - “只讨论/不要设计别的”。
- 基础状态变化：
  - pause、resume、stop、scope_change、priority_change。
- 基础上下文需求：
  - memory、workspace、document、web_page、computer_config、mcp_resource、none。
- 基础记忆候选：
  - project_constraint、workflow、correction、terminology、decision、user_preference。

## 与读能力的连接

`suggestReadSourcesFromListenResult()` 会把 `ListenContextNeed` 映射成 `ReadSource`。

例子：

```text
“根据文档，把代码写出来”
```

会得到：

- primaryIntent: `implement`
- contextNeeds: `memory`、`workspace`、`document`
- nextStep: `read_then_answer`
- readSources: `memory:docs/project-memory.md`、`workspace:.`、`document:docs`

## 已验证

2026-06-17 已验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 编译后的 `listen.ts` 核心可分析用户输入。
- `POST /api/listen/analyze` 可返回 `ListenEvent`、`ListenResult` 和建议 `ReadSource`。
- `GET /api/listen-events` 可返回最近听力事件。
- 用户消息 API `/api/sessions/:id/messages` 已先记录听力结果，再进入原有处理流程。

验证结果摘要：

```json
{
  "core": {
    "primaryIntent": "implement",
    "nextStep": "read_then_answer",
    "contextNeeds": ["memory", "workspace", "document"]
  },
  "api": {
    "primaryIntent": "continue",
    "nextStep": "resume",
    "constraints": ["process", "pace"]
  },
  "messageApi": {
    "hasListenResult": true
  }
}
```

## 当前边界

当前没有实现：

- 常驻麦克风。
- 实时语音识别。
- 外部 Channel Adapter。
- 浏览器/IDE/系统事件自动监听。
- MCP notification adapter。
- 模型驱动的复杂意图分类。
- 自动执行听到的命令。
- 自动写入长期记忆。

当前听能力只是感知和结构化理解层。

## 下一步建议

下一步可以把 Agent Core 的决策流程改成：

```text
ListenResult
-> 如果 nextStep 是 read_then_answer，则创建 ReadPlan
-> 执行 ReadPlan
-> 把 ContextBlock 给 Agent Core
-> 再决定如何回答或计划
```

这样 DAX Agent 就真正开始形成“先听，再看，再思考”的基本循环。
