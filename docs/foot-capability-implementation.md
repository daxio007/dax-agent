# 脚能力第一阶段实现记录

最后更新：2026-06-17

本轮根据 `docs/foot-capability-design.md` 实现 DAX Agent 的“脚/执行”能力第一阶段运行时。

脚能力第一阶段只负责本地 workspace 内的前台命令执行。它不做长期后台进程管理，不操作 GUI，不远程执行，不发布外部系统，也不绕过审批。

## 已实现内容

### 共享类型

`src/lib/types.ts` 新增：

- `FootRiskLevel`
- `FootActionKind`
- `FootTargetKind`
- `FootResultStatus`
- `FootAction`
- `FootPlan`
- `FootActionPreview`
- `FootPreview`
- `FootCommandResult`
- `FootResult`

`Store` 新增：

- `footPlans`
- `footPreviews`
- `footResults`

`AuditRecord` 新增：

- `footPlanId`
- `footPreviewId`
- `footResultId`
- `footRiskLevel`

### 核心模块

新增 `src/lib/foot.ts`。

主要方法：

- `coerceFootAction()`：把不可信 JSON 收敛成 `FootAction`。
- `createFootAction()`：代码内部创建脚部动作。
- `coerceFootPlan()`：把不可信 JSON 收敛成 `FootPlan`。
- `createFootPlan()`：创建脚部执行计划。
- `detectFootRiskFlags()`：检测命令风险标记。
- `inferFootRisk()`：推导 F0-F3 风险等级。
- `resolveFootCwd()`：解析并校验 cwd 位于 workspace 内。
- `createFootPreview()`：生成执行前预览。
- `canAutoExecuteFootPlan()`：集中表达自动执行策略。
- `createRejectedFootResult()`：创建被拒绝结果。
- `createFailedFootResult()`：创建失败结果。
- `executeFootPlan()`：在 preview 和审批后执行命令。
- `formatFootResultOutput()`：把结构化结果转成工具输出文本。
- `executeAndRecordFootPlan()`：串起计划、预览、执行和持久化。

每个 exported 方法都有 JSDoc。涉及路径、安全、风险、timeout、执行、输出处理和结果格式化的关键内部 helper 也有 JSDoc，说明使用方法和作用。

### 持久化和审计

`src/lib/store.ts` 新增：

- `recordFootPlan()`
- `recordFootPreview()`
- `recordFootResult()`
- `listFootPlans()`
- `listFootPreviews()`
- `listFootResults()`

审计事件类型：

- `foot.planned`
- `foot.previewed`
- `foot.completed`
- `foot.failed`
- `foot.rejected`
- `foot.skipped`
- `foot.timed_out`

### HTTP API

`src/server.ts` 新增：

- `POST /api/foot/plan`
- `POST /api/foot/preview`
- `POST /api/foot/execute`
- `GET /api/foot-plans`
- `GET /api/foot-previews`
- `GET /api/foot-results`

兼容别名：

- `GET /api/foot/plans`
- `GET /api/foot/previews`
- `GET /api/foot/results`

`POST /api/foot/execute` 支持两种输入：

1. 直接传 `goal`、`reason`、`actions`。
2. 传已经创建好的 `plan`。

`approved: true` 表示调用方已经完成审批。没有审批时，真实命令执行会返回 `FootResult.status = "rejected"`。

### shell.run 接入

`src/lib/tools.ts` 中原有 `shell.run` 现在复用脚能力：

```text
shell.run approved
-> FootPlan
-> FootPreview
-> FootResult
-> tool.completed / tool.failed
```

这意味着旧的工具面板仍然可用，同时命令执行进入脚能力持久化和审计链。

## 当前能力

第一阶段支持：

- workspace 内运行前台 shell 命令。
- 捕获 stdout。
- 捕获 stderr。
- 捕获 exit code。
- 捕获 timeout。
- 捕获 duration。
- 输出过长时截断。
- 对常见 key、token、password 和 bearer token 做基础脱敏。
- 检测 destructive、network、dependency、long-running、build、test 等风险标记。
- 阻止 cwd 逃出 workspace。
- 在 `allowShell` 禁用时拒绝执行。
- 将执行结果写入 audit。

第一阶段保守策略：

- 任何真实进程执行都默认需要审批。
- `start_service`、`stop_process`、`external_service` 暂不支持。
- 不支持交互式 stdin。
- 不做流式输出。
- 不做长期后台进程句柄管理。

## API 示例

### 创建计划

```http
POST /api/foot/plan
```

```json
{
  "goal": "检查 Node 版本",
  "reason": "验证本地执行能力",
  "actions": [
    {
      "kind": "run_command",
      "targetKind": "workspace",
      "command": "node --version",
      "cwd": ".",
      "reason": "查看当前 Node 版本",
      "expectedEffect": "输出 Node 版本号",
      "inputSummary": "node --version"
    }
  ]
}
```

### 生成预览

```http
POST /api/foot/preview
```

可以传同样的 body，也可以传：

```json
{
  "plan": {}
}
```

### 执行命令

```http
POST /api/foot/execute
```

```json
{
  "approved": true,
  "goal": "检查 Node 版本",
  "reason": "验证本地执行能力",
  "actions": [
    {
      "kind": "run_command",
      "targetKind": "workspace",
      "command": "node --version",
      "cwd": ".",
      "reason": "查看当前 Node 版本",
      "expectedEffect": "输出 Node 版本号",
      "inputSummary": "node --version"
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
- 编译后的脚能力核心可以创建 `FootPlan`、生成 `FootPreview`、执行已审批命令并生成 `FootResult`。
- HTTP API `/api/foot/execute` 可以返回 `plan`、`preview` 和 `result`。
- HTTP API `/api/foot-results` 可以返回最近脚部执行结果。
- 原有 `/run node --version` 工具审批链仍可通过，并且底层会写入脚能力记录。

## 当前边界

- 第一阶段只做本地 workspace 命令执行。
- 命令本身仍通过 shell 运行，因此风险识别是启发式，不是完整沙箱。
- `approved: true` 是 API 层传入的审批结果，不是独立审批 UI。
- 高风险命令会被标记，但第一阶段主要依赖审批和 workspace cwd 边界。
- 长期服务、进程停止、远程执行、GUI、自动化任务和 MCP execution tool 尚未实现。

## 后续建议

下一步可以继续实现手能力第一阶段，也可以先做 Agent Core 第一阶段，让大脑能统一调度眼睛、耳朵、嘴巴、手和脚。

如果继续脚能力，推荐顺序：

1. 为长期进程设计 `FootProcessHandle`。
2. 增加流式输出。
3. 增加命令 allowlist / denylist policy。
4. 增加 test/build 专用 adapter。
5. 增加 MCP execution adapter。
6. 把 `FootResult` 纳入 Episode Memory。
