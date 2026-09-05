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

test('质量与可靠性大屏采用 Tab 切换布局与紧凑指标卡片', () => {
    const agent = read('client/chat/partials/workspaces/agent.html');
    const harnessCss = read('client/chat/styles/workspaces/agent/agent-harness.css');
    const evalCss = read('client/chat/styles/workspaces/agent/agent-evaluations.css');

    // HTML Tab 切换结构
    assert.match(agent, /class="agent-cp-quality-tabs"[\s\S]*?data-quality-tab="metrics"[\s\S]*?data-quality-tab="eval"[\s\S]*?data-quality-tab="reliability"[\s\S]*?data-quality-tab="feedback"/);
    assert.match(agent, /data-quality-panel="metrics"[\s\S]*?agent-quality-panel/);
    assert.match(agent, /data-quality-panel="eval"[\s\S]*?agent-eval-overview/);
    assert.match(agent, /data-quality-panel="reliability"[\s\S]*?agent-reliability-panel/);
    assert.match(agent, /data-quality-panel="feedback"[\s\S]*?agent-feedback-summary/);

    // CSS Tab 导航与紧凑网格
    assert.match(harnessCss, /\.agent-cp-quality-tabs\s*\{[\s\S]*?display:\s*inline-flex;/);
    assert.match(harnessCss, /\.agent-cp-quality-tab\.active\s*\{[\s\S]*?color:\s*var\(--primary/);
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
    const agentRunsCss = read('client/chat/styles/workspaces/agent/agent-runs-list-table.css');
    const dag = read('client/chat/partials/workspaces/agent-dag.html');
    const dagCss = read('client/chat/styles/workspaces/agent/agent-dag-workspace-shell.css');

    // 1. 任务页面：新建任务按钮在删除审计左侧，顶栏不再放置新建任务
    assert.match(agent, /class="agent-history-head-actions"[\s\S]*?id="task-create-open-btn"[\s\S]*?id="agent-audit-btn"/);
    assert.match(agent, /id="agent-audit-btn"[^>]*\badmin-root-only\b[^>]*\bhidden\b/);
    assert.match(agentRunsCss, /\.agent-history-head-actions > button\.hidden\s*\{[\s\S]*?display:\s*none !important;/);
    const topActions = agent.match(/<div class="agent-modal-header-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(topActions, /id="task-create-open-btn"/);
    assert.doesNotMatch(topActions, /id="agent-goal-create-top-btn"/);

    // 2. 工作流页面：搜索栏靠左，新建工作流靠右
    assert.match(dag, /class="automation-assets-toolbar"[\s\S]*?class="automation-assets-search"[\s\S]*?class="automation-assets-actions"[\s\S]*?id="automation-new-workflow-btn"/);
    assert.match(dagCss, /\.automation-assets-toolbar\s*\{[\s\S]*?justify-content:\s*space-between;/);

    // 3. Agent 控制台：持续目标卡片内按钮去除加号
    assert.match(agent, /id="agent-goal-create"[^>]*>新建自动目标<\/button>/);
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
    assert.match(harnessCss, /\.agent-cp-subview-pane[\s\S]*?>\s*\.agent-cp-card[\s\S]*?\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(harnessCss, /\.agent-cp-subview-pane[\s\S]*?>\s*\.agent-cp-card[\s\S]*?\{[\s\S]*?height:\s*100%;/);

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
    const runtimePacksJs = read('client/chat/agent-runtime-packs-console.js');
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
    assert.match(runtimePacksJs, /document\.getElementById\(['"]agent-harness-pack-pagination['"]\)/);
    assert.match(js, /renderWorkspacePagination/);
    assert.match(js, /data-agent-inbox-open-run/);
    assert.match(js, /data-agent-inbox-unread/);
    assert.match(js, /inboxLimit:\s*20/);
    assert.match(js, /state\.inboxLimit\s*\|\|\s*20/);

    // 3. CSS 包含分页样式，且待办中心分页居中
    assert.match(css, /\.agent-inbox-pagination\s*\{[\s\S]*?justify-content:\s*center;/);
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
    assert.match(ragJs, /docGraphBtn[\s\S]*?window\.Pivot\.legacy\.openKnowledgeGraph\(docGraphBtn\.dataset\.ragId\)/);
    assert.match(ragJs, /#rag-graph-open-btn[\s\S]*?window\.Pivot\.legacy\.openKnowledgeGraph\(\)/);

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

test('数据分析数据查询页面可视化筛选紧凑布局、固定高度表格与分页契约', () => {
    const viewJs = read('client/chat/data-analysis/view.js');
    const queryJs = read('client/chat/data-analysis/query.js');
    const overviewCss = read('client/chat/styles/workspaces/apps/data-analysis-overview.css');

    // 1. view.js 中具备紧凑化可视化查询结构
    assert.match(viewJs, /class="data-analysis-query-visual-box"/);
    assert.match(viewJs, /class="data-analysis-query-settings-grid"/);

    // 2. query.js 中具备分页切片逻辑与统一分页控件调用
    assert.match(queryJs, /state\.queryPageSize/);
    assert.match(queryJs, /id="data-analysis-query-pagination"/);
    assert.match(queryJs, /exportQueryResultToCsv/);

    // 3. CSS 中声明了数据展示区域的固定高度与粘性吸顶表头
    assert.match(overviewCss, /\.data-analysis-query-table\s*\{[\s\S]*?height:\s*380px;/);
    assert.match(overviewCss, /\.data-analysis-query-table \.data-analysis-result-table th\s*\{[\s\S]*?position:\s*sticky;/);

    // 4. CSS 中声明了紧凑化筛选条件行与水平单行设置
    assert.match(overviewCss, /\.data-analysis-query-filter-row select,\s*\.data-analysis-query-filter-row input\s*\{[\s\S]*?height:\s*28px;/);
    assert.match(overviewCss, /\.data-analysis-query-settings-grid\s*\{[\s\S]*?display:\s*flex;/);
});

test('数据分析上传数据预览弹窗加宽加高与服务端分页契约', () => {
    const viewJs = read('client/chat/data-analysis/view.js');
    const datasetsJs = read('server/services/data-analysis/datasets.js');
    const resultsCss = read('client/chat/styles/workspaces/apps/data-analysis-results.css');

    // 1. view.js 中模态弹窗具备加宽加高结构、元数据标签与分页控件槽位
    assert.match(viewJs, /class="modal data-analysis-preview-modal-dialog"/);
    assert.match(viewJs, /id="data-analysis-preview-pagination"/);
    assert.match(viewJs, /page=\$\{page\}&pageSize=/);
    assert.match(viewJs, /window\.Pivot\.legacy\.renderWorkspacePagination/);

    // 2. 服务端 datasets.js 中支持分页查询与按页提取 Parquet 记录
    assert.match(datasetsJs, /async function getDatasetDetail\(userId, datasetId, options = \{\}\)/);
    assert.match(datasetsJs, /dataset\.previewPage = page;/);
    assert.match(datasetsJs, /dataset\.previewPageSize = pageSize;/);

    // 3. CSS 中声明了加宽加高弹窗（min(1560px, 95vw)）以及表头吸顶样式
    assert.match(resultsCss, /\.data-analysis-preview-modal-dialog\s*\{[\s\S]*?width:\s*min\(1560px,\s*95vw\);/);
    assert.match(resultsCss, /\.data-analysis-preview-modal-dialog\s*\{[\s\S]*?height:\s*min\(808px,\s*90vh\);/);
    assert.match(resultsCss, /\.data-analysis-preview \.data-analysis-result-table th\s*\{[\s\S]*?position:\s*sticky;/);

    // 4. 单元格紧凑高密度样式、截断限制与自定义悬浮气泡契约（非浏览器原生 title）
    const eventsJs = read('client/chat/data-analysis/events.js');
    const contextJs = read('client/chat/data-analysis/context.js');
    assert.match(contextJs, /previewPageSize:\s*25/);
    assert.match(resultsCss, /\.data-analysis-preview\s*\{[\s\S]*?overflow-y:\s*hidden;/);
    assert.match(resultsCss, /\.data-analysis-preview \.data-analysis-result-table td\s*\{[\s\S]*?height:\s*26px;/);
    assert.match(resultsCss, /\.data-analysis-preview \.data-analysis-result-table td\s*\{[\s\S]*?font-size:\s*0\.74rem;/);
    assert.match(resultsCss, /\.data-analysis-preview \.data-analysis-result-table td\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
    assert.match(resultsCss, /\.data-analysis-preview-pagination \.btn-secondary\s*\{[\s\S]*?height:\s*30px;/);
    assert.match(resultsCss, /\.data-analysis-cell-tooltip\s*\{[\s\S]*?position:\s*fixed;/);
    assert.match(eventsJs, /showCellTooltip/);
    assert.match(eventsJs, /data-cell-full/);
});

test('数据分析数据透视页面零外层滚动条与自适应高密度布局契约', () => {
    const viewJs = read('client/chat/data-analysis/view.js');
    const pivotCss = read('client/chat/styles/workspaces/apps/data-analysis-pivot.css');
    const resultsCss = read('client/chat/styles/workspaces/apps/data-analysis-results.css');

    // 1. view.js 具备双排高密度配置中枢结构与操作栏
    assert.match(viewJs, /class="data-analysis-pivot-config-main"/);
    assert.match(viewJs, /class="data-analysis-pivot-config-sub-filters"/);
    assert.match(viewJs, /class="data-analysis-pivot-toolbar-actions"/);
    assert.match(viewJs, /id="data-analysis-pivot-dataset"/);
    assert.match(viewJs, /id="data-analysis-pivot-row"/);
    assert.match(viewJs, /id="data-analysis-pivot-col"/);
    assert.match(viewJs, /id="data-analysis-pivot-value"/);
    assert.match(viewJs, /id="data-analysis-pivot-aggregation"/);
    assert.match(viewJs, /id="data-analysis-pivot-sort"/);
    assert.match(viewJs, /id="data-analysis-pivot-percent-mode"/);
    assert.match(viewJs, /id="data-analysis-pivot-row-limit"/);
    assert.match(viewJs, /id="data-analysis-pivot-col-limit"/);
    assert.match(viewJs, /id="data-analysis-pivot-empty-label"/);
    assert.match(viewJs, /id="data-analysis-pivot-hint"/);
    assert.match(viewJs, /id="data-analysis-pivot-recommend"/);
    assert.match(viewJs, /id="data-analysis-run-pivot"/);
    assert.match(viewJs, /id="data-analysis-pivot-export-btn"/);

    // 2. CSS 契约保证整个透视面板消除外层滚动条 (overflow: hidden !important) 且内容高度自适应
    assert.match(pivotCss, /#data-analysis-pivot-panel\s*\{[\s\S]*?overflow:\s*hidden\s*!important;/);
    assert.match(pivotCss, /#data-analysis-pivot-panel\s*\{[\s\S]*?height:\s*100%;/);
    assert.match(pivotCss, /\.data-analysis-pivot-workspace\s*\{[\s\S]*?overflow:\s*hidden;/);
    assert.match(pivotCss, /\.data-analysis-pivot-result\s*\{[\s\S]*?overflow:\s*hidden;/);

    // 3. 数据表格自适应填充剩余垂直空间 (flex: 1 1 auto, height: auto) 且内部滚动条就地停留
    assert.match(pivotCss, /\.data-analysis-pivot-table\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(pivotCss, /\.data-analysis-pivot-table\s*\{[\s\S]*?height:\s*auto;/);
    assert.match(pivotCss, /\.data-analysis-pivot-table\s*\{[\s\S]*?overflow:\s*auto;/);
    assert.doesNotMatch(pivotCss, /\.data-analysis-pivot-table\s*\{[\s\S]*?height:\s*480px;/);

    // 4. 输入框和选择框统一采用高密度舒适合理外观 (28-30px)
    assert.match(pivotCss, /\.data-analysis-pivot-config \.form-input\s*\{[\s\S]*?height:\s*(?:28|30)px;/);
    assert.match(pivotCss, /\.data-analysis-pivot-toolbar button\s*\{[\s\S]*?height:\s*(?:28|30)px;/);

    // 5. 数据表格表头、首列及合计行多向粘性吸顶吸附
    assert.match(resultsCss, /\.data-analysis-pivot-table \.data-analysis-result-table thead th\s*\{[\s\S]*?position:\s*sticky;/);
    assert.match(resultsCss, /\.data-analysis-pivot-table \.data-analysis-result-table thead th\s*\{[\s\S]*?top:\s*0;/);
    assert.match(resultsCss, /\.data-analysis-pivot-table \.data-analysis-result-table tbody th\s*\{[\s\S]*?position:\s*sticky;/);
    assert.match(resultsCss, /\.data-analysis-pivot-table \.data-analysis-result-table tbody th\s*\{[\s\S]*?left:\s*0;/);
    assert.match(resultsCss, /\.data-analysis-pivot-total-row th[\s\S]*?position:\s*sticky;/);
    assert.match(resultsCss, /\.data-analysis-pivot-total-row th[\s\S]*?bottom:\s*0;/);
});

test('数据分析智能分析页面看板引导、结构化画像、场景卡片与无外层滚动条布局契约', () => {
    const viewJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/view.js'), 'utf8');
    const aiJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/ai.js'), 'utf8');
    const resultsCss = fs.readFileSync(path.resolve(__dirname, '../client/chat/styles/workspaces/apps/data-analysis-results.css'), 'utf8');

    // 1. 结构契约：顶部统合工具栏、输入提示、冷启动引导看板与结果操作栏
    assert.match(viewJs, /class="data-analysis-ai-header-bar"/);
    assert.match(viewJs, /id="data-analysis-ai-dataset"/);
    assert.match(viewJs, /id="data-analysis-ai-prompt"/);
    assert.match(viewJs, /id="data-analysis-ai-clear-prompt"/);
    assert.match(viewJs, /class="data-analysis-ai-input-tip"/);
    assert.match(viewJs, /id="data-analysis-ai-landing"/);
    assert.match(viewJs, /id="data-analysis-ai-profile-content"/);
    assert.match(viewJs, /class="data-analysis-ai-scenario-card"/);
    assert.match(viewJs, /id="data-analysis-ai-result-wrap"/);
    assert.match(viewJs, /id="data-analysis-ai-copy-result"/);
    assert.match(viewJs, /id="data-analysis-ai-reset-view"/);
    assert.match(viewJs, /id="data-analysis-ai-result"/);

    // 2. 字段画像契约：包含结构化 KPI 指标与字段构成分布
    assert.match(aiJs, /data-analysis-ai-profile-kpis/);
    assert.match(aiJs, /data-analysis-ai-kpi-card/);
    assert.match(aiJs, /data-analysis-ai-field-chip/);
    assert.match(aiJs, /field-type-pill/);

    // 3. 无任何 Emoji 规范保障契约
    const aiSectionMatch = viewJs.match(/id="data-analysis-ai-panel"[\s\S]*?<\/section>/);
    assert.ok(aiSectionMatch, '应能匹配到 data-analysis-ai-panel 模板');
    const aiSectionHtml = aiSectionMatch[0];
    assert.doesNotMatch(aiSectionHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u, '智能分析模板中不得包含任何 emoji 字符');
    assert.doesNotMatch(aiJs.slice(0, 3000), /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u, 'AI 分析渲染逻辑中不得包含任何 emoji 字符');

    // 4. 单行 4 列场景卡片与无标签契约
    assert.doesNotMatch(viewJs, /class="scenario-tag">填入诉求<\/span>/, '场景卡片上不得展示填入诉求文字标签');
    assert.match(resultsCss, /\.data-analysis-ai-landing-scenarios\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*1fr\);/);

    // 5. CSS 契约：消除外层滚动条，主画布和结果展示自适应填满剩余垂直空间并内部滚动
    assert.match(resultsCss, /#data-analysis-ai-panel\s*\{[\s\S]*?overflow:\s*hidden\s*!important;/);
    assert.match(resultsCss, /#data-analysis-ai-panel\s*\{[\s\S]*?height:\s*100%;/);
    assert.match(resultsCss, /\.data-analysis-ai-canvas\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(resultsCss, /\.data-analysis-ai-result\s*\{[\s\S]*?overflow-y:\s*auto;/);
});

test('数据分析全量语义分析页面去重与联动布局契约', () => {
    const viewJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/view.js'), 'utf8');
    const coreJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/core.js'), 'utf8');
    const eventsJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/events.js'), 'utf8');
    const resultsCss = fs.readFileSync(path.resolve(__dirname, '../client/chat/styles/workspaces/apps/data-analysis-results.css'), 'utf8');

    // 1. 去重契约：全量语义分析子面板内部隐藏独立下拉，复用顶部统合数据集选择器，杜绝重复展示
    const semanticSubpanelMatch = viewJs.match(/id="data-analysis-ai-subpanel-semantic"[\s\S]*?<\/div>\s*<\/section>/);
    assert.ok(semanticSubpanelMatch, '应能匹配到 data-analysis-ai-subpanel-semantic 模板');
    const semanticSubpanelHtml = semanticSubpanelMatch[0];

    assert.match(semanticSubpanelHtml, /<select id="data-analysis-semantic-dataset" class="hidden"/, '旧语义数据集选择器应隐藏作为兼容桥接');
    assert.doesNotMatch(semanticSubpanelHtml, /<div class="data-analysis-semantic-heading">/, '不应存在重复的语义面板大标题');
    assert.doesNotMatch(semanticSubpanelHtml, /<h5>全量语义分析任务<\/h5>/, '不应在子面板内重复显示全量语义分析任务标题');

    // 2. 紧凑工具栏契约：任务历史与状态徽章同一横排
    assert.match(semanticSubpanelHtml, /class="data-analysis-semantic-toolbar"/);
    assert.match(semanticSubpanelHtml, /class="data-analysis-semantic-history-group"/);
    assert.match(semanticSubpanelHtml, /id="data-analysis-semantic-job"/);
    assert.match(semanticSubpanelHtml, /id="data-analysis-semantic-refresh-jobs"/);
    assert.match(semanticSubpanelHtml, /class="data-analysis-semantic-status-wrap"/);
    assert.match(semanticSubpanelHtml, /id="data-analysis-semantic-status"/);

    // 3. 状态联动与子面板切换契约：切换数据集与切换 Tab 时状态保持同步，且两个子面板正确切换 hidden
    assert.match(coreJs, /state\.semanticDatasetId\s*=\s*id;/, '加载数据集详情时应同步更新 semanticDatasetId');
    assert.match(eventsJs, /state\.semanticDatasetId\s*=\s*state\.activeId/, '切换全量语义分析 Tab 时应同步 activeId 至 semanticDatasetId');
    assert.match(eventsJs, /data-analysis-ai-subpanel-semantic'\)\?\.classList\.toggle\('hidden',\s*subtabName\s*!==\s*'semantic'\)/, '点击子 Tab 时应切换 semantic 子面板的 hidden 状态');

    // 4. 无 Emoji 规范
    assert.doesNotMatch(semanticSubpanelHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u, '语义分析模板中不得包含任何 emoji 字符');

    // 5. CSS 布局契约与左右双栏无外层滚动条规范
    assert.match(resultsCss, /\.data-analysis-semantic-toolbar\s*\{[\s\S]*?display:\s*flex;/);
    assert.match(resultsCss, /\.data-analysis-semantic-controls\s*\{[\s\S]*?display:\s*grid;/);
    assert.match(resultsCss, /#data-analysis-ai-subpanel-semantic\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*row;[\s\S]*?overflow:\s*hidden\s*!important;/, '全量语义分析子面板必须采用横向双栏且无外层滚动条');
    assert.match(resultsCss, /\.data-analysis-semantic-box\s*\{[\s\S]*?flex:\s*0 0 380px;[\s\S]*?overflow-y:\s*auto;/, '左侧配置栏应为固定紧凑宽度并在超出时内部纵向滚动');
    assert.match(resultsCss, /\.data-analysis-semantic-result-wrap\s*\{[\s\S]*?flex:\s*1 1 auto;/, '右侧分析结果容器自适应填满剩余宽度');
    assert.match(resultsCss, /\.data-analysis-semantic-report\s*\{[\s\S]*?max-height:\s*none\s*!important;[\s\S]*?overflow-y:\s*auto;/, '分析报告区域撑满高度并在内部滚动展示');

    // 6. 报告操作工具栏与复制按钮契约
    assert.match(semanticSubpanelHtml, /class="data-analysis-semantic-result-toolbar"/, '右侧结果区域顶部应具备操作工具栏');
    assert.match(semanticSubpanelHtml, /id="data-analysis-semantic-copy-report"/, '右侧结果区域应具备复制报告按钮');
    assert.match(eventsJs, /#data-analysis-semantic-copy-report/, 'events.js 应绑定复制报告点击事件');

    // 7. 全局统一 Tab 样式契约：符合全局绿色主色系与标准 subnav 规范
    assert.match(viewJs, /class="data-analysis-subtabs-nav"[^>]*role="tablist"/, '子 Tab 容器应具备 tablist 语义');
    assert.match(viewJs, /class="data-analysis-subtab active"[^>]*role="tab"/, '子 Tab 按钮应具备 tab 语义');
    assert.match(resultsCss, /\.data-analysis-subtab\.active[^{]*\{[^}]*color:\s*var\(--primary/, '激活态 Tab 文字应统一使用全局主色 var(--primary)');
    assert.doesNotMatch(resultsCss, /\.data-analysis-subtab\.active[^{]*\{[^}]*color:\s*#2563eb/, '不得使用孤立的蓝色 #2563eb');
});

test('数据分析历史记录数据表格具备全局统一分页控件与行高规范契约', () => {
    const viewJs = read('client/chat/data-analysis/view.js');
    const compareHistoryJs = read('client/chat/data-analysis/compare-history.js');
    const contextJs = read('client/chat/data-analysis/context.js');
    const overviewCss = read('client/chat/styles/workspaces/apps/data-analysis-overview.css');

    // 1. context.js 具备历史记录分页状态
    assert.match(contextJs, /historyPage:\s*1/);
    assert.match(contextJs, /historyPageSize:\s*10/);

    // 2. view.js 中包含规范的历史表格包裹层与全局统一分页控件槽位
    assert.match(viewJs, /class="table-container workspace-table-wrap data-analysis-history-table-wrap"/);
    assert.match(viewJs, /id="data-analysis-history-pagination"\s+class="pagination workspace-pagination/);

    // 3. compare-history.js 通过 Pivot 兼容命名空间调用统一分页控件并支持分页切片
    assert.match(compareHistoryJs, /state\.historyPageSize/);
    assert.match(compareHistoryJs, /getElementById\(['"]data-analysis-history-pagination['"]\)/);
    assert.match(compareHistoryJs, /window\.Pivot\.legacy\.renderWorkspacePagination/);

    // 4. CSS 中历史记录表格行高与单元格高度统一为全局 38px，并包含分页控件布局样式
    assert.match(overviewCss, /\.data-analysis-history-table td\s*\{[\s\S]*?height:\s*38px;/);
    assert.match(overviewCss, /\.data-analysis-history-table td\s*\{[\s\S]*?padding:\s*6px 8px;/);
    assert.match(overviewCss, /\.data-analysis-history-pagination\s*\{[\s\S]*?display:\s*flex;/);
});
