# PPT 模板、监控明细与数据分析布局修复记录

日期：2026-11-13。功能开发和本记录列出的功能测试在源码 v0.7.158 下执行，随后归档于[v0.7.159发布说明](../releases/v0.7.159-PPT模板校验监控明细与数据分析布局优化.md)。升版不重标历史测试身份，不表示已生成新镜像或生产发布。

## 定位与实现

| 问题与触发条件 | 修改及边界 |
| --- | --- |
| 独立PPT服务使用 `/data/jobs/<任务标识>/workspace`，模板适配器只接受 `/workspace`，所有内置模板在制作模型调用前被拒绝 | `docker/ppt-master/runner.py` 向工具子进程显式传递 `PIVOT_MASTER_WORKSPACE`，`template_adapter.py` 以该任务目录检查解析后的真实路径；未设置时保留原 `/workspace` 默认值，不扩大到公共目录，继续调用固定上游校验器 |
| PPT服务卡片仅凭当前浏览器的测试成功结果显示绿色，其他管理员读到同一配置仍显示橙色 | `client/chat/ppt-master-settings.js` 根据全站配置的启用、完整及读取状态决定默认颜色，本次连接测试失败仍提示异常；权限与地址脱敏沿用服务端规则 |
| 决策错误和核验失败明细没有用户，通用“发生时间”容易被理解为任务发起时间 | `server/services/decision-failure-details.js` 在分页后关联用户；任务明细优先取任务所属账号，任务不存在时回退关联决策账号。单独返回任务 `created_at`，保留失败事件 `occurred_at`；客户端显示昵称/账号、任务发起时间、失败记录时间，决策错误显示决策记录时间；未知信息明确缺失，用户名转义后渲染，管理接口鉴权不变 |
| 来源类型被插在图表、查询、透视页首，继承通用工具栏靠右排版，产生空白和错位 | `modeling-sources.js` 将控件挂到数据集选择字段之前，复用表单参数区。模型搜索、分页、筛选和跳转消费者同步使用新容器；图表可换行、透视按六列排版，窄屏自然换行 |
| 数据查询的数据集字段随剩余空间增长至整行 | `data-analysis-results.css` 将其外层设为不增长的334px布局宽度，选择框在桌面约240px，窄屏保留收缩，旁边来源类型及查询模式保持可用 |

监控与应用样式修改后通过项目脚本重新生成 `client/chat/chat.workspace.settings.css` 和 `client/chat/chat.workspace.apps.css`，不直接维护压缩输出内容。

## 模板验证

实际使用本机Docker的 `python:3.12-bookworm` 测试容器，禁用网络，挂载 `artifacts/ppt-master-runtime` 固定上游发行包、当前适配代码、测试源码及已有PyYAML，在独立 `/data` 临时目录运行：

```text
python -B -m unittest discover -s /source/tests/ppt_service -p test_template_adapter.py -v
```

共4项测试通过。模板目录测试逐项校验14个内置style模板，另覆盖源包交付、损坏模板拒绝和跨任务/符号链接拒绝。对照运行旧版适配器时，14个模板均因工作区边界被拒绝，合法模板交付测试同时报错，确认测试能检出本次根因。

测试并未构建新PPT服务镜像，也不是实际HTTP请求或完整PPTX制作验收。`scripts/test_ppt_master_service.js` 已补入全目录模板复制/校验，但此次未运行该完整脚本。

## Node定向回归

功能阶段按以下三批执行，无失败或跳过，批次之间存在重叠：

```powershell
node scripts/run_node_tests.js tests/presentation-master.test.js tests/presentation-template-catalog.test.js tests/presentation-master-service.test.js
node scripts/run_node_tests.js tests/presentation-master-settings-client.test.js tests/presentation-master-settings.test.js tests/decision-failure-details.test.js tests/monitor-dashboard.test.js tests/decision-route-modules.test.js
$env:PIVOT_TEST_TMP_ROOT = 'E:\pivot\.tmp\node-tests'
node scripts/run_node_tests.js tests/data-analysis-navigation.test.js tests/data-analysis-manual-selection.test.js tests/data-analysis-request-state.test.js
```

三批分别18、30、13项通过。服务配置批次包括真实设置HTTP权限与密钥不回显；决策明细的真实PostgreSQL测试使用独立任务发起账号，验证任务账号优先、决策账号回退、创建时间早于失败事件、分页和报告来源。客户端覆盖缺失信息、名称安全转义、取消和迟到响应，数据分析保留选择、导航及异步结果失效规则。

本机Node为v24.22.0。浏览器临时目录因C盘剩余空间不足切到 `E:\pivot\.tmp\browser-tests`，生产存储目录没有变化。

## 浏览器验证

- 服务卡片与监控重点复验4项通过：全站完整配置在系统admin和另一个管理员中均为绿色；只读账号不获得测试/编辑按钮及服务地址；1280px与390px失败明细分页每次只请求一次；核验明细显示昵称/账号、失败记录时间与任务发起时间，桌面完整展示、手机可横向查看末列。
- `tests/e2e/data-analysis-sources.spec.js` 两项通过：1660px、1280px、390px下来源类型紧邻数据集，实际导入CSV并生成图表、运行查询、生成透视；模型目录使用受控数据验证搜索、分页、已发布筛选与跳转。查询下拉框收窄后，同一三页场景再次通过，并断言桌面宽度在200至260px之间。
- 首轮扩展浏览器回归为9项通过、1项失败。失败项为 `application-services-settings.spec.js` 中刷新后恢复应用服务页，实际显示模型配置页；以修改前的PPT设置脚本、监控脚本及设置样式对照运行仍在同一断言失败，未把此项记为通过。
- 测试编排初期遇到应用初始化/数据集摘要尚未完成即切换或运行造成的失败，已在新用例中等待账号、应用完整打开与摘要完成后操作，最终使用上述通过结果；不将中间失败抹为全流程始终通过。

浏览器验证入口：

```powershell
$env:PIVOT_TEST_TMP_ROOT = 'E:\pivot\.tmp\browser-tests'
node scripts/run_e2e_tests.js tests/e2e/application-services-settings.spec.js tests/e2e/settings-pagination.spec.js tests/e2e/smoke.spec.js --grep '全站PPT配置|监控失败明细翻页|对话质量展示'
node scripts/run_e2e_tests.js tests/e2e/data-analysis-sources.spec.js
node scripts/run_e2e_tests.js tests/e2e/data-analysis-sources.spec.js --grep '三个分析页'
```

截图位于 `output/intent-diagnostics/monitor-desktop.png`、`monitor-mobile.png` 及 `output/data-analysis-sources/`；失败恢复对照材料保留在本机 `output/e2e-failures/`。这些是功能阶段本地证据，不等于生产截图或已构建发行制品。

## 静态检查与范围

功能阶段 `npm run check`、改动JS的ESLint、`npm run typecheck`、`npm run check:standards:changed` 及差异空白检查通过；随后纯CSS宽度微调重新生成样式并通过浏览器验证、改动测试文件ESLint与增量开发规范检查。

未运行全仓 `npm test`、PPT Master完整HTTP制作/原稿/视频验收、真实已发布模型全流程计算或生产部署。已有设置页刷新恢复失败保留，旧失败事件中未保存的用户、任务时间和报告快照不补造。绿色PPT卡片只表达配置状态，不能作为持续在线证据。

## 升版核对

通过 `npm run version:sync` 从更新日志同步源码版本后，核对 `package.json`、锁文件顶层/根包、`server/version.js` 返回值、README徽章/最新版本/页尾以及设计基线，均为 v0.7.159；依赖锁文件仅根版本字段变化。使用帮助更新操作内容，按既有页面规则保留无版本号页头。

新增发布文档及报告的12处本地链接有效，类型检查、改动JS的ESLint、差异空白及前端静态资源检查通过。首次通用检查检出帮助页新增版本标记不符合既有规则，已移除该标记并复查静态资源；没有通过修改门禁绕过问题。

修正后在源码 v0.7.159 下重新执行 `npm run check`，整条通用检查链通过，包括文本、开发规范、版本关联资源与2520个JS文件的语法检查。功能测试保持前述执行时身份，本轮文档归档未重新运行全仓功能测试或生产验收。
