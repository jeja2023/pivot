# 技能安全与发布一致性修复记录

日期：2026-11-17。功能验证时源码版本为 v0.7.165，后续归档于[v0.7.166发布说明](../releases/v0.7.166-技能签名撤权与发布一致性修复.md)。本记录保留原测试批次身份，不把升版视为重新执行测试或生产发布。

## 修复与证据

| 范围 | 修复 | 验证入口 |
| --- | --- | --- |
| 正文与资源签名 | 受信包要求分离签名；组织签名绑定清单、指引及配套包摘要。旧清单签名的共享技能需重新批准。 | `tests/agent-skill-security-regressions.test.js`、`tests/agent-skill-packages.test.js`、`tests/agent-skill-signing-configuration.test.js` |
| 撤权与来源 | 任务绑定发布并在执行和读取边界检查当前授权、来源、签名和正文；资源读取另校验包摘要。 | `tests/agent-skill-security-regressions.test.js`、`tests/agent-skill-resource-import.test.js`、`tests/agent-skill-resources.test.js` |
| 权限与验证 | ACL 变更事务化，验证与创建接口不接受调用方指定内部目录、隔离策略或公钥。 | `tests/agent-skill-release-consistency.test.js`、`tests/agent-skill-discovery-integration.test.js` |
| 选择、治理与灰度 | 选择使用发布引用，治理使用版本 ID；列表显示实际命中版本，状态变更和投影事务同步。 | `tests/agent-skill-release-consistency.test.js`、`tests/e2e/skill-import.spec.js` |

## 实际运行

- 技能、签名、资源、发现、治理及相关回归：63 项通过，0 失败。
- 技能与任务资料边界补充回归：29 项通过，0 失败；与上一批有重叠，不合并计数。
- Playwright `tests/e2e/skill-import.spec.js` 中“技能文件可预览并经原有验证和个人发布流程添加”：1 项通过，覆盖导入、选择发布引用和打开治理弹窗。
- `npm run check`、`npm run lint`、`npm run typecheck`、`npm run check:test-locations` 及 `git diff --check` 通过。PostgreSQL 测试使用本地隔离 schema；浏览器测试使用隔离服务。

未运行完整 `npm test`、生产部署或目标环境验收；未构建 v0.7.166 镜像和安装包，也未验证生产模型、真实数据和多实例负载。兼容性与升级操作以发布说明为准。
