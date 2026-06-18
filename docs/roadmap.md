# 路线图

最后更新：2026-06-18

## 当前阶段

学习型 MVP，当前已经完成“读/眼睛”“听/耳朵”“嘴巴/表达”“手/修改”“脚/执行”和“Agent Core/大脑”的第一阶段运行时。

当前最重要的目标是把大脑生成的 `ActionProposal` 安全接到手和脚的 plan、preview、approval 和 result 链路。

当前已支持中文/英文界面切换，默认中文。

当前新增设计方向：先围绕 MCP 和 Skill 建立 DAX Agent 的按需学习模型。第一阶段已经把“小孩模型”里的眼睛、耳朵、嘴巴、手、脚和最小大脑落到 TypeScript 运行时。

项目实现语言已明确为 TypeScript-first，不使用 Python。

## 下一优先级

下一步把 Agent Core 的行动建议变成“proposal -> plan -> preview -> approval -> result”的受控行动流程。

计划工作：

1. 已完成 `docs/agent-learning-model.md`。
2. 已完成 `docs/read-capability-design.md`。
3. 已完成读能力第一阶段运行时：ReadPlan、ReadResult、ContextBlock、ReadEvent、read API。
4. 已完成 `docs/listen-capability-design.md`。
5. 已完成听能力第一阶段运行时：ListenEvent、ListenResult、listen API、用户消息入口接入。
6. 已完成 `docs/speak-capability-design.md`：嘴巴/表达能力设计，明确 SpeakPlan、SpeakMessage、SpeakResult、草稿边界和“表达不是执行”。
7. 已完成嘴巴能力第一阶段运行时：SpeakPlan、SpeakMessage、SpeakResult、speak API、assistant 消息入口接入。
8. 已完成 `docs/agent-core-design.md`：最小大脑设计，明确模型思考器、代码边界、工作记忆、记忆策略、能力路由和 Policy Gate。
9. 已完成 `docs/hand-capability-design.md`：手/修改能力设计，明确 HandPlan、HandAction、HandPreview、HandResult、H0-H3 分级、diff preview 和审批边界。
10. 已完成 `docs/hand-capability-implementation-plan.md`：手能力第一阶段实现设计，明确类型、方法、API、审计、验证计划和 JSDoc 要求。
11. 已完成手能力第一阶段运行时：`src/lib/hand.ts`、hand API、hand store/audit、workspace patch preview / apply / result。
12. 已完成 `docs/foot-capability-design.md`：脚/执行能力设计，明确 FootPlan、FootPreview、FootResult、本地命令执行、F0-F3 分级和审批边界。
13. 已完成脚能力第一阶段运行时：`src/lib/foot.ts`、foot API、foot store/audit，以及 `shell.run` 接入脚能力。
14. 已完成 `docs/agent-core-implementation-plan.md`：Agent Core 第一阶段实现设计，明确类型、模块、方法、JSDoc、审计、API、验证计划和接入顺序。
15. 已完成 Agent Core 第一阶段类型、store、audit 和 `src/lib/core.ts`。
16. 已完成自然语言 Agent Core 根据 ListenResult 判断是否需要读取，并最多自动执行一次 ReadPlan。
17. 已完成把 ContextBlock 注入 WorkingMemory，并进行第二次决策。
18. 已完成让 SpeakPlan 承接 AgentDecision，Policy Gate 阻止时会生成明确边界说明。
19. 已完成 Agent Core 生成 hand/foot ActionProposal；下一步接入 `ActionProposal -> HandPlan/FootPlan -> Preview -> Approval -> Result`。
20. 再增强手能力：rollback、dirty workspace 检测、adapter 层和更好的 diff。
21. 之后再设计 Skill 文件格式和 Skill Index。
22. 设计 MCP Client Manager 如何接入现有 toolRuns 审批系统。
23. 设计 Episode Store，用来记录一次完整任务经历。
24. 设计 Skill Distiller，把成功经验整理成 draft Skill。

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
- Speak Capability、SpeakPlan、SpeakMessage、草稿、受众和表达边界。
- Agent Core、Model Reasoner、AgentDecision、Working Memory、MemoryDecision 和 Policy Gate。
- Agent Core Implementation、CapabilityRoute、ActionProposal、Policy Gate 审计和自然语言主流程接入。
- Hand Capability、HandPlan、HandPreview、Patch、H0-H3 修改风险和审批边界。
- Hand Implementation、workspace write、unified diff、hash guard、HandResult 和 JSDoc 规范。
- Foot Capability、FootPlan、FootPreview、FootResult、命令执行、timeout、F0-F3 执行风险和审批边界。
