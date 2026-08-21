const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createClientEnvironment() {
    const sandbox = {
        console,
        window: {
            _cachedAgentModels: [],
            PivotSafeHtml: {
                setHtml: (el, html) => { if (el) el.innerHTML = html; }
            }
        },
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } }),
            body: { appendChild: () => {} }
        },
        currentUser: { id: 1, role: 'admin' },
        API_BASE: '/api',
        apiFetch: async () => ({ ok: true, json: async () => ({}) }),
        renderMarkdown: text => `<div class="md">${text}</div>`,
        agentEscape: text => String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'),
        agentEscapeAttr: text => String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;'),
        agentShortText: (text, max = 100) => String(text ?? '').slice(0, max),
        agentParsePayload: value => {
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string') return value;
            try { return JSON.parse(value); } catch (_) { return value; }
        },
        agentLooksLikeCorruptTitle: () => false
    };

    vm.createContext(sandbox);

    const toolLabelsCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-tool-labels.js'), 'utf8');
    const utilsCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-utils.js'), 'utf8');
    const stepRenderersCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-step-renderers.js'), 'utf8');
    const visualsCode = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agent-run-visuals.js'), 'utf8');

    vm.runInContext(toolLabelsCode, sandbox);
    vm.runInContext(utilsCode, sandbox);
    vm.runInContext(stepRenderersCode, sandbox);
    vm.runInContext(visualsCode, sandbox);

    return sandbox;
}

test('富文本内容校对节点输出全面中文化', () => {
    const env = createClientEnvironment();

    const mockReviewPayload = {
        type: 'content_review_report',
        status: 'completed',
        reviewComplete: true,
        stats: {
            sourceRowCount: 0,
            processedRecords: 0,
            skippedRecords: 0,
            completedRecords: 0,
            passedRecords: 0,
            issueRecords: 0,
            incompleteRecords: 0,
            titleIssues: 0,
            contentIssues: 0,
            originalChars: 0,
            cleanChars: 0,
            modelCallCount: 0,
            chunkTokens: 3000,
            overlapTokens: 80,
            upstreamPartial: false,
            oversizedRowCount: 0,
            inputTruncated: false
        },
        records: [],
        artifact: {
            id: 56,
            title: '新闻内容校对报告',
            type: 'content_review_report'
        },
        warnings: [],
        text: '## 新闻内容校对报告\n- 待审核记录：0 条\n- 完整报告：已保存到任务产物 #56'
    };

    const rendered = env.agentResultReadableMarkup(mockReviewPayload);

    // 验证核心标题与标签已全面中文化
    assert.ok(rendered.includes('类型'), '必须包含“类型”字段');
    assert.ok(rendered.includes('内容校对报告'), 'content_review_report 必须显示为“内容校对报告”');
    assert.ok(rendered.includes('校对完成'), 'reviewComplete 必须显示为“校对完成”');
    assert.ok(rendered.includes('指标统计'), 'stats 必须显示为“指标统计”');
    assert.ok(rendered.includes('原始数据行数'), 'sourceRowCount 必须显示为“原始数据行数”');
    assert.ok(rendered.includes('已处理记录数'), 'processedRecords 必须显示为“已处理记录数”');
    assert.ok(rendered.includes('已跳过记录数'), 'skippedRecords 必须显示为“已跳过记录数”');
    assert.ok(rendered.includes('已完成记录数'), 'completedRecords 必须显示为“已完成记录数”');
    assert.ok(rendered.includes('无问题记录数'), 'passedRecords 必须显示为“无问题记录数”');
    assert.ok(rendered.includes('存在问题记录数'), 'issueRecords 必须显示为“存在问题记录数”');
    assert.ok(rendered.includes('未完整处理记录数'), 'incompleteRecords 必须显示为“未完整处理记录数”');
    assert.ok(rendered.includes('标题问题数'), 'titleIssues 必须显示为“标题问题数”');
    assert.ok(rendered.includes('正文问题数'), 'contentIssues 必须显示为“正文问题数”');
    assert.ok(rendered.includes('原始字符数'), 'originalChars 必须显示为“原始字符数”');
    assert.ok(rendered.includes('清洗后字符数'), 'cleanChars 必须显示为“清洗后字符数”');
    assert.ok(rendered.includes('模型调用次数'), 'modelCallCount 必须显示为“模型调用次数”');
    assert.ok(rendered.includes('分块 Token 预算'), 'chunkTokens 必须显示为“分块 Token 预算”');
    assert.ok(rendered.includes('重叠 Token 数'), 'overlapTokens 必须显示为“重叠 Token 数”');
    assert.ok(rendered.includes('上游数据截断'), 'upstreamPartial 必须显示为“上游数据截断”');
    assert.ok(rendered.includes('超长记录数'), 'oversizedRowCount 必须显示为“超长记录数”');
    assert.ok(rendered.includes('输入已截断'), 'inputTruncated 必须显示为“输入已截断”');
    assert.ok(rendered.includes('校对明细'), 'records 必须显示为“校对明细”');
    assert.ok(rendered.includes('任务产物'), 'artifact 必须显示为“任务产物”');

    // 确保没有出现英文驼峰或原始未翻译词汇
    assert.ok(!rendered.includes('Review Complete'), '不能残留英文 Review Complete');
    assert.ok(!rendered.includes('Source Row Count'), '不能残留英文 Source Row Count');
    assert.ok(!rendered.includes('Processed Records'), '不能残留英文 Processed Records');
    assert.ok(!rendered.includes('Skipped Records'), '不能残留英文 Skipped Records');
    assert.ok(!rendered.includes('Completed Records'), '不能残留英文 Completed Records');
    assert.ok(!rendered.includes('Passed Records'), '不能残留英文 Passed Records');
    assert.ok(!rendered.includes('Incomplete Records'), '不能残留英文 Incomplete Records');
    assert.ok(!rendered.includes('Title Issues'), '不能残留英文 Title Issues');
    assert.ok(!rendered.includes('Content Issues'), '不能残留英文 Content Issues');
});

test('DAG 节点执行条件与状态中文化', () => {
    const env = createClientEnvironment();

    assert.strictEqual(env.agentDagConditionLabel('success'), '上游成功时');
    assert.strictEqual(env.agentDagConditionLabel('always'), '始终执行');
    assert.strictEqual(env.agentDagConditionLabel('failure'), '上游失败时');
    assert.strictEqual(env.agentDagConditionLabel('error'), '上游异常时');
    assert.strictEqual(env.agentDagConditionLabel(''), '无限制');

    assert.strictEqual(env.agentStatusLabel('queued'), '排队中');
    assert.strictEqual(env.agentStatusLabel('running'), '运行中');
    assert.strictEqual(env.agentStatusLabel('completed'), '已完成');
    assert.strictEqual(env.agentStatusLabel('error'), '失败');
    assert.strictEqual(env.agentStatusLabel('continued_error'), '失败后继续');
    assert.strictEqual(env.agentStatusLabel('skipped'), '已跳过');
    assert.strictEqual(env.agentStatusLabel('issues_found'), '存在问题');
    assert.strictEqual(env.agentStatusLabel('passed'), '未发现问题');
    assert.strictEqual(env.agentStatusLabel('incomplete'), '未完整处理');
});

test('所有工作流与智能体工具标题本地化', () => {
    const env = createClientEnvironment();

    const tools = [
        ['agent.llm', '大模型节点'],
        ['agent.content_review', '富文本内容校对'],
        ['agent.delegate', '委派智能体'],
        ['agent.handoff', '智能体交接'],
        ['agent.code', '代码执行'],
        ['agent.http', 'HTTP 请求'],
        ['agent.merge', '变量聚合'],
        ['workflow.input', '工作流输入'],
        ['workflow.output', '工作流输出'],
        ['workflow.condition', '条件路由'],
        ['workflow.approval', '人工审批'],
        ['workflow.foreach', '循环 / 批处理'],
        ['workflow.subworkflow', '子工作流'],
        ['workflow.delay', '延时等待'],
        ['report.compose', '报告编排'],
        ['rag.search', '知识库检索'],
        ['knowledge.graph.query', '知识图谱查询'],
        ['reports.list_files', '列出报表文件'],
        ['im.send_user_message', '发送私聊消息'],
        ['code.python_execute', 'Python 脚本执行'],
        ['browser.navigate', '浏览器访问页面'],
        ['filesystem.read_workspace', '读取工作区文件']
    ];

    for (const [toolName, expectedTitle] of tools) {
        assert.strictEqual(env.agentToolTitle(toolName), expectedTitle, `工具 ${toolName} 必须有中文标题`);
    }
});
