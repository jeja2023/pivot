# Laya 内网业务决策服务部署与验收

本文件定义 Laya 作为 Pivot `DecisionProvider` 的内网部署、制品导入和上线验收流程。它不替代 Laya 自带的模型检查点 Router；Pivot 只使用该服务在已授权业务动作中给出分数。

## 制品与网络边界

1. 在可联网的受控构建环境固定 Laya 源码版本、Python/运行时依赖、容器镜像摘要及模型权重 SHA-256。
2. 审核后将镜像和权重导入内网制品库；生产宿主机只从本地镜像和只读模型目录启动，禁止首次调用下载模型。
3. 通过 `docker compose -f docker-compose.yml -f docker-compose.laya.yml up -d laya-decision` 启动。GPU 仅在共卡压测合格后额外叠加 `docker-compose.laya.gpu.yml`。
4. Pivot 到 Laya 使用内网地址，例如 `http://laya-decision:8080/decision`；不得暴露到公网。

启动命令由经审核的镜像提供，通过 `PIVOT_LAYA_COMMAND` 明确指定。镜像必须提供：

- `POST /decision`：接收 Pivot 脱敏决策契约，返回 `selectedActionId`、`scores`、`modelVersion`；
- `GET /healthz`：返回 HTTP 200 及 `modelVersion`；
- 本地模型路径由 `LAYA_MODEL_PATH` 提供，服务启动时必须校验可读。

## Pivot 配置

先只开启影子比较：

~~~dotenv
PIVOT_DECISION_PROVIDER_MODE=shadow
PIVOT_LAYA_DECISION_ENABLED=true
PIVOT_LAYA_DECISION_URL=http://laya-decision:8080/decision
PIVOT_LAYA_DECISION_HEALTH_URL=http://laya-decision:8080/healthz
PIVOT_LAYA_DECISION_VERSION=<权重SHA或审核版本>
PIVOT_LAYA_DECISION_TIMEOUT_MS=1200
PIVOT_LAYA_DECISION_MAX_CONCURRENT=4
# 默认不发送路由原文；需数据治理审批后才可改为 true
PIVOT_DECISION_INCLUDE_REDACTED_ROUTING_TEXT=false
~~~

健康检查会出现在系统健康快照的 `decisionProviders` 项中。Laya 超时、不可用、版本不一致或并发已满时，Pivot 记录原因并维持现有路由。

如经数据治理审批需要让 Laya 理解自然语言，可设置 `PIVOT_DECISION_INCLUDE_REDACTED_ROUTING_TEXT=true`。服务仅收到有限长度、规则脱敏后的路由文本；邮箱、电话、证件号、令牌、IP、路径和长数字会替换为占位符。该字段不会写入决策日志、模型制品或训练导出。

## 接口契约

请求只含脱敏状态和当轮允许候选：

~~~json
{
  "contractVersion": 1,
  "scenario": "chat.rag",
  "language": "zh",
  "requestState": { "taskHash": "sha256…", "evidenceNeeds": ["knowledge_base"] },
  "candidates": [{ "id": "retrieve", "description": "检索已授权知识库", "allowed": true }]
}
~~~

响应必须只引用候选中的动作：

~~~json
{
  "selectedActionId": "retrieve",
  "scores": { "retrieve": 0.91, "skip": 0.09 },
  "modelVersion": "<审核版本>"
}
~~~

## 必过验收

- [ ] 模型、镜像、启动命令与权重 SHA-256 已登记到 `decision_model_artifacts`：Laya 候选制品的 `evaluationReport.deploymentEvidence` 必须包含 `imageDigest`、`modelSha256`、`dependencyLockSha256` 和 `launchCommandDigest`（均为 `sha256:<64位十六进制>`）；缺任一项不能激活。
- [ ] `/healthz` 返回的版本等于 `PIVOT_LAYA_DECISION_VERSION`。
- [ ] 使用同一冻结评测集对现有路由、轻量模型、Laya 和 Qwen 结构化决策进行影子比较。
- [ ] 记录与 Qwen3.6-35B 共 GPU 时的显存峰值、Qwen 吞吐、端到端 p50/p95、Laya 超时率；任一退化超出 SLA 即改用独立 GPU、CPU 或降低并发。
- [ ] 人工执行 Laya 超时、HTTP 500、健康版本不一致和并发满载故障演练，确认路由回退。
- [ ] 仅在独立时间切分测试集、校准集和关键场景门槛均通过后，才允许将已激活制品加入 active 灰度。

## 领域训练数据导出

Laya 的领域训练只使用已核验、账号仍有效、单租户范围内的脱敏决策数据。导出命令会按时间顺序写入 train.jsonl、calibration.jsonl、test.jsonl 和数据版本清单，绝不导出用户问题正文：

~~~powershell
npm run export:laya-decision-dataset -- --tenant-id 12 --output-dir artifacts/laya-decision-tenant-12
~~~

导出目录必须属于受控内网训练工作区，且不得上传到外网。训练后的权重、校准结果、权重 SHA-256 与独立测试报告仍需登记为候选制品；未经激活的候选不能影响 active 流量。

## GPU 与吞吐验收采样

在目标 GPU 主机使用相同冻结集执行提供器基准时，可由资源包装器同时采样 GPU 显存和利用率：

~~~powershell
npm run benchmark:decision-resources -- --require-gpu --reviewed-set-version v2 --providers laya,qwen --laya-url http://laya-decision:8080/decision --qwen-user-id 12 --qwen-model Qwen3.6-35B --report artifacts/laya-qwen-resource-impact.json
~~~

报告包含每张 GPU 的采样峰值、每个提供器的准确率、P50/P95 和错误率。它是共卡/独立 GPU/CPU 选择的实测证据之一；仍需同时记录 Qwen 正常生成吞吐与业务服务等级结果。

## 灰度与回滚

`PIVOT_DECISION_PROVIDER_MODE=active` 仍不会直接放量：必须同时把 `PIVOT_DECISION_ROLLOUT_PERCENT` 设为大于零，并可用租户和场景白名单限制范围。学习型提供器在 active 模式还必须存在已激活、通过评测的模型制品。

紧急回滚只需把 `PIVOT_DECISION_ROLLOUT_PERCENT=0` 或 `PIVOT_DECISION_PROVIDER_MODE=shadow`，无需删除权重或修改权限策略。管理员也可通过决策模型制品回滚接口退役 active 制品。
