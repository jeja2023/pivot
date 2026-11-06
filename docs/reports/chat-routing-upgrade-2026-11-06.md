# 对话智能路由判断升级验收记录

本报告是迭代阶段记录；后续补齐修复已归入 [v0.7.108](../releases/v0.7.108-智能路由判断与任务续接可靠性升级.md)，当前工程验收与真实模型暂停边界以[最终完成记录](chat-routing-completion-2026-11-06.md)为准。

日期：2026-11-06。对应问题清单：[深度检查报告](chat-routing-deep-audit-2026-11-06.md)。语义策略与响应契约升级到 `chat-intent-v5`。

## 已完成的修复

| 原问题 | 实现结果 | 主要位置 |
| --- | --- | --- |
| 来源限制吞掉任务 | 即时应用范围限制后，带有实质工作的请求继续判断；纯纠正仍直接生效 | `chat-route-correction.js`、`chat-route-correction-handler.js`、`chat-auto-execution-handler.js` |
| 记忆抢占业务 | 纯记忆、混合偏好与工作、词义讨论分流，混合请求保留主任务 | `chat-request-constraints.js`、`chat-auto-execution.js` |
| 短附件漏掉交付 | 中英文文件交付、转换和执行请求不进入文本快捷路径，复用 PPT 格式识别 | `chat-request-delivery.js`、`chat-request-scope.js` |
| 英文否定越界 | 否定匹配约束动作与对象，不跨分句吞掉后续肯定的来源请求 | `chat-request-scope.js` |
| 续接约束冲突与能力丢失 | 时间、地区、对象、格式有明确更新字段；保留安全限制，继承仍需能力并支持显式移除能力 | `chat-task-contract-update.js`、`chat-intent-contract.js` |
| 协议仅靠提示词 | 原生 JSON Schema、必填及跨字段校验；只对明确能力不兼容进行一次兼容重试 | `chat-intent-schema.js`、`chat-intent-model.js` |
| 目录裁剪失真 | 裁剪后按实际可见集合标记 partial，显式选中的工具优先保留，校验不能引用被裁掉的工具 | `chat-intent-context.js`、`chat-capability-scope.js` |
| 长请求中段限制丢失 | 保留限制原文片段，标记完整度；无法完整承载限制时安全降级，长请求不得直接执行业务查询 | `chat-intent-context.js`、`chat-intent-resolver.js` |
| 上下文不受超时／取消约束 | 判断入口共享总预算；可选记忆与目录有子预算，迟到结果不再触发模型或任务控制 | `chat-intent-budget.js`、`chat-auto-execution-handler.js` |
| 评测漏检 | 增加 handler 入口、禁止行为断言、工程边界／保留验证集、完整本地依赖摘要及运行前后的一致性检查 | `scripts/evaluate_chat_intents.js`、`scripts/lib/chat_intent_*.js` |

## 执行链补齐

- 业务范围字段贯穿任务交接、续接控制消息、契约规范化和工作状态；PostgreSQL 测试验证本月口径替换本周后，不再在运行约束中保留旧口径。
- 原任务已经排除的知识库、联网和来源范围继续传到新决定；后续规范化或已完成任务的修订不能重新开放这些来源。
- 模型的 `removedCapabilities` 不得误删续接任务原有的数据查询能力；用户明确禁止数据库查询时，通过 `excludeData` 硬范围在当前请求、任务续接、目录与实际执行中共同阻断。
- 内置知识检索只走 RAG，不因模型误填只读工具决策额外唤醒 MCP；用户显式指定可见知识工具时仍保留该工具路径。纯计划纠正也返回一致的路由字段。
- 裁剪过的原始请求进入任务后，目录过滤与实际工具策略要求先完整分页读取原文。缺页时，普通业务工具不能通过审批绕过这一要求；读取来源与渐进发现保持可用。
- 决策账本保存故障码、兼容模式、输入完整度和分阶段耗时。上下文、全局／端点排队、上游推理和总等待时间分别记录；没有向普通日志加入用户正文或凭据。

## 兼容性与边界

未增加依赖或数据库表。新字段放入现有 JSON 契约和元数据；旧任务没有这些字段时沿用原行为。权限、账号工具过滤、审批、任务所有权、取消与文件验收仍由原有执行体系复核。

Schema 兼容重试仅接受供应方明确拒绝 `response_format`／Schema 的 400、404、422；普通输入错误、认证失败、服务故障、超时和取消不会触发该重试。兼容结果继续严格验证业务必填字段。

旧约束中可以唯一识别的单一业务维度才自动替换；含安全限制或多个业务维度的复杂约束保守保留。模型应使用 `businessScope` 给出明确更新，不能借业务字段删除安全限制。

## 工程评测与验证

工程边界集 56 例、保留验证集 12 例，保留历史 v6 文件。两套新集合的摘要和数量记录在 `tests/fixtures/chat-intent-evaluation-manifest.json`；它们是合成工程集，未冒充经人工复核的业务金标。

模型评测分别运行 resolver 与 handler，后者以合成任务和替代依赖验证入口分支，不读写业务任务、不调用业务工具。报告保留每例的动作、问题、能力、约束、来源、验收、故障和耗时。超时、兼容失败与文本兜底仍计为失败，不能通过放宽评分隐藏。

真实模型复验命令：

```powershell
node scripts/evaluate_chat_intents.js --user-id 1 --model-id 18 --suite all --entry-point both --concurrency 2 --output output/chat-routing-upgrade-model-full.json
```

部署环境运行时应替换为有权账号与其可用模型。当前环境全局 AI 并发上限为 2，验证采用同等并发，不修改业务配置以提高测试分数。

## 工程检查结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 最终相关验收 | 331/331，通过 | `output/chat-routing-upgrade-acceptance-complete.log` |
| 续接合并加固复验 | 63/63，通过 | `output/chat-routing-upgrade-contract-final.log` |
| 浏览器 E2E | 1/1，通过；超时后文本回复、刷新恢复且不创建任务 | `output/chat-routing-upgrade-e2e.log` |
| 项目检查 | 通过 | `output/chat-routing-upgrade-check-release.log` |
| ESLint、TypeScript、测试位置、KaTeX 资源 | 通过 | 对应检查日志及命令输出 |
| 全仓首轮 | 2,854 项：2,847 通过、4 失败、3 跳过 | `output/chat-routing-upgrade-full-tests.log` |

全仓首轮中的两处路由测试旧夹具／预期已修正，之后包含它们的最终 331 项验收全部通过。必要的知识依据未命中时，测试明确要求返回缺少依据的说明，不再要求无依据生成组织事实。

另外两项失败涉及未改动的模块，在独立隔离测试中仍可复现：

- `document-orphan-cleanup.test.js` 的“数据库异常时保留文件”未得到预期拒绝。
- `memory-hnsw-concurrent.test.js` 未观察到预期创建的索引。

复验日志为 `output/chat-routing-upgrade-unrelated-recheck.log`。本次没有修改这些模块或跳过这两项测试，不能将全仓检查宣称为全部通过。

## 真实模型结果与限制

迭代期间对模型 18 的完整双入口评测共 136 次判断，106 次满足当时冻结的预设断言，30 次未通过。原始结果为 `output/chat-routing-upgrade-model-full.json`：

- 11 次意图超时、2 次无效响应契约、5 次提供器不可用；末段出现上游 HTTP 502 和既有熔断保护。
- 8 次涉及预期口径差异：4 次短附件文本报告走零模型直答，另 4 次因缺少待核实的事实／政策对象而提出具体业务问题。原始断言和失败记录均保留，没有在本轮结果中重新计分。
- 4 次暴露进一步的一致性问题：纯计划的路由字段、原查询能力误撤销，以及知识依据误填外部只读工具。已根据这些证据补齐修复与回归。
- 预设反向断言没有观察到禁止能力、陌生工具或任务控制越界；评测没有执行业务工具，这不能替代实际业务安全验收。

这份全量报告在迭代期间检测到实现摘要发生变化，`implementationSnapshotMatches=false`，按门禁判为未通过。因此它仅作为问题发现与历史运行记录，不能宣称为最终实现的全量准确率或发布通过证据。

后续 8 次与 10 次定向记录分别保存于 `output/chat-routing-upgrade-model-final.json` 和 `output/chat-routing-upgrade-model-release.json`；仍包含超时，且同样检测到迭代中的摘要变化，保留为过程证据。

最终代码固定后，对纯计划、续接改月口径、知识依据与工具分离三个场景分别经过双入口复验：**6 次判断中 5 次满足断言，1 次因上游响应超过 30 秒预算而降级**。结果为 `output/chat-routing-upgrade-model-complete.json`，`implementationSnapshotMatches=true`，没有无效契约或预设禁止行为失败。该定向样本仅覆盖最后修复的链路，不能替代最终代码的全量模型认证。

这次定向调用中，已完成模型调用的上游耗时约 18.3–25.7 秒，实测排队为 0–1 毫秒；入口级上下文使用合成依赖，不代表生产数据库读取耗时。没有通过增加 30 秒总预算或放宽失败评分使测试通过。

工程回归、真实模型理解、提供器可用性与端到端交付分别记录。当前配置模型仍有上游故障和超过 30 秒预算的响应，已采用受限文本降级，不能承诺所有真实请求完成自动执行。
