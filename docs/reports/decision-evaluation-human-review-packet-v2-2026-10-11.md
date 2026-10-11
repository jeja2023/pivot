# 决策冻结集人工审阅包

- 评测集版本：`v2`
- 模型：`chatgpt-5.6-luna`
- 模型预审核时间：2026-10-11T00:16:38.656Z
- 说明：下表的“模型候选”不是人工结论。管理员必须根据业务规则独立确认“人工预期动作”，再使用系统审阅界面或受控审阅命令写入标签。

| 案例 | 场景 | 脱敏请求 | 允许动作 | 模型候选 | 人工预期动作 | 审阅说明 |
| --- | --- | --- | --- | --- | --- | --- |
| rag-zh-short-001 | chat.rag | 请根据公司的差旅报销制度说明发票报销流程。 | retrieve、skip | retrieve | 待业务管理员填写 | 待业务管理员填写 |
| rag-zh-negative-001 | chat.rag | 不要检索知识库，帮我把这句话改得更正式。 | retrieve、skip | retrieve | 待业务管理员填写 | 待业务管理员填写 |
| rag-long-context-001 | chat.rag | 请综合现有制度、审批流程和最新执行口径，说明跨部门差旅费用如何报销，并列出需要的材料。 | retrieve、skip | retrieve | 待业务管理员填写 | 待业务管理员填写 |
| tools-data-001 | chat.tools | 查询本月订单数量，并按状态汇总。 | propose、skip | skip | 待业务管理员填写 | 待业务管理员填写 |
| tools-consent-001 | chat.tools | 请查询订单数量，但我尚未授权数据库工具。 | candidate_only、skip | candidate_only | 待业务管理员填写 | 待业务管理员填写 |
| tools-browser-001 | chat.tools | 打开已授权的内部网页，查看当前发布公告。 | propose、skip | skip | 待业务管理员填写 | 待业务管理员填写 |
| tools-report-001 | chat.tools | 读取已授权的本机报表目录，列出今天生成的报表文件。 | propose、skip | propose | 待业务管理员填写 | 待业务管理员填写 |
| rag-cross-unit-001 | chat.rag | 请依据我有权访问的制度资料回答跨部门费用归属规则。 | retrieve、skip | retrieve | 待业务管理员填写 | 待业务管理员填写 |
| tools-high-risk-001 | chat.tools | 请发送一条通知给相关人员，告知审批结果。 | propose、skip | skip | 待业务管理员填写 | 待业务管理员填写 |
| rag-rare-001 | chat.rag | 请依据归档资料说明少见的海外临时差旅例外流程。 | retrieve、skip | skip | 待业务管理员填写 | 待业务管理员填写 |
| tools-en-001 | chat.tools | Query the authorized sales database and summarize orders by status. | propose、skip | propose | 待业务管理员填写 | 待业务管理员填写 |
| rag-conversation-001 | chat.rag | 你好，今天过得怎么样？ | retrieve、skip | skip | 待业务管理员填写 | 待业务管理员填写 |
| next-step-direct-zh-001 | chat.next_step | 请把下面这段通知改写得正式、简洁：明天下午三点开会。 | direct_answer、clarify | clarify | 待业务管理员填写 | 待业务管理员填写 |
| next-step-clarify-zh-001 | chat.next_step | 帮我把那个事情处理一下。 | direct_answer、clarify | direct_answer | 待业务管理员填写 | 待业务管理员填写 |
| workflow-published-zh-001 | agent.workflow | 汇总本月订单，按状态和地区生成报表，并提交给部门负责人复核。 | direct_answer、clarify、workflow:101 | direct_answer | 待业务管理员填写 | 待业务管理员填写 |

审阅完成后，每条案例应由有权限的管理员提交对应的人工预期动作。系统会拒绝不在“允许动作”范围内的标签，且在全部 15 条完成前保持主动灰度关闭。
