# 技能功能七项审查问题修复记录

日期：2026-11-17。源码基线：v0.7.167 / `d1afc6a5`。本次修改源码、回归测试和使用说明，没有构建或部署新制品，没有数据库迁移和新增第三方依赖。

## 修复范围

| 问题 | 最终行为与兼容处理 | 回归证据 |
| --- | --- | --- |
| F1：个人 ACL 绕过共享签名 | 个人发布不再接受扩大受众的允许授权；历史允许记录也不能放行非所有者。本人权限、显式拒绝及同租户管理员治理保留。跨用户使用仍须走共享批准签名。 | `agent-skill-audit-fixes.test.js` 覆盖真实 HTTP 写入、四类主体、三种动作、历史记录、目录、执行上下文和资源读取。 |
| F2：单租户默认组织不一致 | 发布与权限主体复用租户解析。没有团队关系的真实单租户账号可以正常共享和治理；企业模式无组织、其它租户和无效账号仍被拒绝。 | `agent-skill-audit-fixes.test.js` 使用未注入 tenant_id 的普通账号及管理员，完成签名、组织发布、消费和撤权。 |
| F3：异常 tags 阻断任务创建 | 新清单要求 tags 为最多100项的非空文本数组，单项最多100字符；自动匹配跳过历史异常清单，保留其治理修订入口。 | `agent-skill-audit-fixes.test.js` 覆盖标量、对象、空值、非法元素、大小边界和历史坏数据与正常候选并存。 |
| F4：资源技能编辑丢失配套资料 | 治理保存携带来源版本ID和摘要，服务端核对编辑权限、来源状态、资源完整性和现有签名，再生成独立新版本；保留 source_run_id，不继承验证或签名。纯指引签名包继续支持修订。 | `agent-skill-revisions.test.js` 覆盖文本和图片资源、真实HTTP保存、旧版本不变、新版本发布读取、跨用户拒绝、撤权、来源删除、签名吊销、文件篡改及纯指引包兼容。 |
| F5：自定义技能目录被备份遗漏 | 导入、读取、离线备份和共同恢复目录复用存储路径解析。显式配置的技能目录不存在时，备份失败；恢复准备的 allowMissing 仍可接纳待恢复目录。测试执行器和恢复演练显式隔离技能目录。 | `offline-integration.test.js` 实际生成备份、核对清单、复制恢复并用技能资源读取器验证内容；覆盖共同恢复目录及显式缺失路径。 |
| F6：停用或治理定位错误发布 | 行操作携带准确的 releaseId；相同版本对应多次发布时，治理也按发布ID定位。旧名称停用接口仅暂停当前实际命中的发布。暂停后其它有效发布按原灰度规则回退。 | `agent-skill-audit-fixes.test.js` 覆盖新版本未命中、旧版本仍生效；`skill-import.spec.js` 覆盖同版本多发布的治理、修订、发布、精确暂停及回退选择。 |
| F7：熔断遗漏200条之外的发布 | 按不可变主键进行有界批次分页；暂停/回滚不影响后续页定位，巡检期间新记录留给下一轮。单条指标或处置失败不阻断其它记录。 | `agent-skill-audit-fixes.test.js` 创建202条发布，在首尾各放置超阈值样本，确认首批状态变化后仍处置最后一页。 |

主要实现位于 `server/services/agent-skill-access.js`、`agent-skills.js`、`agent-skill-revisions.js`、`agent-skill-storage.js`、`agent-skill-breaker.js`、`offline-backup-bundle.js`、`common-recovery-files.js`，界面接线位于 `client/chat/agent-harness.js` 和 `agent-skill-management.js`。同步更新开发设计源、使用帮助、环境变量说明及 SQL 审核记录。

## 实际验证

- 首批缺陷与备份专项：15项通过、0失败。
- 扩大到26个相关测试文件的回归批次：199项通过、0失败、0跳过。包含全部技能专项、任务与交付权限、PostgreSQL集成、运行策略、备份文件及巡检器停止行为。
- 最后补充纯指引签名包兼容、资源签名吊销及共同恢复目录检查后，重新执行 `agent-skill-audit-fixes.test.js`、`agent-skill-revisions.test.js`、`offline-integration.test.js`：16项通过、0失败、0跳过。与上一批存在重叠，不累加为独立测试总数。
- Playwright `tests/e2e/skill-import.spec.js`：4项通过。强化同一版本多次发布的治理定位后，资源治理流程再次单独复验：1项通过。覆盖1280px及390px视口、资源修订、验证发布、精确暂停和回退选择。
- `npm run check`、`npm run lint`、`npm run typecheck`、`npm run check:test-locations`、文本完整性、增量开发规范、SQL审核及 `git diff --check` 通过。
- 数据库专项使用项目入口创建并清理隔离 schema，单库串行执行。文件恢复测试使用临时技能包和模拟数据库转储，没有操作生产备份或实际业务数据。

本地详细日志位于 `.tmp/skill-fix-regression.log`、`.tmp/skill-fix-final-targeted.log`、`.tmp/skill-fix-e2e.log`、`.tmp/skill-fix-final-e2e.log`、`.tmp/skill-fix-final-check.log` 和 `.tmp/skill-fix-final-lint.log`；它们为本次工作区验证记录，不作为发布制品。

## 使用与部署边界

1. 历史个人共享 ACL 保留用于审计，但不能继续扩大个人技能受众；需要共享的技能应由管理员正式批准发布。没有自动删除历史权限记录或改写旧运行。
2. 资源治理修订适用于平台支持的静态文本/图片配方，以及只含指引的包。带完整依赖或其它包内文件的技能需要重新导入完整包，不能把缺失文件的正文编辑宣称为完整升级。
3. 使用自定义 `AGENT_SKILL_ROOT` 的部署须保留对应持久目录和挂载；此前遗漏该目录的旧备份不会被此次源码修复自动补全。
4. 未运行全仓 `npm test` / `npm run verify`、完整物理数据库恢复演练、多实例负载或生产模型验收，未构建安装包/镜像或部署生产。已验证的是上述源码路径和受控回归范围。
