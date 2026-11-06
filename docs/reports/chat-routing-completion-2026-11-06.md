# 智能路由剩余优化与全仓失败修复

关联软件版本：[v0.7.108](../releases/v0.7.108-智能路由判断与任务续接可靠性升级.md)。以下回归证据对应本次功能实现；版号与发布文档整理后另行进行版本一致性及项目检查，真实模型验收继续按用户要求暂停。

版本整理后的项目检查已通过，日志为 `output/v0.7.108-documentation-check.log`；包信息、锁文件、README、设计基线和运行时均已同步至 v0.7.108。该步骤没有恢复真实模型实测，也不改写下文的历史评测结果。

日期：2026-11-06。承接 [前次升级记录](chat-routing-upgrade-2026-11-06.md)，本次语义策略升级为 `chat-intent-v6`。

## 本次实现

### 文档孤儿清理失败

真实 PostgreSQL 复现确认：隔离 Schema 中 `document_exports` 被临时改名后，未限定 Schema 的查询会通过 `search_path` 回退到 `public.document_exports`。错误的空引用结果曾导致文件被删除。

修复为在原事务中取得数据库转义后的当前 Schema，并限定任务、导出及全部引用表。当前范围缺表就失败，不再回退同名表。清理游标仅在整批成功处理后推进；引用查询失败后的下一次调用会重试本批，不跳过刚才未能确认的文件。任务锁、行锁、文件身份复核、路径和保留期边界继续生效。

对应文件：`server/repositories/document-orphan-references.js`、`server/services/document-processing/orphan-cleanup.js`。SQL 范围复核已记录到 `scripts/raw_sql_review.json`。

### 记忆 HNSW 无效索引修复失败

真实复现返回 `invalid_index_requires_admin`：合法索引所有者因为没有 `pg_read_all_stats` 成员资格，被误判为不能修复自己的无效索引。

修复支持所有者在持有原有 advisory lock 的前提下修复自己的无效索引；同时利用可见的关系锁和索引构建进度，拒绝删除其它会话正在使用／构建的索引。索引名称指向其它表时返回冲突，缺少所有权且不能检查构建者时继续保守拒绝。连接上的 statement_timeout 始终恢复；恢复失败的连接仍按原有错误释放规则处理。

对应文件：`server/services/long-term-memory/memory-vector-index.js`。补充真实并发修复、正在使用、跨表冲突、权限不足和超时恢复回归。

### 路由延迟与暂时性服务故障

- 严格输出改为 `decision` 包装下的五种动作分支。直答不再生成续接、交付与澄清的空字段，任务分支固定 `tools=task`，直答分支不接受写入和执行能力；服务端仍校验所有业务字段并兼容旧的平铺 JSON。
- 精简提示词并保留约束、来源、上下文指代、权限、资料完整度与文件验收规则。模型返回的原动作、规范化修复、Token 用量和重试次数保留为诊断字段。
- 对唯一活动任务的明确“继续”直接续接已知任务；不新建运行、不放宽已有范围。目标歧义、暂停等待输入、新主题、影子模式和执行开关关闭继续走原有语义／控制边界。
- 唯一任务的明确时间口径／摘要字段更新直接写入原契约，支持旧任务只保留 `active=true` 的元数据；暂停等待业务输入时只接受这些明确字段更新，普通“继续”仍不能自动补齐缺失事实。夹带删除、发送或新主题不走该路径。
- 独立纯文本草稿在没有历史、来源、内部事实、实时数据、文件交付及外部动作时直接进入写作；回答上下文明确要求未知名称和数值使用占位符，不反复索取可替代信息。上下文或动作要求不满足边界时继续语义判断。
- 明确请求可下载文件、已申请文档渲染能力但模型误填直答时，修复相互矛盾的动作。多步任务只有在当前话语已经明确委托、无可混淆的活动任务、且全部执行能力都被规则基线的必要能力集合覆盖时才修复；模型不能自行加入桌面控制等能力。讨论、仅规划和文件请求夹带不相关代码执行的结果不能通过该规则获得执行授权。
- 对 408／429／500／502／503／504 和少数连接瞬时错误，在原总预算内最多重试一次，并遵守可容纳的 `Retry-After`。认证、输入错误、熔断、取消和已耗尽预算不重试；结构化输出兼容调用与瞬时重试共享次数限制。
- 模型路由不再申请 `artifact.deliver`：可下载产物由 `document.render` 等渲染能力生成，本机写入交付仍由用户点击触发。

这些变更不修改账号密钥、模型端点、原有 30 秒默认总预算或生产并发设置。外部供应方故障不能通过本地代码保证永久消除；路由必须在故障时保持可取消、受限回复和不执行未确认动作。

## 冻结评测口径

新建工程边界集 `tests/fixtures/chat-intent-cases.v8.json`（56 例）与保留验证集 `tests/fixtures/chat-intent-holdout-cases.v2.json`（12 例）；历史文件及结果保留。

`chat-intent-evaluation-manifest.v2.json` 逐项记载了五处口径复核：

1. 两个短附件文本报告未要求下载或保存，按现有产品契约直接回答。
2. 两个英文来源限制用例缺少要核实的事实／政策对象，应提出业务澄清；额外检查澄清问题必须指向缺失对象。
3. 可下载报告要求查询和渲染能力，不要求高风险本机交付写入能力。

这属于代码与产品契约复核，`humanReviewed=false`，不冒充人工业务金标。评分器继续将超时、契约失败、提供器故障、影子输出和安全兜底计为失败。语义有效样本表现与整体可用性分别统计，不能把故障样本排除后宣称总体通过。

评测开始前校验集合摘要；逐例原子保存 `complete=false` 的进度；结束后重新计算实现摘要，只有 `complete=true` 且起止摘要一致才是完整固定版本记录。

## 验证记录

执行中的最终检查：

```powershell
npm test
node scripts/run_e2e_tests.js tests/e2e/chat-intent-fallback.spec.js
node scripts/evaluate_chat_intents.js --user-id 1 --model-id 18 --suite all --entry-point both --concurrency 1 --output output/chat-routing-v6-acceptance-full.json
```

代码冻结前，41 项协议／范围与两项失败相关回归全部通过；进一步补齐重试、明确续接与评测冻结检查后，48 项定向回归通过。稳定协议抽查 6/6，通过，P50 约 9 秒、P95 约 17 秒；这只是小样本，最终结果以完整冻结报告为准。随后全量评测发现直答与多步执行能力相互矛盾，已补齐分支能力限制、确定授权内的动作一致性与外部目录不含内置工具的说明；相关 78 项回归通过。首次未完成的固定运行保留在 `output/chat-routing-v6-full-attempt1.json`，不计作完整验收。

最终全仓和浏览器结果在完成后补充，不以过程中检查代替最终验收。真实模型实测已按用户后续要求停止，不能将中断的记录视为全量通过。

迭代中的未完成模型运行分别保留为 `chat-routing-v6-full-attempt1.json`、`chat-routing-v6-full-attempt2.json`、`chat-routing-v6-full-attempt3.json`，用于证明修复来源，不计入最终模型通过率。最终报告单独使用 `chat-routing-v6-acceptance-full.json`，实现固定后才开始；后续不覆写旧样本来隐藏错误。

全仓 `npm test` 首轮已完成：2,865 项测试中 2,862 项通过、3 项按原配置跳过，失败为 0；日志为 `output/chat-routing-v6-npm-test.log`。由于路由一致性规则在该轮早期仍有补充，另启动最终代码复跑，结果另列。浏览器超时降级与刷新恢复 E2E 通过 1/1（`output/chat-routing-v6-e2e.log`）。

复跑中一项既有导图浏览器用例遇到导出菜单被属性面板拦截的点击超时；独立复验通过 1/1（`output/chat-routing-v6-mindmap-recheck.log`）。没有增大超时或跳过该用例，最终全仓再次验证；中间失败日志保留为 `output/chat-routing-v6-npm-test-final.log`。

### 最终工程验收

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| 最终代码 `npm test` | 2,869 项：2,866 通过、0 失败、3 项原配置跳过 | `output/chat-routing-v6-npm-test-acceptance.log` |
| 项目门禁、ESLint、TypeScript、测试位置、KaTeX | 均通过，包含在完整 `npm test` 中 | 同上 |
| 浏览器超时降级、刷新恢复和不新建任务 | 1/1，通过；使用模拟模型 | `output/chat-routing-v6-e2e-final.log` |
| 路由续接与安全边界定向回归 | 85/85，通过 | `output/chat-routing-v6-continuation-final.log` |
| 纯文本草稿回答上下文及最后边界回归 | 70/70，通过 | `output/chat-routing-v6-final-boundaries.log` |
| 原文档清理与 HNSW 失败 | 均已修复，并在最终全仓回归继续通过 | 同上全仓日志 |
| 最终全量真实模型验收 | 按用户要求停止，未完成 | `output/chat-routing-v6-acceptance-full.json` |

最终工程交付已完成，不将暂停的模型效果验证算作通过。先前导图流程的偶发超时已在最终全仓回归重新通过，原失败记录继续保留。

## 真实模型验证的停止边界

用户在实测进行中明确要求“暂时不要模型实测，这个模型可能不稳定”。已停止当前真实模型调用进程，随后不再对已配置的实际模型发起测试。全仓回归使用隔离数据库与模拟提供器，继续验证代码行为。

停止时 `output/chat-routing-v6-acceptance-full.json` 已保存 52/136 次判断：47 次满足冻结断言，3 次上游超时，2 次报告请求选择直答而非预期任务。该记录明确标记 `status=stopped_by_user`、`complete=false`，不构成最终全量准确率、稳定性或发布通过证明。未通过记录没有删改为通过。

额外做过 2 个公开合成场景的 `reasoning_effort=none` 参数对照（`output/chat-routing-reasoning-none-probe.json`）。未观察到稳定的延迟和语义收益，因此没有将该参数应用到生产路由。该实验同样不替代独立模型评测。

当前配置的两个备用模型分别返回账号不可用和密钥错误（模型 195、21 的合成检查日志保留）。本次没有修改任何模型密钥或端点，外部模型服务质量不属于已经验证通过的工程交付。

## 官方协议参照

严格结构化输出采用根对象、嵌套 `anyOf`、全部分支字段必填和 `additionalProperties=false`，与 [OpenAI Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs) 的支持范围一致。该结构约束提高协议一致性，不保证模型语义判断必然正确。
