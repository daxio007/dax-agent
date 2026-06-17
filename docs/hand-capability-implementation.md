# 手能力第一阶段实现记录

最后更新：2026-06-17

本轮根据 `docs/hand-capability-design.md` 和 `docs/hand-capability-implementation-plan.md` 实现 DAX Agent 的“手/修改”能力第一阶段运行时，并把完整版手能力目标补充回设计文档。

手能力第一阶段只负责 workspace 内文本文件创建、更新和结构化 `apply_patch`。它不删除文件，不移动文件，不修改外部对象，不操作 GUI，不改数据库，也不发送消息。

## 已实现内容

### 共享类型

`src/lib/types.ts` 新增：

- `HandRiskLevel`
- `HandTargetKind`
- `HandActionKind`
- `HandResultStatus`
- `HandRollbackStrategy`
- `HandAction`
- `HandPlan`
- `HandActionPreview`
- `HandPreview`
- `HandResult`

`Store` 新增：

- `handPlans`
- `handPreviews`
- `handResults`

`AuditRecord` 新增：

- `handPlanId`
- `handPreviewId`
- `handResultId`
- `handRiskLevel`

### 核心模块

新增 `src/lib/hand.ts`。

主要方法：

- `coerceHandAction()`：把不可信 JSON 收敛成 `HandAction`。
- `createHandAction()`：代码内部创建手部动作。
- `coerceHandPlan()`：把不可信 JSON 收敛成 `HandPlan`。
- `createHandPlan()`：创建手部修改计划。
- `detectHandRiskFlags()`：检测修改风险标记。
- `inferHandRisk()`：推导 H0-H3 风险等级。
- `resolveHandTarget()`：解析并校验目标位于 workspace 内。
- `hashText()`：计算文本 hash，用于 stale preview 检测。
- `isSecretLikeTarget()`：识别密钥类目标。
- `isProbablyBinaryText()`：识别疑似二进制文本。
- `createUnifiedDiff()`：生成稳定的行级 unified diff。
- `createHandPreview()`：生成修改前预览。
- `canAutoApplyHandPlan()`：集中表达自动应用策略。
- `createRejectedHandResult()`：创建被拒绝结果。
- `createFailedHandResult()`：创建失败结果。
- `applyHandPlan()`：在 preview 和审批后应用修改。
- `executeAndRecordHandPlan()`：串起计划、预览、应用和持久化。

每个 exported 方法都有 JSDoc。涉及路径、安全、风险、hash、diff、写入、结果格式化的关键内部 helper 也有 JSDoc，说明使用方法、作用和边界。

### 持久化和审计

`src/lib/store.ts` 新增：

- `recordHandPlan()`
- `recordHandPreview()`
- `recordHandResult()`
- `listHandPlans()`
- `listHandPreviews()`
- `listHandResults()`

审计事件类型：

- `hand.planned`
- `hand.previewed`
- `hand.applied`
- `hand.rejected`
- `hand.failed`
- `hand.skipped`

### HTTP API

`src/server.ts` 新增：

- `POST /api/hand/plan`
- `POST /api/hand/preview`
- `POST /api/hand/apply`
- `POST /api/hand/execute`
- `GET /api/hand-plans`
- `GET /api/hand-previews`
- `GET /api/hand-results`

兼容别名：

- `GET /api/hand/plans`
- `GET /api/hand/previews`
- `GET /api/hand/results`

`POST /api/hand/execute` 支持两种输入：

1. 直接传 `goal`、`reason`、`actions`。
2. 传已经创建好的 `plan`。

`POST /api/hand/apply` 需要传 `plan` 和 `preview`，用于明确的三段式调用。

## 当前能力

第一阶段支持：

- workspace 内创建文本文件。
- workspace 内更新文本文件。
- 通过结构化 `apply_patch` 应用目标最终内容。
- 为新文件生成 `/dev/null` 风格 diff。
- 为已有文件生成行级 diff。
- 写入前校验 `beforeHash`，防止 preview 后目标被用户或其他进程改动。
- 拒绝 workspace 外路径。
- 拒绝疑似二进制内容。
- 拒绝第一阶段不支持的删除、移动、外部对象、数据库、GUI、剪贴板等动作。
- 对 `.env`、`config/local.json`、密钥类目标和密钥类内容打高风险标记。
- 记录 `HandPlan`、`HandPreview`、`HandResult` 和 audit。

第一阶段保守策略：

- H1 可在明确请求下自动应用。
- H2/H3 需要 `approved: true`。
- 不支持任意手写 unified diff parser。
- 不支持 rollback 执行入口，但 preview/result 会记录 `rollbackStrategy`。
- 不接入 `src/lib/agent.ts` 自然语言主流程，等待 Agent Core。

## API 示例

### 创建计划

```http
POST /api/hand/plan
```

```json
{
  "goal": "创建临时文档",
  "reason": "验证手能力",
  "actions": [
    {
      "kind": "create_file",
      "targetKind": "workspace_file",
      "target": "data/hand-smoke/example.md",
      "reason": "写入测试文档",
      "expectedChange": "新增 Markdown 文件",
      "inputSummary": "hand smoke",
      "content": "# Example\n"
    }
  ]
}
```

### 生成预览

```http
POST /api/hand/preview
```

可以传同样的 body，也可以传：

```json
{
  "plan": {}
}
```

### 应用修改

```http
POST /api/hand/execute
```

```json
{
  "approved": true,
  "goal": "创建临时文档",
  "reason": "验证手能力",
  "actions": [
    {
      "kind": "create_file",
      "targetKind": "workspace_file",
      "target": "data/hand-smoke/example.md",
      "reason": "写入测试文档",
      "expectedChange": "新增 Markdown 文件",
      "inputSummary": "hand smoke",
      "content": "# Example\n"
    }
  ]
}
```

## 验证结果

本轮已验证：

- server TypeScript typecheck 通过。
- web TypeScript typecheck 通过。
- server build 通过。
- web build 通过。
- 编译后的手能力核心可以创建 `HandPlan`、生成 `HandPreview`、应用已审批修改并生成 `HandResult`。
- 未审批的 H2 修改会返回 `rejected`。
- 目标路径逃出 workspace 会被拒绝。
- HTTP API `/api/hand/execute` 可以返回 `plan`、`preview` 和 `result`。
- HTTP API `/api/hand-results` 可以返回最近手部修改结果。

## 当前边界

- 第一阶段只做 workspace 内文本文件修改。
- `apply_patch` 当前表示“应用结构化 action.content 作为目标最终内容”，不是解析任意手写 diff。
- 删除、移动、外部对象、数据库、GUI、剪贴板和消息草稿暂不应用。
- rollback 只记录策略，不执行回滚。
- dirty git workspace 还没有专门检测，当前主要依靠目标内容 hash 防止 stale preview。
- 手能力尚未接入 Agent Core，自然语言主流程暂不自动动手。

## 完整版补充

本轮也把“完整版手能力”补充进 `docs/hand-capability-design.md`：

- 手不只是文件写入器，而是所有修改行为的统一安全执行层。
- 完整版需要 `HandTarget` 和 adapter 层。
- 完整版需要 rollback 设计。
- 完整版需要和脚协作，修改后建议运行 typecheck/test/build。
- 完整版不能被模型直接调用，必须经过大脑的 `ActionProposal -> HandPlan`。
- 完整版要把 `HandResult` 沉淀到 Episode Memory，并可能形成 Skill 候选。

## 后续建议

下一步建议：

1. 为手能力增加 rollback 入口。
2. 增加 dirty workspace 检测。
3. 增加更好的 diff 算法。
4. 实现 `WorkspaceFileHandAdapter` 抽象。
5. 把手和脚接入 Agent Core 的 `ActionProposal -> HandPlan/FootPlan`。
6. 让嘴巴汇报时引用真实 `HandResult`。
