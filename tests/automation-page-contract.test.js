const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('自动化页面避免后台轮询误触发并防止列表响应倒灌', () => {
    const realtime = read('client/chat/agent-run-realtime.js');
    const runs = read('client/chat/agent-run-loaders.js');
    const workflows = read('client/chat/agent-workflow-library.js');
    const schedules = read('client/chat/agent-schedules.js');
    const workflowSchedules = read('client/chat/agent-workflow-schedules.js');

    assert.match(realtime, /isAgentElementVisible\('agent-workbench-modal'\)/);
    assert.doesNotMatch(realtime, /!document\.getElementById\('agent-workbench-modal'\)\?\.classList\.contains\('hidden'\)/);
    assert.match(runs, /let agentRunsLoadSequence = 0/);
    assert.match(runs, /requestId !== agentRunsLoadSequence/);
    assert.match(workflows, /requestId !== agentWorkflowsLoadSequence/);
    assert.match(schedules, /requestId !== agentSchedulesLoadSequence/);
    assert.match(workflowSchedules, /requestId !== agentWorkflowSchedulesLoadSequence/);
});

test('自动化执行操作具备幂等键、忙碌锁和网络错误恢复', () => {
    const actions = read('client/chat/agent-run-actions.js');
    const runners = read('client/chat/agent-workflow-runners.js');
    const schedules = read('client/chat/agent-schedules.js');
    const workflowSchedules = read('client/chat/agent-workflow-schedules.js');

    assert.match(actions, /const agentRunActionLocks = new Set/);
    assert.match(actions, /'Idempotency-Key': createAgentIdempotencyKey\(\)/);
    assert.match(runners, /'Idempotency-Key': \(typeof createAgentIdempotencyKey === 'function'/);
    assert.match(runners, /const agentWorkflowRunLocks = new Set/);
    assert.match(runners, /setAgentWorkflowRunBusy\(source, true\)/);
    assert.match(actions, /showToast\(error\.message \|\| fallbackMessage, 'error'\)/);
    assert.match(schedules, /const agentScheduleActionLocks = new Set/);
    assert.match(workflowSchedules, /const agentWorkflowScheduleActionLocks = new Set/);
});

test('自动化弹窗和主导航提供完整的对话框与选项卡语义', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const library = read('client/chat/agent-workflow-library.js');
    const core = read('client/chat/agent-workflow-core.js');

    assert.match(agent, /role="tab"[^>]*aria-controls="agent-workbench-modal"/);
    assert.match(agent, /id="agent-run-detail-modal"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="automation-workflows-panel"[^>]*role="tabpanel"/);
    assert.match(dag, /id="agent-workflow-metadata-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-workflow-share-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-workflow-dependency-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(dag, /id="agent-dag-json-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(library, /setAgentWorkflowLibraryModalVisibility\(modal, false\)/);
    assert.match(core, /modal\.setAttribute\('aria-hidden', 'false'\)/);
});

test('自动化资源将触发器和凭据能力接入页面，并避免回显敏感值', () => {
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const resources = read('client/chat/agent-automation-resources.js');
    const credentials = read('server/services/workflow-credentials.js');
    const migrations = read('server/db/migrations/index.js');

    const extraModals = read('client/chat/partials/admin-extra-modals.html');
    assert.match(dag, /id="agent-workflow-dependency-manage-creds-btn"/);
    assert.match(dag, /id="agent-workflow-triggers-btn"[^>]*>自动启动</);
    assert.match(extraModals, /id="agent-automation-resources-modal"[^>]*role="dialog"[^>]*aria-hidden="true"/);
    assert.match(extraModals, /id="agent-automation-triggers-tab"[^>]*role="tab"/);
    assert.match(resources, /apiFetch\(`\$\{API_BASE\}\/agents\/triggers`\)/);
    assert.match(resources, /apiFetch\(`\$\{API_BASE\}\/agents\/credentials`\)/);
    assert.match(resources, /const agentAutomationResourceActionLocks = new Set/);
    assert.match(resources, /访问令牌只显示这一次/);
    assert.match(resources, /clearAgentAutomationResourceNotice\(\)/);
    assert.match(resources, /agentAutomationResourceWorkflowId/);
    assert.match(resources, /data-agent-automation-resource-tab/);
    assert.match(resources, /modal\.parentElement !== document\.body/);
    assert.match(resources, /modal\.style\.zIndex = '5600'/);
    assert.match(resources, /agent-automation-resources-modal--trigger/);
    assert.match(resources, /footer\?\.classList\.toggle\('hidden', isOpen\)/);
    const modalStyles = read('client/chat/styles/workspaces/agent/agent-workflow-modals.css');
    assert.match(modalStyles, /\.agent-automation-resources-modal--trigger/);
    assert.match(credentials, /allowed_user_ids: parseAllowedUserIds\(row\.allowed_user_ids\)/);
    assert.match(credentials, /allowed_units = \?, allowed_user_ids = \?, updated_at/);
    assert.match(migrations, /202608220008_workflow_credential_user_visibility/);
});

test('工作流资产列表仅对已发布工作流展示计划按钮，未发布工作流不可见', () => {
    const workflows = read('client/chat/agent-workflows.js');
    assert.match(workflows, /workflow\.can_edit && publishedVersion \? `<button[^>]*data-automation-workflow-schedule=/);
    assert.doesNotMatch(workflows, /disabled title="发布后可创建计划"/);
});

test('新建评测集弹窗右上角不展示关闭按钮，由底部取消按钮关闭', () => {
    const evaluations = read('client/chat/agent-evaluations.js');
    const headMatch = evaluations.match(/<div class="agent-config-modal-head">([\s\S]*?)<\/div>\s*<div class="agent-eval-editor-body">/);
    assert.ok(headMatch);
    assert.doesNotMatch(headMatch[1], /data-agent-eval-editor-close/);
    assert.match(evaluations, /agent-eval-editor-footer[\s\S]*?data-agent-eval-editor-close[\s\S]*?取消/);
});

test('质量与可靠性大屏采用左右双栏布局与紧凑指标卡片', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const harnessCss = read('client/chat/styles/workspaces/agent/agent-harness.css');
    const evalCss = read('client/chat/styles/workspaces/agent/agent-evaluations.css');

    // HTML 左右双栏结构
    assert.match(agent, /class="agent-cp-quality-col agent-cp-quality-col--left"[\s\S]*?agent-quality-panel[\s\S]*?agent-eval-overview/);
    assert.match(agent, /class="agent-cp-quality-col agent-cp-quality-col--right"[\s\S]*?agent-reliability-panel[\s\S]*?agent-feedback-summary/);

    // CSS 双栏与紧凑网格
    assert.match(harnessCss, /\.agent-cp-quality-layout\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(harnessCss, /\.agent-cp-quality-col\s*\{[\s\S]*?flex-direction:\s*column;/);
    assert.match(harnessCss, /\.agent-quality-metrics-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(harnessCss, /\.agent-feedback-metrics\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(evalCss, /\.agent-eval-overview\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/);
});

test('新建评测集弹窗主体使用自适应滚动且无多余预留槽', () => {
    const evalCss = read('client/chat/styles/workspaces/agent/agent-evaluations.css');
    assert.match(evalCss, /\.agent-eval-editor-body\s*\{[\s\S]*?overflow-y:\s*auto;/);
    assert.doesNotMatch(evalCss, /\.agent-eval-editor-body\s*\{[\s\S]*?scrollbar-gutter:/);
});

test('任务页面新建任务按钮移动至删除审计左侧，工作流搜索栏居左且新建按钮居右，控制台持续目标按钮去重去加号', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const dagCss = read('client/chat/styles/workspaces/agent/agent-dag-workspace-shell.css');

    // 1. 任务页面：新建任务按钮在删除审计左侧，顶栏不再放置新建任务
    assert.match(agent, /class="agent-history-head-actions"[\s\S]*?id="task-create-open-btn"[\s\S]*?id="agent-audit-btn"/);
    const topActions = agent.match(/<div class="agent-modal-header-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(topActions, /id="task-create-open-btn"/);
    assert.doesNotMatch(topActions, /id="agent-goal-create-top-btn"/);

    // 2. 工作流页面：搜索栏靠左，新建工作流靠右
    assert.match(dag, /class="automation-assets-toolbar"[\s\S]*?class="automation-assets-search"[\s\S]*?class="automation-assets-actions"[\s\S]*?id="automation-new-workflow-btn"/);
    assert.match(dagCss, /\.automation-assets-toolbar\s*\{[\s\S]*?justify-content:\s*space-between;/);

    // 3. Agent 控制台：持续目标卡片内按钮去除加号
    assert.match(agent, /id="agent-goal-create"[^>]*>新建持续目标<\/button>/);
});

test('新建任务弹窗中模板区域采用按钮加独立弹窗样式，表单主体不内嵌模板条', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const templatesJs = read('client/chat/agent-templates.js');

    // 1. 新建任务表单主体不内嵌模板条
    const bodyContent = agent.match(/<div class="agent-task-editor-body">([\s\S]*?)<\/div>\s*<div class="agent-task-editor-footer">/)?.[1] || '';
    assert.doesNotMatch(bodyContent, /class="agent-task-composer-templates-bar"/);

    // 2. 常用模板按钮位于底部左侧与保存为模板并列，头部不重复放置避免错位
    assert.match(agent, /class="agent-task-footer-left-actions"[\s\S]*?id="agent-footer-templates-btn"[^>]*>常用模板<\/button>[\s\S]*?data-agent-save-template/);
    const taskHeadActions = agent.match(/<div id="agent-run-panel"[^>]*>[\s\S]*?<div class="agent-config-modal-head">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(taskHeadActions, /常用模板/);

    // 3. 独立存在常用模板弹窗
    assert.match(agent, /id="agent-template-modal"[^>]*class="modal-overlay hidden"[\s\S]*?id="agent-template-list"/);

    // 4. JS 提供开闭模板弹窗函数
    assert.match(templatesJs, /function openAgentTemplateModal/);
    assert.match(templatesJs, /function closeAgentTemplateModal/);
});

test('新建任务弹窗右上角不展示关闭按钮，由底部取消按钮关闭', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const headMatch = agent.match(/<div id="agent-run-panel"[^>]*>[\s\S]*?<div class="agent-config-modal-head">([\s\S]*?)<\/div>\s*<div class="agent-task-editor-body">/);
    assert.ok(headMatch);
    assert.doesNotMatch(headMatch[1], /id="task-create-close-btn"/);
    assert.doesNotMatch(headMatch[1], /<button/);
    assert.match(agent, /id="task-create-cancel-btn"[^>]*>取消<\/button>/);
});

test('常用任务模板弹窗右下角不展示关闭按钮，由右上角关闭按钮关闭', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const modalMatch = agent.match(/<div id="agent-template-modal"[^>]*>([\s\S]*?)<\/div>\s*<!-- 新建任务弹窗 -->/);
    assert.ok(modalMatch);
    // 右上角有关闭按钮
    assert.match(modalMatch[1], /class="agent-config-modal-head"[\s\S]*?id="agent-template-modal-close"/);
    // 右下角（footer）无关闭按钮
    const footerMatch = modalMatch[1].match(/<div class="agent-task-editor-footer">([\s\S]*?)<\/div>/);
    assert.ok(footerMatch);
    assert.doesNotMatch(footerMatch[1], /<button/);
});

test('数据分析应用数据总览表格中行高统一为38px且操作按钮统一为24px', () => {
    const viewJs = read('client/chat/data-analysis/view.js');
    const overviewCss = read('client/chat/styles/workspaces/apps/data-analysis-overview.css');

    // 1. 确保 7 列完整且顺序正确（序号、名称、文件名、大小、类型、时间、操作）
    assert.match(viewJs, /data-analysis-row-index[\s\S]*?data-analysis-dataset-name[\s\S]*?data-analysis-break-text[\s\S]*?data-analysis-size-cell[\s\S]*?data-analysis-file-type[\s\S]*?data-analysis-muted-cell[\s\S]*?data-analysis-table-actions/);

    // 2. view.js 中不使用 <br> 换行
    assert.doesNotMatch(viewJs, /dataset\.columnCount\)[^<]*<br>/);
    assert.match(viewJs, /class="data-analysis-size-cell"><div class="data-analysis-size-wrapper"/);

    // 3. CSS 中声明了 white-space: nowrap
    assert.match(overviewCss, /\.data-analysis-size-cell\s*\{[\s\S]*?white-space:\s*nowrap;/);
    assert.match(overviewCss, /\.data-analysis-size-wrapper\s*\{[\s\S]*?white-space:\s*nowrap;/);

    // 4. 表格行高与单元格高度统一为全局 38px
    assert.match(overviewCss, /\.data-analysis-dataset-table td\s*\{[\s\S]*?height:\s*38px;/);
    assert.match(overviewCss, /\.data-analysis-dataset-table td\s*\{[\s\S]*?padding:\s*6px 8px;/);

    // 5. 操作按钮高度统一为全局 24px
    assert.match(overviewCss, /\.data-analysis-table-actions\s*\{[\s\S]*?height:\s*24px;/);
    assert.match(overviewCss, /\.data-analysis-table-btn\s*\{[\s\S]*?height:\s*24px;/);
});

test('Agent控制台数据表类型列具备防省略号截断保护', () => {
    const harnessJs = read('client/chat/agent-harness.js');
    const harnessCss = read('client/chat/styles/workspaces/agent/agent-harness.css');
    const runsListCss = read('client/chat/styles/workspaces/agent/agent-runs-list-table.css');

    // 1. 收件箱类型列宽度不小于 96px，并挂载 agent-inbox-type-col 类
    assert.match(harnessJs, /<th class="text-center" style="width:\s*96px;">类型<\/th>/);
    assert.match(harnessJs, /<td class="text-center agent-inbox-type-col">/);

    // 2. CSS 对类型列与徽标设置专用宽度与 text-overflow: clip
    assert.match(harnessCss, /\.agent-inbox-table td\.agent-inbox-type-col\s*\{[\s\S]*?width:\s*96px;/);
    assert.match(harnessCss, /\.agent-inbox-table td\.agent-inbox-type-col\s*\{[\s\S]*?text-overflow:\s*clip;/);
    assert.match(harnessCss, /\.agent-inbox-type-badge\s*\{[\s\S]*?text-overflow:\s*clip;/);

    // 3. 任务运行列表类型列宽度扩展为 96px 且具备防截断
    assert.match(runsListCss, /\.agent-runs-table th:nth-child\(4\)[\s\S]*?width:\s*96px;/);
    assert.match(runsListCss, /\.agent-run-type\s*\{[\s\S]*?text-overflow:\s*clip;/);
});

test('Agent控制台统一收件箱与持续目标卡片自适应撑满高度，消除底部大块空白', () => {
    const harnessCss = read('client/chat/styles/workspaces/agent/agent-harness.css');

    // 1. 单卡片子视图容器内的卡片必须 flex: 1 1 auto 且 height: 100%
    assert.match(harnessCss, /\.agent-cp-subview-pane:not\(\[data-agent-cp-pane="quality"\]\)\s*>\s*\.agent-cp-card\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(harnessCss, /\.agent-cp-subview-pane:not\(\[data-agent-cp-pane="quality"\]\)\s*>\s*\.agent-cp-card\s*\{[\s\S]*?height:\s*100%;/);

    // 2. 收件箱表格容器自适应填满卡片，不得设置 400px 最大高度截断
    assert.match(harnessCss, /\.agent-inbox-table-wrap\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(harnessCss, /\.agent-inbox-table-wrap\s*\{[\s\S]*?max-height:\s*none;/);
    assert.doesNotMatch(harnessCss, /\.agent-inbox-table-wrap\s*\{[\s\S]*?max-height:\s*400px;/);

    // 3. 持续目标列表自适应铺满卡片并支持独立滚动
    assert.match(harnessCss, /\.agent-goal-list[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(harnessCss, /\.agent-goal-list[\s\S]*?overflow-y:\s*auto;/);
});

test('工作流发布支持跳过评测门禁及在门禁拦截时提示确认发布', () => {
    const routeJs = read('server/routes/agents.js');
    const libraryJs = read('client/chat/agent-workflow-library.js');
    const toolbarJs = read('client/chat/dag-toolbar.js');
    const appJs = read('server/app.js');

    // 1. 服务端发布路由支持 skipEvaluationGate 参数
    assert.match(routeJs, /skipEvaluationGate\s*=\s*req\.body\?\.skipEvaluationGate === true \|\| req\.body\?\.fixedEvaluationRequired === false/);

    // 2. 全局错误中间件在 4xx 时透传 err.code
    assert.match(appJs, /isClientError && err\.code \? \{ code: err\.code \} : \{\}/);

    // 3. 前端工作流发布方法支持 skipEvaluationGate 并在 409 拦截时弹出提示确认
    assert.match(libraryJs, /async function publishSelectedAgentWorkflow\(version = 'current', options = \{\}\)/);
    assert.match(libraryJs, /WORKFLOW_EVALUATION_GATE_FAILED/);
    assert.match(libraryJs, /showConfirm\('发布门禁提示'/);

    // 4. 画布工具栏发布菜单包含「发布当前版本」与「跳过门禁发布」
    assert.match(toolbarJs, /makeButton\('发布当前版本'/);
    assert.match(toolbarJs, /makeButton\('跳过门禁发布'/);
});

test('Agent控制台各模块具备分页控件且收件箱点击详情自动标记已读', () => {
    const html = read('client/chat/partials/workspaces/agent.html');
    const js = read('client/chat/agent-harness.js');
    const css = read('client/chat/styles/workspaces/agent/agent-harness.css');

    // 1. HTML 包含所有控制台分页容器
    assert.match(html, /id="agent-inbox-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-goals-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-reliability-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-feedback-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-harness-residency-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-evolution-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-harness-skill-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);
    assert.match(html, /id="agent-harness-pack-pagination"[^>]*class="[^"]*workspace-pagination[^"]*"/);

    // 2. JS 包含分页与详情自动标记已读逻辑
    assert.match(js, /document\.getElementById\(['"]agent-inbox-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-goals-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-reliability-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-feedback-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-harness-residency-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-evolution-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-harness-skill-pagination['"]\)/);
    assert.match(js, /document\.getElementById\(['"]agent-harness-pack-pagination['"]\)/);
    assert.match(js, /renderWorkspacePagination/);
    assert.match(js, /data-agent-inbox-open-run/);
    assert.match(js, /data-agent-inbox-unread/);
    assert.match(js, /\/agents\/inbox\/[\s\S]*?\/read/);

    // 3. CSS 包含分页样式
    assert.match(css, /\.agent-inbox-pagination/);
    assert.match(css, /\.agent-goals-pagination/);
    assert.match(css, /\.agent-reliability-pagination/);
    assert.match(css, /\.agent-feedback-pagination/);
    assert.match(css, /\.agent-evolution-pagination/);
    assert.match(css, /\.agent-harness-residency-pagination/);
    assert.match(css, /\.agent-harness-skill-pagination/);
    assert.match(css, /\.agent-harness-pack-pagination/);
});

test('Agent统一收件箱和评测中心查看详情支持返回原页面原选项卡', () => {
    const harnessJs = read('client/chat/agent-harness.js');
    const evalJs = read('client/chat/agent-evaluations.js');
    const detailJs = read('client/chat/agent-run-detail.js');
    const html = read('client/chat/partials/workspaces/agent.html');

    // 1. 收件箱与评测中心在 openAgentRun 时传递 returnTab 上下文
    assert.match(harnessJs, /openAgentRun.*returnTab:\s*'workbench'.*returnSubview:\s*'inbox'/);
    assert.match(evalJs, /openAgentRun.*returnTab:\s*'workbench'.*returnSubview:\s*'quality'/);

    // 2. 详情逻辑保存与恢复 returnContext
    assert.match(detailJs, /activeAgentRunReturnContext/);
    assert.match(detailJs, /openAgentWorkbench.*tab:\s*targetTab/);
    assert.match(detailJs, /switchAgentCpSubview.*targetSubview/);

    // 3. 面包屑包含父级和返回按钮定制标识
    assert.match(html, /id="agent-breadcrumb-back-label"/);
    assert.match(html, /id="agent-breadcrumb-parent-label"/);
});

test('知识图谱顶部入口与文档列表行操作入口具备范围隔离契约', () => {
    const ragJs = read('client/chat/rag.js');
    const graphControllerJs = read('client/chat/rag-graph-controller.js');
    const ragServerJs = read('server/rag.js');
    const kgServiceJs = require('fs').readFileSync('server/services/knowledge-graph.js', 'utf8');

    // 1. 前端列表行按钮传入对应文档 docId，顶部入口传入全局（无 docId）
    assert.match(ragJs, /docGraphBtn[\s\S]*?window\.openKnowledgeGraph\(docGraphBtn\.dataset\.ragId\)/);
    assert.match(ragJs, /#rag-graph-open-btn[\s\S]*?window\.openKnowledgeGraph\(\)/);

    // 2. 前端控制器将 docId 贯穿到概览、实体列表、关系地图、关系列表与图谱查询
    assert.match(graphControllerJs, /modal\.dataset\.docId\s*=/);
    assert.match(graphControllerJs, /title\.textContent\s*=\s*scopedDocId/);
    assert.match(graphControllerJs, /loadGraphSummary[\s\S]*?params\.set\('docId',\s*docId\)/);
    assert.match(graphControllerJs, /loadGraphEntities[\s\S]*?params\.set\('docId',\s*docId\)/);
    assert.match(graphControllerJs, /loadGraphRelations[\s\S]*?params\.set\('docId',\s*docId\)/);
    assert.match(graphControllerJs, /selectKnowledgeGraphEntity[\s\S]*?graphParams\.set\('docId',\s*docId\)/);
    assert.match(graphControllerJs, /debugKnowledgeGraphQuery[\s\S]*?params\.set\('docId',\s*docId\)/);

    // 3. 后端路由在各图谱接口均提取并转发 docId
    assert.match(ragServerJs, /\/graph\/summary[\s\S]*?docId:\s*req\.query\.docId/);
    assert.match(ragServerJs, /\/graph\/entities(?!\/)[\s\S]*?scope:\s*\{\s*docId:\s*req\.query\.docId\s*\}/);
    assert.match(ragServerJs, /\/graph\/relations[\s\S]*?docId:\s*req\.query\.docId/);
    assert.match(ragServerJs, /\/graph\/query[\s\S]*?scope:\s*\{\s*docId:\s*req\.query\.docId\s*\}/);
    assert.match(ragServerJs, /\/graph\/entities\/:id[\s\S]*?scope:\s*\{\s*docId:\s*req\.query\.docId\s*\}/);

    // 4. 后端实体统计与关系查询在文档作用域下隔离 mention_count 与 relation_count
    assert.match(kgServiceJs, /buildGraphEntityScopeSql/);
    assert.match(kgServiceJs, /buildGraphRelationRecordScopeSql/);
    assert.match(kgServiceJs, /buildGraphMentionScopeSql/);
});
