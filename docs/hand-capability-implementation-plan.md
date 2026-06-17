# 手能力第一阶段实现设计

最后更新：2026-06-17

这份文档是 `docs/hand-capability-design.md` 之后的代码实现设计。它的目标不是现在就写运行时代码，而是在写代码前把第一阶段的文件结构、类型、方法、API、安全策略、审计记录和验证方式先固定下来。

用户已经明确要求：后续每个方法都必须有详细 doc，解释使用方法和作用。这一点是本阶段代码实现的硬性要求，不能省略。

## 实现目标

第一阶段手能力只实现 workspace 内文件修改。

它要让 DAX Agent 第一次具备真正的“动手”能力，但这个能力必须是可预览、可审批、可审计、可失败回退到不修改状态的。

第一阶段实现范围：

- 创建 workspace 内的新文本文件。
- 更新 workspace 内已有文本文件。
- 为所有文件写入生成统一 diff preview。
- 通过 preview 和 policy gate 后应用修改。
- 记录 `HandPlan`、`HandPreview`、`HandResult` 和 audit。
- 拒绝逃出 workspace 的路径。
- 拒绝第一阶段不支持的删除、移动、外部对象、GUI、数据库和发送动作。
- 对密钥类文件、配置类文件和大范围修改打风险标记。

第一阶段不实现：

- 删除文件。
- 移动文件。
- 解析任意人类手写的 unified diff。
- 修改 workspace 之外的文件。
- 修改数据库。
- 修改外部服务对象。
- 操作 GUI 应用。
- 发送邮件、IM、公开发布内容。
- 长期自动化任务。
- MCP write tool adapter。

这里的 `apply_patch` 第一阶段不是“解析任意 diff 字符串并执行”，而是“应用 DAX Agent 已经结构化生成并绑定目标内容 hash 的文本修改”。这样可以先保证安全和可审计，再逐步扩展 patch parser。

## 文件计划

后续实现应优先修改这些文件：

- `src/lib/types.ts`：增加手能力共享类型。
- `src/lib/hand.ts`：新增手能力核心模块。
- `src/lib/store.ts`：增加 hand plan、preview、result 的持久化和 audit。
- `src/server.ts`：增加 hand API。
- `docs/hand-capability-implementation.md`：代码完成后记录实现边界和验证结果。
- `docs/project-memory.md`、`docs/roadmap.md`、`docs/decision-log.md`、`docs/conversation-log.md`：完成实现后继续更新长期记忆。

第一阶段暂时不改 `src/lib/agent.ts` 的自然语言主流程。手能力先作为独立 capability 和 HTTP API 跑通。等 Agent Core 第一阶段出现后，再由 `ActionProposal -> HandPlan` 接入大脑。

## 类型设计

类型放在 `src/lib/types.ts`，保持和读、听、说能力一致的风格。

### HandRiskLevel

```ts
export type HandRiskLevel = "H0" | "H1" | "H2" | "H3";
```

含义：

- `H0`：不修改，只计划或预览。
- `H1`：低风险 workspace 小修改，可在明确用户请求下自动应用。
- `H2`：中风险修改，需要 preview，通常需要更明确授权。
- `H3`：高风险修改，必须审批；第一阶段很多 H3 直接拒绝执行。

### HandTargetKind

```ts
export type HandTargetKind =
  | "workspace_file"
  | "document"
  | "config"
  | "external_object"
  | "application_state";
```

第一阶段只真正支持：

- `workspace_file`
- `document`，但会按本地文本文件处理。
- `config`，但默认风险更高。

第一阶段只保留但不执行：

- `external_object`
- `application_state`

### HandActionKind

```ts
export type HandActionKind =
  | "create_file"
  | "update_file"
  | "delete_file"
  | "move_file"
  | "apply_patch"
  | "create_external_draft"
  | "update_external_object";
```

第一阶段支持：

- `create_file`
- `update_file`
- `apply_patch`

第一阶段拒绝：

- `delete_file`
- `move_file`
- `create_external_draft`
- `update_external_object`

### HandAction

建议结构：

```ts
export interface HandAction {
  id: string;
  kind: HandActionKind;
  targetKind: HandTargetKind;
  target: string;
  reason: string;
  expectedChange: string;
  inputSummary: string;
  content?: string;
  expectedCurrentHash?: string;
}
```

字段说明：

- `id`：动作 ID。
- `kind`：动作类型。
- `targetKind`：目标类别。
- `target`：目标路径或外部对象标识。第一阶段必须是 workspace 内路径。
- `reason`：为什么修改。
- `expectedChange`：预期变化。
- `inputSummary`：修改来源摘要，避免审计里塞入大量原文。
- `content`：创建或更新后的完整文本内容。
- `expectedCurrentHash`：调用方认为当前文件内容的 hash。应用时用于检测 stale preview。

第一阶段的写入策略采用“目标文件最终内容”模型：`create_file` 和 `update_file` 都提供 `content`，hand 核心负责读取旧内容、计算 diff、检查风险、生成 preview，再应用最终内容。这样比第一版就解析任意 patch 更稳。

### HandPlan

建议结构：

```ts
export interface HandPlan {
  id: string;
  goal: string;
  reason: string;
  targetKind: HandTargetKind;
  actions: HandAction[];
  riskLevel: HandRiskLevel;
  requiresPreview: boolean;
  requiresApproval: boolean;
  expectedOutcome: string;
  createdAt: string;
}
```

设计要求：

- 一个 plan 可以包含多个 action，但第一阶段应限制数量，避免大范围修改。
- `requiresPreview` 第一阶段几乎总是 `true`。
- `requiresApproval` 由风险等级和风险标记共同推导。
- `targetKind` 可以由 actions 汇总得出。若多个 action 类型不同，取最高风险目标。

### HandActionPreview

建议结构：

```ts
export interface HandActionPreview {
  actionId: string;
  target: string;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes: number;
  afterBytes: number;
  diff: string;
  riskFlags: string[];
}
```

作用：

- 让一个 `HandPreview` 可以包含多文件、多 action 的预览。
- 应用时可以逐项校验 `beforeHash`，防止 preview 生成后文件被用户或其他进程改掉。

### HandPreview

建议结构：

```ts
export interface HandPreview {
  id: string;
  planId: string;
  summary: string;
  affectedTargets: string[];
  actionPreviews: HandActionPreview[];
  diff: string;
  reversible: boolean;
  riskLevel: HandRiskLevel;
  riskFlags: string[];
  createdAt: string;
}
```

设计要求：

- `diff` 是所有 action diff 的合并文本。
- `actionPreviews` 保存每个文件的 hash 和风险。
- 若无法生成 diff，必须带 `no_preview_available`，并且不能自动应用。
- 第一阶段只处理 UTF-8 文本文件。二进制文件直接拒绝。

### HandResult

建议结构：

```ts
export interface HandResult {
  id: string;
  planId: string;
  previewId?: string;
  status: "applied" | "rejected" | "failed" | "skipped";
  changedTargets: string[];
  diffApplied?: string;
  error?: string;
  auditId?: string;
  createdAt: string;
}
```

设计要求：

- 嘴巴只能基于真实 `HandResult` 汇报“已经修改”。
- 失败时必须写明失败原因，但不能泄露密钥原文。
- `diffApplied` 应保存审计所需摘要；如果 diff 很大，未来可以截断或改为引用。

### Store

`Store` 增加：

```ts
handPlans: HandPlan[];
handPreviews: HandPreview[];
handResults: HandResult[];
```

`AuditRecord` 增加：

```ts
handPlanId?: string;
handPreviewId?: string;
handResultId?: string;
handRiskLevel?: HandRiskLevel;
```

audit `type` 建议：

- `hand.planned`
- `hand.previewed`
- `hand.applied`
- `hand.rejected`
- `hand.failed`

## hand.ts 方法设计

`src/lib/hand.ts` 是第一阶段核心。所有 exported 方法和关键内部 helper 都必须写 JSDoc。

### JSDoc 硬性格式

每个公开方法至少包含：

- 方法做什么。
- 使用方法。
- 作用。
- 关键边界或风险。

建议模板：

```ts
/**
 * 创建一次手部修改计划。
 *
 * 使用方法：
 * - API 层收到用户或 Agent Core 的修改请求后调用 createHandPlan(input)。
 * - 调用方需要提供 goal、reason 和 actions。
 * - 这个方法只创建计划，不读取文件，也不应用修改。
 *
 * 作用：
 * - 把“准备改什么、为什么改、风险多高、是否需要预览和审批”固定成结构化记录。
 * - 让后续 preview、policy gate、apply 和 audit 都基于同一份计划。
 *
 * 边界：
 * - 不直接写文件。
 * - 不绕过 preview。
 * - 不接受 workspace 外路径作为可执行目标。
 */
export function createHandPlan(input: CreateHandPlanInput, config?: AppConfig): HandPlan {
  // ...
}
```

内部 helper 如果涉及路径、安全、风险、hash、diff、写入，也必须写 JSDoc。普通字符串清理函数可以不写。

### 输入类型

`src/lib/hand.ts` 内部建议定义：

```ts
export interface CreateHandPlanInput {
  goal: string;
  reason: string;
  actions: Array<unknown>;
  expectedOutcome?: string;
}

export interface CreateHandPreviewInput {
  plan: HandPlan;
}

export interface ApplyHandPlanOptions {
  approved?: boolean;
  dryRun?: boolean;
}

export interface ExecuteHandPlanOutput {
  plan: HandPlan;
  preview: HandPreview;
  result: HandResult;
}
```

`actions` 从 API 进来时可以是 `unknown[]`，再由 `coerceHandAction()` 做收敛。代码内部可以直接传 `HandAction[]`。

### coerceHandAction()

建议签名：

```ts
export function coerceHandAction(value: unknown): HandAction
```

JSDoc 必须说明：

- 使用方法：API 层、Agent Core 或测试把不可信 JSON action 传入。
- 作用：校验 action 类型、目标、目标种类、原因、预期变化和内容字段。
- 边界：不读取文件、不写文件、不判断最终风险，只负责结构收敛。

校验规则：

- `kind` 必须在 `HandActionKind` 里。
- `targetKind` 必须在 `HandTargetKind` 里。
- `target` 必须是非空字符串。
- `reason` 和 `expectedChange` 空时提供默认值。
- `create_file`、`update_file`、`apply_patch` 第一阶段必须有 `content`。
- `delete_file`、`move_file`、外部对象动作第一阶段可以被构造成计划，但执行时必须拒绝。

### createHandAction()

建议签名：

```ts
export function createHandAction(input: Partial<HandAction>): HandAction
```

JSDoc 必须说明：

- 使用方法：代码内部创建稳定 action 时使用。
- 作用：补齐 ID、默认 targetKind、默认 reason 和摘要。
- 边界：仍然需要通过 `coerceHandAction()` 校验。

### createHandPlan()

建议签名：

```ts
export function createHandPlan(input: CreateHandPlanInput, config?: AppConfig): HandPlan
```

JSDoc 必须说明：

- 使用方法：API 或未来 Agent Core 收到修改意图后先调用。
- 作用：把修改意图变成可审计计划。
- 边界：只生成计划，不生成 diff，不写文件。

逻辑：

1. 收敛 actions。
2. 推导 target kind。
3. 检测风险标记。
4. 推导 `riskLevel`。
5. 设置 `requiresPreview`。
6. 设置 `requiresApproval`。
7. 返回 `HandPlan`。

### inferHandRisk()

建议签名：

```ts
export function inferHandRisk(actions: HandAction[], riskFlags?: string[]): HandRiskLevel
```

JSDoc 必须说明：

- 使用方法：创建 plan 和 preview 时调用。
- 作用：把动作类型、目标类型、风险标记合成 H0-H3。
- 边界：风险等级只决定 policy，不代表一定能执行。

基本规则：

- 无 action 或纯预览：`H0`。
- workspace 新建小文本：`H1`。
- workspace 普通更新：`H2`。
- 配置修改：至少 `H2`。
- `.env`、密钥、删除、移动、外部对象、无法预览：`H3`。

### detectHandRiskFlags()

建议签名：

```ts
export function detectHandRiskFlags(actions: HandAction[]): string[]
```

JSDoc 必须说明：

- 使用方法：plan、preview 和 result 都可以调用。
- 作用：生成可审计的风险标签。
- 边界：风险标签是解释依据，不应该直接代替 policy gate。

第一阶段风险标签：

- `modifies_workspace`
- `creates_file`
- `updates_file`
- `deletes_file`
- `moves_file`
- `modifies_config`
- `touches_secret_like_file`
- `large_change`
- `multi_file_change`
- `external_object`
- `application_state`
- `irreversible_change`
- `requires_user_confirmation`
- `unsupported_action`
- `workspace_escape`
- `binary_file`
- `patch_conflict`
- `no_preview_available`

### resolveHandTarget()

建议签名：

```ts
export function resolveHandTarget(action: HandAction, config: AppConfig): ResolvedHandTarget
```

JSDoc 必须说明：

- 使用方法：preview 和 apply 前必须先解析目标。
- 作用：把 action.target 转成 workspace 内绝对路径，并给出相对路径、目标类型和风险标记。
- 边界：如果路径逃出 workspace，必须抛错或返回不可执行状态。

`ResolvedHandTarget` 建议包含：

```ts
interface ResolvedHandTarget {
  action: HandAction;
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  riskFlags: string[];
}
```

路径规则：

- 使用 `resolveWorkspace(config)` 得到 workspace 根目录。
- 使用 `path.resolve(workspace, action.target)` 得到目标绝对路径。
- 目标绝对路径必须等于 workspace 或以 workspace + separator 开头。
- 禁止 `..`、绝对路径和符号链接逃逸造成 workspace 外写入。

符号链接处理第一阶段可以保守：如果目标路径或父路径涉及 symlink，先拒绝或标记高风险，后续再补细粒度策略。

### createHandPreview()

建议签名：

```ts
export async function createHandPreview(plan: HandPlan, config: AppConfig): Promise<HandPreview>
```

JSDoc 必须说明：

- 使用方法：所有 apply 之前必须先调用。
- 作用：读取当前目标内容、生成 diff、计算 hash、汇总风险。
- 边界：只读文件，不写文件；无法 preview 就不能自动 apply。

逻辑：

1. 遍历 plan.actions。
2. 解析目标路径。
3. 拒绝不支持 action。
4. 读取旧内容。新文件 old content 为 empty。
5. 检查二进制内容。
6. 计算 before hash 和 after hash。
7. 生成 unified diff。
8. 汇总 `HandActionPreview`。
9. 生成 `HandPreview`。

### createUnifiedDiff()

建议签名：

```ts
export function createUnifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string
```

JSDoc 必须说明：

- 使用方法：preview 里对每个 action 调用。
- 作用：生成给用户和 audit 查看的一致 diff 文本。
- 边界：第一阶段可以实现简单行级 diff，不追求最短 diff，但必须清晰、稳定、可读。

第一阶段 diff 要求：

- 新文件使用 `--- /dev/null` 和 `+++ target`。
- 删除类 action 第一阶段不执行，但未来可以使用 `+++ /dev/null`。
- 更新文件必须显示旧行和新行。
- 如果 diff 过大，未来可以截断；第一阶段先保留完整 diff，但风险标记 `large_change`。

### applyHandPlan()

建议签名：

```ts
export async function applyHandPlan(
  plan: HandPlan,
  preview: HandPreview,
  options: ApplyHandPlanOptions,
  config: AppConfig
): Promise<HandResult>
```

JSDoc 必须说明：

- 使用方法：API 或未来 Agent Core 在 preview 之后调用。
- 作用：根据 policy gate 结果应用 workspace 文件修改。
- 边界：没有 preview 不应用；preview stale 不应用；H2/H3 没有批准不应用。

应用规则：

- `preview.planId` 必须等于 `plan.id`。
- `preview.actionPreviews` 必须覆盖所有会写入的 action。
- 应用前重新读取目标文件并校验 `beforeHash`。
- hash 不一致时返回 `failed` 或 `rejected`，风险标记 `patch_conflict`。
- H1 可以在明确用户请求下自动应用。
- H2/H3 若 `options.approved !== true`，返回 `rejected`。
- H3 中第一阶段不支持的动作即使 approved 也应拒绝。
- 写入使用 UTF-8。
- 父目录可按需创建，但必须仍在 workspace 内。

### executeAndRecordHandPlan()

建议签名：

```ts
export async function executeAndRecordHandPlan(
  input: CreateHandPlanInput,
  options: ApplyHandPlanOptions,
  config: AppConfig
): Promise<ExecuteHandPlanOutput>
```

JSDoc 必须说明：

- 使用方法：API 层需要“一步完成计划、预览、应用、记录”时调用。
- 作用：串起 create plan、create preview、policy gate、apply 和 store。
- 边界：它不是绕过 preview 的快捷方式；内部仍必须创建 preview。

第一阶段也可以先不暴露这个“一步执行”入口，只暴露 plan、preview、apply 三段式 API。若实现这个方法，必须保持三段式内部步骤可审计。

### canAutoApplyHandPlan()

建议签名：

```ts
export function canAutoApplyHandPlan(plan: HandPlan, preview: HandPreview): boolean
```

JSDoc 必须说明：

- 使用方法：apply 前判断是否可以无需额外审批。
- 作用：把自动应用策略集中到一个地方。
- 边界：返回 true 只代表 policy 允许，不代表写入一定成功。

第一阶段自动应用条件：

- `riskLevel === "H1"`。
- `requiresApproval === false`。
- 没有 H3 风险标记。
- 有可读 diff。
- action 数量和 diff 大小在限制内。
- 全部目标在 workspace 内。

### createRejectedHandResult()

建议签名：

```ts
export function createRejectedHandResult(plan: HandPlan, preview: HandPreview | null, reason: string): HandResult
```

JSDoc 必须说明：

- 使用方法：policy gate 拒绝、用户拒绝、unsupported action 时调用。
- 作用：用标准结构记录“没有修改”的结果。
- 边界：不能写文件，不能假装已经应用。

### createFailedHandResult()

建议签名：

```ts
export function createFailedHandResult(plan: HandPlan, preview: HandPreview | null, error: unknown): HandResult
```

JSDoc 必须说明：

- 使用方法：preview 或 apply 过程中捕获异常时调用。
- 作用：把异常转成安全、可审计、可展示的失败结果。
- 边界：错误信息必须脱敏，不能泄露 key、token 或私密内容。

### hashText()

建议签名：

```ts
export function hashText(text: string): string
```

JSDoc 必须说明：

- 使用方法：preview 和 apply 校验当前内容时调用。
- 作用：判断 preview 之后目标内容是否变化。
- 边界：不是安全认证，不用于密码学权限判断，只用于内容一致性检测。

建议使用 Node 内置 `crypto.createHash("sha256")`。

### isSecretLikeTarget()

建议签名：

```ts
export function isSecretLikeTarget(target: string): boolean
```

JSDoc 必须说明：

- 使用方法：风险检测和目标解析时调用。
- 作用：识别 `.env`、密钥文件、凭证文件等高风险目标。
- 边界：只能做启发式判断，不能保证覆盖所有秘密文件。

### isProbablyBinaryText()

建议签名：

```ts
export function isProbablyBinaryText(text: string): boolean
```

JSDoc 必须说明：

- 使用方法：读取目标文件后判断是否适合文本 diff。
- 作用：避免把二进制文件当文本写坏。
- 边界：启发式检测，第一阶段遇到可疑二进制应保守拒绝。

## store.ts 方法设计

新增方法也必须写 JSDoc，因为它们是手能力审计链的一部分。

### recordHandPlan()

```ts
export async function recordHandPlan(plan: HandPlan): Promise<HandPlan>
```

JSDoc 必须说明：

- 使用方法：创建计划后调用。
- 作用：保存 plan，并写入 `hand.planned` audit。
- 边界：只记录计划，不代表修改已经发生。

### recordHandPreview()

```ts
export async function recordHandPreview(preview: HandPreview): Promise<HandPreview>
```

JSDoc 必须说明：

- 使用方法：生成 preview 后调用。
- 作用：保存 diff preview，并写入 `hand.previewed` audit。
- 边界：preview 不是应用结果。

### recordHandResult()

```ts
export async function recordHandResult(result: HandResult): Promise<HandResult>
```

JSDoc 必须说明：

- 使用方法：apply、reject、fail 后调用。
- 作用：保存最终结果，并按状态写入 audit。
- 边界：只有 `status === "applied"` 才表示真实写入发生。

### listHandPlans()

```ts
export async function listHandPlans(): Promise<HandPlan[]>
```

JSDoc 必须说明：

- 使用方法：API 或 UI 查询最近计划时调用。
- 作用：返回最近的手部修改计划。

### listHandPreviews()

```ts
export async function listHandPreviews(): Promise<HandPreview[]>
```

JSDoc 必须说明：

- 使用方法：API 或 UI 查看最近 preview 时调用。
- 作用：返回最近的 diff preview。

### listHandResults()

```ts
export async function listHandResults(): Promise<HandResult[]>
```

JSDoc 必须说明：

- 使用方法：API 或嘴巴汇报修改历史时调用。
- 作用：返回最近的修改结果。

## API 设计

第一阶段 API 放在 `src/server.ts`，命名保持和 read/listen/speak 能力一致。

### POST /api/hand/plan

请求：

```json
{
  "goal": "新增手能力实现文档",
  "reason": "用户要求写入设计文档",
  "actions": [
    {
      "kind": "create_file",
      "targetKind": "workspace_file",
      "target": "docs/example.md",
      "reason": "保存设计结果",
      "expectedChange": "新增 Markdown 文档",
      "inputSummary": "用户要求",
      "content": "# Example\n"
    }
  ],
  "expectedOutcome": "docs/example.md 存在并包含设计内容"
}
```

响应：

```json
{
  "plan": {}
}
```

行为：

- 创建并记录 `HandPlan`。
- 不读取文件。
- 不写文件。

### POST /api/hand/preview

请求可以传 plan，也可以未来扩展成 planId：

```json
{
  "plan": {}
}
```

响应：

```json
{
  "preview": {}
}
```

行为：

- 读取当前目标。
- 生成 diff。
- 记录 `HandPreview`。
- 不写文件。

### POST /api/hand/apply

请求：

```json
{
  "plan": {},
  "preview": {},
  "approved": false
}
```

响应：

```json
{
  "result": {}
}
```

行为：

- 校验 preview 是否匹配 plan。
- 校验当前文件 hash 是否仍匹配 preview。
- 通过 policy 后写入。
- 记录 `HandResult`。
- H2/H3 未 approved 时返回 `rejected`。

第一阶段不建议让 `/api/hand/apply` 自动按 planId 去找最新 preview 后直接写入，因为这会让 stale preview 更难解释。可以等 UI 审批流出现后再做。

### GET /api/hand-plans

返回最近 `HandPlan[]`。

### GET /api/hand-previews

返回最近 `HandPreview[]`。

### GET /api/hand-results

返回最近 `HandResult[]`。

## Policy Gate 设计

手能力第一阶段内置最小 policy gate。未来 Agent Core 出现后，policy gate 可以上移到大脑，但 hand 自己仍要保留底线。

底线规则：

- 没有 preview 不写入。
- preview 与 plan 不匹配不写入。
- 目标逃出 workspace 不写入。
- 二进制目标不写入。
- 删除和移动第一阶段不写入。
- 外部对象和应用状态第一阶段不写入。
- 密钥类文件第一阶段默认 H3，未明确 approved 不写入。
- H2/H3 未 approved 不写入。
- preview hash 与当前文件不一致不写入。
- 无法生成 diff 不写入。

这套底线不能被模型绕过。模型最多提出 `ActionProposal` 或 `HandPlan` 候选。

## 与嘴巴的关系

嘴巴可以表达计划、风险、预览摘要和结果，但不能替代手。

正确关系：

```text
HandResult.status === "applied"
-> SpeakMessage 可以说“已经修改了这些文件”
```

错误关系：

```text
模型生成了修改方案
-> SpeakMessage 说“我已经修改完成”
```

第一阶段实现后，`src/lib/agent.ts` 仍可以暂时不直接使用 hand。但未来 Agent Core 接入时，assistant 汇报必须优先引用真实 `HandResult`。

## 与大脑的关系

大脑初版还没实现，所以第一阶段手能力先做独立 capability。

未来接入路径：

```text
ListenResult
-> AgentDecision
-> ActionProposal
-> HandPlan
-> HandPreview
-> PolicyGateResult
-> HandResult
-> SpeakPlan / SpeakMessage
```

这意味着：

- 大脑负责判断“该不该动手”。
- 手负责判断“怎么安全动手”。
- Policy Gate 负责判断“能不能动手”。
- 嘴巴负责说明“准备怎么改、改了什么、失败在哪里”。

## 与现有 tools 的关系

当前项目已有 workspace read/search/list 和 shell tool。

手能力不应该直接复用 shell 命令来写文件。原因：

- shell 写入难以稳定预览。
- shell 写入可能绕过 workspace 约束。
- shell 写入不利于逐文件 hash 校验。
- shell 写入的审计粒度太粗。

手能力应该使用 Node 文件 API 做最小、明确、可审计的写入。

shell tool 未来更像“脚”：运行命令、启动服务、执行测试。手负责修改文件，脚负责运行过程。

## 验证计划

代码实现完成后至少验证：

1. server TypeScript typecheck 通过。
2. web TypeScript typecheck 通过。
3. server build 通过。
4. web build 通过。
5. `createHandPlan()` 能创建 `create_file` 计划。
6. `createHandPreview()` 能为新文件生成 `/dev/null` diff。
7. `applyHandPlan()` 能写入 workspace 内新文件。
8. `createHandPreview()` 能为已有文件更新生成 diff。
9. `applyHandPlan()` 能更新已有文件。
10. 目标路径 `../outside.md` 被拒绝。
11. `.env` 或 `config/local.json` 被标记为 H3，并且未 approved 时拒绝。
12. `delete_file` 和 `move_file` 第一阶段被拒绝。
13. preview 后目标文件被改动时，apply 因 hash 不一致失败。
14. `/api/hand/plan` 返回 `HandPlan`。
15. `/api/hand/preview` 返回 `HandPreview`。
16. `/api/hand/apply` 返回 `HandResult`。
17. `GET /api/hand-results` 能看到结果。
18. audit 中出现 `hand.planned`、`hand.previewed`、`hand.applied` 或 `hand.rejected`。

验证时只能使用临时测试文件，例如 `data/hand-smoke/` 或 workspace 中明确的临时路径。不能拿真实配置和项目核心文件做破坏性验证。

## 实现顺序

推荐顺序：

1. 在 `src/lib/types.ts` 增加 hand 类型。
2. 在 `Store` 和 `AuditRecord` 增加 hand 字段。
3. 在 `src/lib/store.ts` 增加 hand 持久化方法。
4. 新增 `src/lib/hand.ts`，先实现 action/plan/risk/path/hash/diff/preview。
5. 为 preview 写最小 smoke。
6. 实现 apply，但只支持 `create_file`、`update_file` 和结构化 `apply_patch`。
7. 加入 API：plan、preview、apply、list。
8. 做 HTTP smoke。
9. 新增 `docs/hand-capability-implementation.md`。
10. 更新项目记忆、路线图、决策日志和对话日志。

实现时不应先接 Agent Core。等手能力作为独立 capability 稳定后，再把大脑接进来。

## 代码清晰度要求

后续实现必须遵守：

- 每个 exported 方法都有 JSDoc。
- 涉及路径、安全、风险、diff、hash、写入的内部 helper 也有 JSDoc。
- JSDoc 必须写“使用方法”和“作用”。
- 方法名要表达意图，不使用模糊缩写。
- 风险判断集中到少数 helper，不散落在 API 层。
- 写入只走 `applyHandPlan()` 或它调用的底层写入 helper。
- API 层只负责解析请求、调用 hand/store、返回 JSON。
- 任何失败都返回结构化 `HandResult` 或清晰 HTTP 错误。
- 不记录密钥原文。
- 不为了通过测试而放宽 workspace 边界。

## 小结

第一阶段手能力的关键不是“能写文件”，而是“能证明自己准备怎么写、实际写了什么、为什么允许写、为什么失败时没有继续写”。

因此下一步代码实现要坚持三段式：

```text
HandPlan -> HandPreview -> HandResult
```

只要这条链稳定，DAX Agent 后面再接大脑、脚、MCP write tool、外部对象和长期记忆时，就不会把“模型想做什么”和“系统真的做了什么”混在一起。
