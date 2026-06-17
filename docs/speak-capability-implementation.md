# Speak Capability Implementation

最后更新：2026-06-17

这份文档记录“嘴巴/表达”能力第一阶段已经落地到代码里的部分。它只描述表达运行时，不描述写入、执行、发送消息、发布内容或自动化动作。

## 已实现代码

- `src/lib/types.ts`
  - 新增 `SpeakAudience`、`SpeakChannel`、`SpeakMode`、`SpeakContentType`、`SpeakTone`、`SpeakIdentity`。
  - 新增 `SpeakSourcePolicy`、`SpeakSafetyPolicy`、`SpeakSourceRef`。
  - 新增 `SpeakPlan`、`SpeakMessage`、`SpeakResult`。
  - `Store` 新增 `speakPlans`、`speakMessages`、`speakResults`。
  - `AuditRecord` 可关联 `speakPlanId`、`speakMessageId`、`speakResultId`、`speakMode`、`speakAudience`、`speakChannel` 和 `speakDraft`。
- `src/lib/speak.ts`
  - 新增统一嘴巴能力核心。
  - 每个公开入口和关键内部方法都有 JSDoc，解释使用方法和作用。
  - 当前实现不依赖模型，负责结构化表达、草稿边界、输出过滤、风险标记和持久化入口。
- `src/lib/store.ts`
  - 新增 `recordSpeakInteraction()`，记录一次表达计划、表达消息和表达结果。
  - 新增 `listSpeakPlans()`、`listSpeakMessages()`、`listSpeakResults()`。
- `src/server.ts`
  - 新增 `POST /api/speak/plan`。
  - 新增 `POST /api/speak/compose`。
  - 新增 `GET /api/speak-plans` / `GET /api/speak/plans`。
  - 新增 `GET /api/speak-messages` / `GET /api/speak/messages`。
  - 新增 `GET /api/speak-results` / `GET /api/speak/results`。
- `src/lib/agent.ts`
  - 所有 assistant 可见输出都会先经过嘴巴能力。
  - `/help`、未知命令、待审批工具提示、只读工具结果、模型回复和模型错误都会生成 `SpeakPlan`、`SpeakMessage`、`SpeakResult`。
  - `processUserMessage()` 返回值中包含 `speakPlan`、`speakMessage` 和 `speakResult`。
  - 会话中的 assistant message meta 会保存 `speakPlanId`、`speakMessageId`、`speakResultId`、`speakMode`、`speakAudience`、`speakChannel`、`speakDraft` 和 `speakRiskFlags`。

## 当前嘴巴流程

```text
Agent Core / local command / model output
-> createSpeakPlan()
-> createSpeakMessage()
-> createSpeakResult()
-> recordSpeakInteraction()
-> add assistant Message
-> local user output
```

嘴巴第一阶段只把内容交给本地会话或生成草稿候选。`SpeakResult.externalDelivery` 固定为 `false`，表示嘴巴不会把内容真正发到外部世界。

## 当前支持的能力

- 表达计划：
  - 受众：`user`、`developer`、`future_self`、`external_person`、`external_group`、`public`、`machine`。
  - Channel：`local_chat`、`web_ui`、`terminal`、`document_draft`、`email_draft`、`im_draft`、`external_channel_draft`、`voice_draft`、`machine_output`。
  - 模式：`answer`、`explain`、`ask`、`status`、`plan`、`report`、`warn`、`draft`、`summarize`、`structured`、`acknowledge`、`decline`。
- 表达消息：
  - 支持 `text`、`markdown`、`json`、`yaml` 格式。
  - 支持来源引用 `SpeakSourceRef`。
  - 支持假设、未知性和风险标记。
  - 支持草稿标记。
- 安全和边界：
  - 默认脱敏 API key、token、password、Bearer token、private key。
  - 外部受众会额外弱化邮箱、手机号和本地路径。
  - 外部受众、草稿 Channel 和 `draft` 模式会自动标记为草稿。
  - 草稿会自动加上“尚未发送”标签。
  - 外部受众或外部草稿 Channel 会标记 `requiresApprovalBeforeDelivery`。
  - 嘴巴不会真正发送外部消息。
- 风险标记：
  - `may_expose_secret`
  - `may_expose_private_data`
  - `external_audience`
  - `public_audience`
  - `draft_may_be_sent`
  - `contains_inference`
  - `contains_unverified_claim`
  - `mentions_tool_result`
  - `requires_user_confirmation`
  - `ambiguous_identity`
  - `contains_action_plan`
  - `high_impact_advice`

## 与听能力的连接

`speakModeFromListenResult()` 会把听力结果映射成表达模式。

例子：

- `nextStep: ask_clarifying_question` -> `mode: ask`
- `primaryIntent: status` -> `mode: status`
- `primaryIntent: explain` -> `mode: explain`
- `primaryIntent: design` 或 `implement` -> `mode: plan`
- `primaryIntent: correct` -> `mode: acknowledge`

当前 `processUserMessage()` 在模型回复路径中会使用这个映射，让用户输入的结构化理解影响嘴巴表达模式。

## API 示例

创建表达计划：

```http
POST /api/speak/plan
```

```json
{
  "mode": "draft",
  "audience": "external_person",
  "channel": "email_draft",
  "locale": "zh-CN"
}
```

生成并记录表达：

```http
POST /api/speak/compose
```

```json
{
  "content": "请联系 test@example.com，apiKey=sk-...",
  "mode": "draft",
  "audience": "external_person",
  "channel": "email_draft",
  "sourceRefs": [
    {
      "kind": "inference",
      "label": "manual draft"
    }
  ]
}
```

返回会包含：

- `plan`
- `message`
- `result`

其中 `message.content` 会被脱敏并加上草稿标签，`result.externalDelivery` 为 `false`。

## 已验证

2026-06-17 已验证：

- server TypeScript typecheck 通过。
- web TypeScript typecheck 通过。
- server build 通过。
- web build 通过。
- 编译后的 `speak.ts` 核心可生成草稿表达、脱敏敏感值、标记风险，并保持 `externalDelivery: false`。
- `POST /api/speak/compose` 可返回 `SpeakPlan`、`SpeakMessage`、`SpeakResult`。
- 真实消息 API `/api/sessions/:id/messages` 已确认会返回 `speakMessage`，并且 assistant message meta 中有 `speakMessageId`。

当前 shell 环境无法直接调用 `npm`，因此验证使用本地 TypeScript 编译器等价执行：

```text
node .\node_modules\typescript\bin\tsc -p tsconfig.server.json --noEmit
node .\node_modules\typescript\bin\tsc -p tsconfig.web.json --noEmit
node .\node_modules\typescript\bin\tsc -p tsconfig.server.json
node .\node_modules\typescript\bin\tsc -p tsconfig.web.json
```

验证结果摘要：

```json
{
  "core": {
    "mode": "draft",
    "requiresApprovalBeforeDelivery": true,
    "draft": true,
    "externalDelivery": false
  },
  "api": {
    "composeMode": "draft",
    "composeDraft": true,
    "composeExternalDelivery": false
  },
  "messageApi": {
    "hasSpeakMessage": true,
    "assistantMetaHasSpeakMessageId": true
  }
}
```

## 当前边界

当前没有实现：

- 外部邮件发送。
- 外部 IM 发送。
- 公共平台发布。
- 写入文件。
- 执行命令。
- 语音播放。
- 多 Channel 投递。
- UI 卡片渲染系统。
- 复杂 persona 系统。
- 自动长期记忆写入。

当前嘴巴能力只是表达层。它可以生成本地回复和外部草稿候选，但不会真正改变外部世界。

## 下一步建议

下一步可以把 Agent Core 的自然语言流程整理成：

```text
ListenResult
-> 如果需要上下文则创建并执行 ReadPlan
-> ContextBlock[]
-> AgentDecision
-> SpeakPlan
-> SpeakMessage
```

这样 DAX Agent 就形成了“先听，再看，再决定怎么说”的基础循环。之后再讨论手、脚、写入、执行和发送能力会更稳。
