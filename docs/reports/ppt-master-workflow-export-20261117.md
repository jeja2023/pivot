# PPT Master 与工作流结果下载验证记录

日期：2026-11-17。功能验证时源码为 v0.7.166，后续归档于[v0.7.167发布说明](../releases/v0.7.167-PPT制作确认与工作流结果下载.md)。源码升版不改变原测试身份，也不代表生产发布。

## 实际验证

| 范围 | 结果 | 入口 |
| --- | --- | --- |
| PPT Master 制作、确认和预算 | 29 项通过；包含用户实际答复、空方案确认、失败重试、执行器交接、100 万默认预算、旧预算保留、桌面及窄屏布局。 | `node scripts/run_node_tests.js tests/presentation-master.test.js tests/presentation-master-postgres.test.js tests/presentation-master-browser.test.js tests/presentation-master-context.test.js` |
| 工作流下载与权限 | 10 项通过；包含 CSV 公式防护、Excel 值类型、完整输出、上游截断、格式和大小边界、HTTP 登录及账号隔离。 | `node scripts/run_node_tests.js tests/agent-run-evidence-routes-http.test.js tests/workflow-result-export.test.js tests/workflow-product-client-state.test.js` |
| 工作流页面下载 | 1 项浏览器用例通过，实际下载并读取 CSV 和 Excel，检查未登录与非法格式请求。 | `node scripts/run_e2e_tests.js tests/e2e/workflow-product.spec.js --grep "就地测试与发布运行"` |

专项批次有重叠，不合并为唯一通过数。PostgreSQL 使用隔离测试 schema；PPT 浏览器测试使用受控任务响应，不代表真实模型或外部服务制作验收。功能阶段 `npm run check`、`npm run typecheck` 和改动文件 ESLint 通过。

## 未检查范围

未运行完整 `npm test`，未接入真实 PPT Master 服务和生产模型完成制作，未对生产数据权限、超大导出负载或多实例环境进行验收；本次未构建或部署 v0.7.167 镜像及安装包。
