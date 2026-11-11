# 项目审查问题修复记录（2026-11-10）

对应 v0.7.149 源码审查发现的 F01—F11，修复源码版本为 v0.7.150。此记录区分源码修复、工程验证和生产验收，不改变既有发布制品或历史测试身份。

## 修复范围

| 问题 | 实现与行为 | 回归证据 |
| --- | --- | --- |
| F01 来源权限 | 通用产物详情、列表、版本、评论与分享复核当前所有者、任务知识来源及业务来源。受治理来源不通过匿名分享扩大权限；PPT 修订保留在原工作台。 | `presentation-analysis-report.test.js`、`generic-artifact-version-http.test.js` |
| F02 法规完整性与页码 | 复用文档底座的覆盖结果，缺页、失败页、超长正文与空文档明确拒绝；服务端提取证明绑定原文件摘要，客户端及预载字符串不能绕过。版本保存完整性和页跨度，条文定位支持跨页；超限判断先于归一化，连续空白改为线性扫描。 | `regulation-extraction-completeness.test.js`、`security-rag.test.js` |
| F03 每日额度 | 共享文本模型调用在上游请求前校验已用量并预留输入/输出预算，同账号模型的接纳串行化；完成或取消释放预留。结算期间的旧快照必须重读，用量批次从队列移出到落库之间不留下零值空窗，也不等待其他审计队列。语义分析和深度分析移除重复预留，初答、语义核验与修复共用此入口；明确输出值不再被模型默认值扩大。 | `model-text-quota.test.js`、`security-db-write-queue.test.js`、`semantic-analysis-concurrency.test.js`、`model-cancellation.test.js` |
| F04 会话撤销 | SSE 与渠道长连接绑定原始令牌和账号，退出、退出全部设备、密码/账号修改主动关闭；定期复核认证、角色/单位、令牌版本与过期时间，认证故障或超时保守断开。 | `realtime-session-http.test.js`、`realtime-session-revocation.test.js`、`realtime-replay.test.js` |
| F05 水位线 | 持续目标与工作流共用精确比较，保留大整数、小数和带时区/微秒时间值，任务创建及领取令牌边界保持。 | `automation-source-cursor.test.js`、`automation-triggers.test.js` |
| F06 文件漏扫 | 扩展名筛选先于有界批次，按稳定文件名游标续扫并回绕；游标只由持有当前领取令牌的执行者推进。目录与文件读取改为异步。 | `automation-source-cursor.test.js`、`automation-triggers.test.js` |
| F07 产物版本 | 通用编辑与回滚委托现有版本服务，在行锁内分配版本并同步 `current_version_id`；补齐旧式当前快照，支持预期版本冲突，避免首次修订重复版本 1。 | `generic-artifact-version-http.test.js` |
| F08 前端迟到响应 | 绑定账号、产物、打开周期和操作序列。关闭、退出和切换使旧结果失效，保存中的新输入保留；关闭释放预览内容与恢复焦点。 | `artifact-viewer-state.test.js`、`artifact-fixes.spec.js` |
| F09 错误日志 | 错误、超时日志和 MCP 失败摘要复用脱敏，支持编码参数名、大小写与重复项。 | `log-secret-redaction.test.js` |
| F10 深层审计脱敏 | 达到深度、节点或容器预算后返回安全占位，处理循环引用且不修改输入。 | `log-secret-redaction.test.js` |
| F11 分享链接 | 增加真实只读查看页，复用原渲染器与全局组件；详情响应禁用缓存，到期、删除、账号停用或来源撤回后拒绝读取。 | `generic-artifact-version-http.test.js`、`artifact-fixes.spec.js` |

## 同步实施的工程优化

- 产物查看器与渲染器按首次查看加载；首屏只保留轻量入口，复用 `loadScriptOnce` 并绑定当前账号。未以减少静态字节数推断实际响应时间收益。
- 水位线和文件扫描的公共契约补充 JSDoc 类型并纳入 `@ts-check`，只扩大当前改动的静态检查范围，不将全仓 JS 宣称为已经类型检查。
- Node 测试默认单库串行，拒绝以多 schema 代替 advisory lock 的数据库隔离；涉及持久化谱系与捕获保护的故障组，以及容量、千级目录和并发负载组使用独立 schema，避免状态和大量历史安全记录影响后续测试。
- `PIVOT_TEST_TMP_ROOT` 可指定绝对测试临时目录；全量和 BI 测试先核验磁盘容量，不降低生产接纳门槛。测试子进程统一临时目录，外部 PPT 配置不再从本机 `.env` 隐式继承。
- 测试默认使用 `development_process`；需要真实容器时显式配置 `PIVOT_TEST_ANALYSIS_RUNTIME=docker` 和已登记镜像。此模式只用于测试进程，不修改服务配置。
- CI 完整验证任务的有界预算调整为 90 分钟，以容纳单库串行与独立故障组；保留原测试、覆盖率阈值和其他发布门禁。
- BI 夹具清理删除自身数据集，清单回填按实际行数验证，保留“逐批覆盖全部已存在记录”的断言。
- 为原恢复屏障迁移后新增的 `agent_projects`、`presentation_native_documents` 和 `presentation_native_versions` 补齐语句级保护。迁移只处理明确表名，不自动修补未知缺口，也不开放被关闭的恢复状态。

未在本次进行全仓前端框架迁移、全量 TypeScript 改写或多节点扩容。普通同步文件日志的异步化需要先验证退出刷新与崩溃时丢失边界，本次保留既有行为。

## 数据兼容与升级

- `202611100002_regulation_extraction_coverage` 增加 `regulation_versions.extraction_coverage_json`，可重复执行。旧版本使用空对象表示提取完整性未知，不回填为已完成；历史资料需要重新导入才能取得新证明和准确页跨度。
- `202611100003_common_recovery_late_tables` 为明确新增表补恢复屏障，不更改恢复状态与权限校验。
- 旧产物在首次修订时补齐当前快照，历史内容保留；并发旧客户端也通过行锁分配唯一版本。新版查看器传 `expectedVersion`，冲突时保留输入。
- 原来包含受治理来源的匿名链接将被拒绝，需回到已授权业务工作台查看。
- 每日额度预留保持当前单活部署边界；这项工程回归不代表已完成多节点预算认证。

## 验证

本机为 Windows、Node v24.22.0。阶段回归首批 13 项、第二批 178 项、第三批 14 项、迁移与兼容专项 14 项通过，阶段间有重叠，不累加为独立案例数。桌面 1440px、手机 390px 的产物修订/只读分享和现有数据建模流程共 3 项浏览器测试通过，按需加载后的分享专项另有 2 项通过。

| 验证 | 实际结果 |
| --- | --- |
| 最终静态门禁 | v0.7.150 的 `npm run check`、`npm run lint`、`npm run typecheck` 均通过；中文 JSDoc 修正后，`node scripts/check_development_standards.js --changed` 通过。 |
| `npm test` 全量运行 | 3,352 项中通过 3,342、失败 1、跳过 9、取消 0。失败为新增法规长空白用例执行旧归一化正则时卡顿，核对进程身份后仅中断该测试子进程，其他用例继续完成；此记录不标为全量通过。 |
| 修复后定向回归 | 40 项全部通过，0 失败、0 跳过。包含法规完整专项、真实计量/队列刷新竞争、额度结算、101 文件真实轮询，以及按最终策略独立隔离的容量、目录和负载组。 |
| 连续空白时间边界 | 独立子进程十秒上限的回归通过，避免未来再次由回溯正则卡住整个测试或主服务。 |
| 整库恢复 | 本机独立 PostgreSQL 集群的 2 项恢复用例均通过，覆盖源数据丢失后的恢复、当前授权重放、登录、旧令牌拒绝和 CSV/XLSX 读取复核。夹具为 12 个共享文件；结果明确 `productionCertified=false`。 |
| 依赖审计 | 现有 `npm run audit:policy` 通过，未新增或升级依赖。 |

全量中的并发负载用例虽然通过，但在共享测试历史下耗时约 244 秒；最终独立 schema 复验约 17 秒，20/20 请求被接纳且数值、双槽和每人一槽约束保持。这是测试环境隔离的证据，不是生产性能提升结论。

完整日志和逐组汇总保存在本机 `output/fix-validation-20261110/`，包括 `npm-test.log`、`full-summary.json`、`final-targeted.log`、`targeted-summary.json`、`quota-settlement-final.log` 及浏览器日志。旧正则中断与后续通过结果分别保留。源码版本同步后的最终静态门禁和桌面/手机分享入口均已核对通过；未重新运行整套 Node 回归，因此不将本次全量运行改记为通过。

未执行真实生产模型、外部 OCR、GPU、Office 兼容矩阵及目标生产容量认证。整库恢复只按实际隔离测试结果报告，不能用源码修复代替生产演练。
