# Read Capability Implementation

最后更新：2026-06-17

这份文档记录“读/眼睛”能力第一阶段已经落地到代码里的部分。它只描述读取，不描述写入、执行、发送消息或自动化动作。

## 已实现代码

- `src/lib/types.ts`
  - 新增 `ReadSourceKind`、`ReadSource`、`ReadPlan`、`ReadResult`、`ContextBlock`、`ReadEvent`。
  - `Store` 新增 `readEvents`，审计记录可关联 `readEventId`、`readSource`、`riskLevel`、`riskFlags`。
- `src/lib/read.ts`
  - 新增统一读取核心。
  - 每个方法都有 JSDoc，解释使用方法和作用。
  - 当前支持本地文件、文档、workspace 路径、memory/runtime 文件、网页、电脑配置、workspace 搜索。
- `src/lib/store.ts`
  - 新增 `recordReadEvent()`，记录一次读取事件并写入 audit。
  - 新增 `listReadEvents()`，读取最近的眼睛事件。
- `src/server.ts`
  - 新增 `POST /api/read/plan`。
  - 新增 `POST /api/read/execute`。
  - 新增 `GET /api/read-events` 和 `GET /api/read/events`。

## 当前读取流程

```text
User goal
-> ReadSource[]
-> createReadPlan()
-> executeAndRecordReadPlan()
-> ReadResult[]
-> ContextBlock[]
-> ReadEvent audit
```

## 当前支持的来源

- `local_file`：读取任意本地文件路径，绝对路径按原路径读，相对路径按 workspace 解析。
- `document`：和 `local_file` 使用同一读取入口，未来可接入 Word、PDF、OCR 等解析器。
- `workspace`：读取 workspace 内文件或列出目录。
- `memory`：读取项目记忆类文件，当前仍通过本地文件入口实现。
- `runtime`：读取 DAX Agent 自身运行时文件，例如 `target: "store"` 会映射到 `data/store.json`。
- `web_page`：读取网页文本，保留 URL、content-type，并标记 `external_source` 和 `unverified_content`。
- `computer_config`：读取操作系统、Node 版本、CPU、内存、网络接口、时区、环境变量名等信息。
- `search`：在 workspace 中做轻量全文搜索，帮助先找到应该继续看的文件。

## 尚未接入的来源

这些来源的类型已经存在，但需要对应 connector 或 MCP adapter 后才能读取：

- `app_content`
- `communication`
- `calendar_task`
- `mcp_resource`
- `app_state`

当前调用这些来源会得到明确错误：需要先接入 connector。

## 风险标记

风险等级不会阻止读取，只影响上下文过滤和未来记忆沉淀。

- `L1`：普通读取，例如 README、docs、公开网页。
- `L2`：可能包含配置、隐私或本地系统信息，例如电脑配置、`.env`、`config/local.json`。
- `L3`：高敏或大范围读取，例如通信内容、日历任务、搜索结果、整盘目标。

常见 `riskFlags`：

- `external_source`
- `unverified_content`
- `local_system_state`
- `private_user_data`
- `sensitive_target`
- `contains_secret_like_text`
- `large_file_truncated`
- `environment_values_omitted`
- `contains_environment_values`

## ContextBlock 规则

`ReadResult` 是眼睛实际看到的内容，`ContextBlock` 是进入 Agent 工作上下文前的过滤版本。

当前规则：

- L2/L3 内容进入上下文前会先摘要。
- 上下文内容会做基础脱敏。
- 大文本会截断。
- 网页和搜索结果可信度默认较低。
- 电脑配置、网页和应用状态的新鲜度默认是 `fresh`。

## 已验证

2026-06-17 已验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 编译后的 `read.ts` 核心可读取 `README.md` 和电脑配置。
- `POST /api/read/execute` 可返回 `ReadResult` 和 `ContextBlock`。
- `GET /api/read-events` 可返回最近读取事件。

验证结果摘要：

```json
{
  "core": {
    "results": 2,
    "contextBlocks": 2,
    "riskLevels": ["L1", "L2"]
  },
  "api": {
    "status": 200,
    "results": 1,
    "contextBlocks": 1,
    "recentEvents": 2
  }
}
```

## 下一步建议

下一步不要急着设计嘴巴或手。可以先把自然语言 Agent Core 的“需要读取判断”接到 `ReadPlan` 上，让用户一句自然语言能触发眼睛去读必要上下文。
