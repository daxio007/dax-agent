# 路线图

最后更新：2026-06-17

## 当前阶段

学习型 MVP，当前已经完成“读/眼睛”和“听/耳朵”的第一阶段运行时。

当前最重要的目标不是继续堆功能，而是先理解并实现 Agent 收到自然语言后的行为模型。

当前已支持中文/英文界面切换，默认中文。

当前新增设计方向：先围绕 MCP 和 Skill 建立 DAX Agent 的按需学习模型。第一阶段先把“小孩模型”里的眼睛和耳朵设计清楚。

项目实现语言已明确为 TypeScript-first，不使用 Python。

## 下一优先级

下一步让 Natural Language Operation Protocol 变成“先听，再按需读，再进入 Agent Core”的流程。

计划工作：

1. 已完成 `docs/agent-learning-model.md`。
2. 已完成 `docs/read-capability-design.md`。
3. 已完成读能力第一阶段运行时：ReadPlan、ReadResult、ContextBlock、ReadEvent、read API。
4. 已完成 `docs/listen-capability-design.md`。
5. 已完成听能力第一阶段运行时：ListenEvent、ListenResult、listen API、用户消息入口接入。
6. 下一步：让自然语言 Agent Core 根据 ListenResult 判断何时需要读取，并自动生成/执行 ReadPlan。
7. 再把 ContextBlock 注入 Agent Core 的工作上下文。
8. 之后再设计 Skill 文件格式和 Skill Index。
9. 设计 MCP Client Manager 如何接入现有 toolRuns 审批系统。
10. 设计 Episode Store，用来记录一次完整任务经历。
11. 设计 Skill Distiller，把成功经验整理成 draft Skill。

## 未来工作

- 加入 WebSocket 或 Server-Sent Events，用于模型响应和工具进度流式展示。
- 加入结构化 Tool Schema，替代松散 JSON 输入。
- 加入 workspace write 工具，并提供 diff preview。
- 加入更强的 shell command policy。
- 抽象真正的 Channel Adapter。
- 加入第一个外部 Channel。
- 加入 Plugin/Skill Registry。
- 加入 Skill Index、Skill Loader、Skill Review UI。
- 加入 MCP Client Manager。
- 加入 Episode Store 和 Skill Distiller。
- 加入 Multi-Agent Routing。
- 加入长期记忆。
- 加入用户身份和权限 Profile。
- 加入更强 Sandbox。

## 学习主题

- OpenClaw Gateway 架构。
- Agent Loop 设计。
- Tool Calling 和 Approval。
- Session 和 Memory 设计。
- Provider 抽象。
- Channel Adapter。
- Audit 和 Safety。
- MCP 与 Skill 分层。
- 按需学习和程序性记忆。
- Read Capability、Context Filter 和 MCP resources。
- Listen Capability、Intent、Constraint、Correction 和 Context Need。
