# 智能路由超时修复与部署记录

日期：2026-11-16。状态：本地实现及专项测试完成，未部署生产。

功能验证源码基线为v0.7.164，后续归档于[v0.7.165发布说明](../releases/v0.7.165-智能路由与助手HTTP下载体验优化.md)。源码启用新版本不表示以下功能批次被重新执行或生产瓶颈已被确认。

## 已知情况与证据边界

用户反馈生产环境频繁出现路由判断超时，截图文字无法可靠读取，暂不能提供原始日志。本次未访问生产服务、生产模型或生产数据库，不能将具体生产请求归因于排队、推理速度或某次数据库等待。

代码确认：统一意图判断默认总时限为30秒，包含上下文、模型排队和上游调用；其后可选经验读取也使用剩余预算。原实现允许可选阶段一直等到总截止，使已经验证的语义结果转为超时。路由用量记录还会等待非计费的供应方校准审计。原监控明细仅展示总耗时，缺少排队与上游阶段信息。

## 修改

- 可选上下文、经验读取及专用模型查询预留100毫秒收尾时间；剩余预算不足时直接跳过。总截止、用户取消及迟到结果隔离保持有效，不因超时扩大工具或任务权限。
- 路由的令牌用量仍先进入统一计量队列，再释放额度预留；非计费校准审计异步完成，不占路由等待。带运行预算的 Agent 调用仍等待完整计量和预算核验。
- 新增 `PIVOT_CHAT_INTENT_MODEL_ID`，默认 `0` 使用当前对话模型。可配置当前账号有权访问的专用低延迟模型；无权、凭据不可用、查询超时或输入窗口不足时沿用当前模型，不裁剪授权上下文来迁就窗口。真实调用继续使用全局及端点并发控制、SSRF防护和日额度接纳，按实际路由模型记账；回答和任务执行模型不变。
- 记录当前排队、上游响应、额度接纳、记账等阶段；外层超时保留正在进行的数值诊断。决策审计与错误明细仅接收白名单阶段和耗时，不保存提示词、工具正文或凭据。
- 系统监控的“24小时决策错误明细”展示已记录的阶段、模型排队和上游耗时；历史缺失信息保持缺失。路由前上下文及外层截止的诊断也保留在结构化服务日志中。
- 意图策略版本更新为 `chat-intent-v8`。无数据库迁移或新增第三方依赖。

## 生产配置与生效方法

在生产部署目录的 `.env` 中，将 `PIVOT_CHAT_INTENT_MODEL_ID` 从 `0` 改为实际低延迟模型的 ID；模型需在“模型管理”配置为使用者可见，凭据与上下文窗口满足完整路由输入。不要填写模型名称或其他账号私有模型的 ID。未配置时行为兼容旧环境。

`PIVOT_CHAT_INTENT_TIMEOUT_MS` 默认仍为 `30000`，范围 `1000`–`120000`。没有专用低延迟模型且现有模型确需更多时间时，可按目标环境实测临时设为 `60000`；这会延长失败等待，不会提高模型吞吐，也不能代替排队和上游阶段诊断。

更新主应用镜像及环境文件后，执行：

```bash
docker compose up -d --force-recreate pivot
```

刷新页面以加载新的监控脚本。仅重启旧容器不会重新导入 `.env`。对新请求查看 `intentModelId`、`routingModelSource`、`failureStage`、`timing.queueMs`、`timing.providerMs` 和上下文阶段；不要用历史缺失字段判断此次优化效果。

## 实际验证

最终批次经项目 PostgreSQL 隔离测试入口运行，293项通过，0失败：

```powershell
node scripts/run_node_tests.js tests/chat-intent-latency.test.js tests/chat-intent-recovery.test.js tests/chat-intent-fallback.test.js tests/chat-routing-upgrade.test.js tests/decision-failure-details.test.js tests/monitor-dashboard.test.js tests/chat-capability-intent-http.test.js tests/chat-intent-understanding.test.js tests/chat-source-scope.test.js tests/security-chat.test.js tests/security-model-runtime.test.js tests/provider-usage-calibration.test.js tests/model-text-quota.test.js tests/decision-learning.test.js
```

包含可选经验读取卡住后保留有效结果、接近截止跳过可选阶段、真实超时的阶段快照、迟到结果不能触发执行、专用模型选择与回退、额度预留在记账后释放、校准延迟不阻塞路由、PostgreSQL诊断字段持久化白名单、监控显示及已有聊天、SVG、模型额度与熔断回归。

测试中的模型和故障使用模拟实现，证明控制流程、额度及诊断边界，不等同于生产P95改善或真实模型质量验收。既有测试装置清理期间存在部分异步决策审计外键告警；本次最终批次无测试失败，未修改该生命周期。

## 未检查范围

未运行全仓测试、真实生产模型延迟/质量对照或生产负载测试。专用模型只有配置并部署后才生效，是否改善主要等待须依据新记录核实。默认总时限和全局、端点并发限制没有提高。
