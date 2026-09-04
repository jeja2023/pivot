const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
    const classes = new Set();
    return {
        value: '',
        checked: false,
        options: [],
        dataset: {},
        disabled: false,
        textContent: '',
        innerHTML: '',
        classList: {
            add(...names) { names.forEach(n => classes.add(n)); },
            remove(...names) { names.forEach(n => classes.delete(n)); },
            toggle(name, force) {
                if (force === undefined) {
                    if (classes.has(name)) classes.delete(name);
                    else classes.add(name);
                } else if (force) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
            contains(name) { return classes.has(name); }
        },
        dispatchEvent() {},
        setAttribute() {},
        scrollIntoView() {}
    };
}

function createAiHistoryHarness() {
    const elements = new Map([
        ['data-analysis-ai-subpanel-chat', makeElement()],
        ['data-analysis-ai-subpanel-semantic', makeElement()],
        ['data-analysis-ai-landing', makeElement()],
        ['data-analysis-ai-result-wrap', makeElement()],
        ['data-analysis-ai-prompt', makeElement()],
        ['data-analysis-ai-clear-prompt', makeElement()],
        ['data-analysis-ai-deep', makeElement()],
        ['data-analysis-ai-result-time', makeElement()],
        ['data-analysis-ai-result', makeElement()],
        ['data-analysis-ai-dataset', makeElement()],
        ['data-analysis-ai-dataset-meta', makeElement()],
        ['data-analysis-ai-profile-content', makeElement()],
        ['data-analysis-ai-stop', makeElement()],
        ['data-analysis-ai-run', makeElement()]
    ]);

    // 初始状态：引导看板显示，结果展示区域默认隐藏（有 hidden class）
    elements.get('data-analysis-ai-result-wrap').classList.add('hidden');
    elements.get('data-analysis-ai-clear-prompt').classList.add('hidden');

    const subtabs = [
        { ...makeElement(), dataset: { aiSubtab: 'chat' } },
        { ...makeElement(), dataset: { aiSubtab: 'semantic' } }
    ];

    const state = {
        activeId: 'dataset-1',
        datasets: [
            {
                id: 'dataset-1',
                name: '销售数据表',
                columns: [{ key: 'sales', name: '销售额', type: 'double' }, { key: 'region', name: '大区', type: 'varchar' }],
                rowCount: 500
            },
            {
                id: 'dataset-2',
                name: '财务月报',
                columns: [{ key: 'cost', name: '成本', type: 'double' }],
                rowCount: 200
            }
        ],
        artifacts: [],
        aiBusy: false,
        aiWorkspaceEpoch: 0
    };

    const renderedCharts = [];
    const calls = [];

    const mockDataset2 = {
        id: 'dataset-2',
        name: '财务月报',
        columns: [{ key: 'cost', name: '成本', type: 'double' }],
        rowCount: 200
    };

    const app = {
        API: '/api/apps/data-analysis',
        state,
        html: { escapeAttr: str => String(str).replace(/"/g, '&quot;') },
        esc: val => String(val ?? ''),
        fmtNumber: val => String(val),
        activeDataset: () => state.datasets.find(d => d.id === state.activeId) || null,
        fetchJson: async url => {
            calls.push(url);
            if (url.includes('/datasets/dataset-2')) return { dataset: mockDataset2 };
            throw new Error(`Unexpected url: ${url}`);
        },
        guardButton: async (_id, _label, fn) => fn(),
        toast: () => {},
        setSelectOptions: () => {},
        buildOptions: () => ''
    };

    const context = {
        window: {
            PivotDataAnalysis: app,
            renderPivotCharts: el => { renderedCharts.push(el); },
            matchMedia: () => ({ matches: false })
        },
        document: {
            getElementById: id => elements.get(id) || null,
            querySelectorAll: selector => {
                if (selector === '.data-analysis-subtab') return subtabs;
                return [];
            }
        },
        Event: class { constructor(type) { this.type = type; } },
        PivotSafeHtml: {
            setHtml(el, markup) {
                if (el) el.innerHTML = String(markup);
            }
        },
        renderMarkdown: text => `<p>${text}</p>`,
        console,
        setInterval,
        clearInterval,
        setTimeout,
        Array,
        String,
        Number,
        Boolean,
        Set,
        JSON,
        encodeURIComponent
    };

    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'ai.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'client/chat/data-analysis/ai.js' });

    return { app, elements, state, subtabs, renderedCharts, calls };
}

test('openAiAnalysisHistoryRecord 正确解隐结果容器、隐藏引导看板并完整回填输入与表单状态', async () => {
    const { app, elements } = createAiHistoryHarness();

    const historyItem = {
        id: 'art-1',
        datasetId: 'dataset-1',
        type: 'ai_analysis',
        title: '分析各大区销售额及异常波动',
        createdAt: '2026-09-04T10:15:30.000Z',
        metadata: { mode: 'agent' },
        analysis: {
            prompt: '分析各大区销售额及异常波动',
            answer: '华东区销售额占比达 45%，总体呈现稳定上升态势。',
            steps: [
                { tool: 'run_sql', input: { sql: 'SELECT region, SUM(sales) FROM data GROUP BY region' }, summary: '返回 4 行', status: 'success' }
            ],
            evidence: [
                { sql: 'SELECT region, SUM(sales) FROM data GROUP BY region', rowCount: 4, truncated: false }
            ],
            charts: [
                { title: '各大区销售额分布', chartType: 'bar', xAxis: { field: 'region' }, yAxis: { field: 'sales' } }
            ]
        }
    };

    await app.openAiAnalysisHistoryRecord(historyItem);

    // 1. 引导看板必须隐藏，结果容器必须解除隐藏
    assert.equal(elements.get('data-analysis-ai-landing').classList.contains('hidden'), true);
    assert.equal(elements.get('data-analysis-ai-result-wrap').classList.contains('hidden'), false);

    // 2. 输入框完整回填提问内容，清空按钮点亮，深度分析勾选
    assert.equal(elements.get('data-analysis-ai-prompt').value, '分析各大区销售额及异常波动');
    assert.equal(elements.get('data-analysis-ai-clear-prompt').classList.contains('hidden'), false);
    assert.equal(elements.get('data-analysis-ai-deep').checked, true);

    // 3. 结果头部元信息更新为深度分析历史记录及对应时间
    assert.match(elements.get('data-analysis-ai-result-time').textContent, /深度分析历史记录/);
    assert.match(elements.get('data-analysis-ai-result-time').textContent, /2026-09-04 10:15:30/);

    // 4. 结果容器包含分析诉求卡片、Markdown 回答、执行过程与数据依据
    const resultHtml = elements.get('data-analysis-ai-result').innerHTML;
    assert.match(resultHtml, /class="data-analysis-ai-question-card"/);
    assert.match(resultHtml, /分析诉求/);
    assert.match(resultHtml, /分析各大区销售额及异常波动/);
    assert.match(resultHtml, /华东区销售额占比达 45%/);
    assert.match(resultHtml, /class="data-analysis-ai-steps"/);
    assert.match(resultHtml, /class="data-analysis-ai-evidence"/);
    assert.match(resultHtml, /class="pivot-echart-block"/);
});

test('openAiAnalysisHistoryRecord 支持跨数据集同步加载并更新激活状态', async () => {
    const { app, elements, state, calls } = createAiHistoryHarness();

    const historyItem = {
        id: 'art-2',
        datasetId: 'dataset-2',
        type: 'ai_analysis',
        title: '分析成本支出走势',
        createdAt: '2026-09-04T11:00:00.000Z',
        metadata: { mode: 'summary' },
        analysis: {
            prompt: '分析成本支出走势',
            answer: '各项支出均在预算范围内。',
            scope: 'profile'
        }
    };

    // 移除 dataset-2 模拟首次访问未缓存数据集
    state.datasets = state.datasets.filter(d => d.id !== 'dataset-2');
    assert.equal(state.activeId, 'dataset-1');
    await app.openAiAnalysisHistoryRecord(historyItem, 'dataset-2');

    // 跨数据集时应同步更新 activeId
    assert.equal(state.activeId, 'dataset-2');
    assert.ok(calls.some(url => url.includes('/datasets/dataset-2')));

    // 即时探索模式：深度开关不勾选，头部标明即时探索历史记录
    assert.equal(elements.get('data-analysis-ai-deep').checked, false);
    assert.match(elements.get('data-analysis-ai-result-time').textContent, /即时探索历史记录/);

    // 结果包含分析诉求及画像提示，且不包含错误的无查询依据红字
    const resultHtml = elements.get('data-analysis-ai-result').innerHTML;
    assert.match(resultHtml, /各项支出均在预算范围内/);
    assert.match(resultHtml, /data-analysis-ai-scope-notice/);
    assert.doesNotMatch(resultHtml, /data-analysis-ai-no-evidence/);
});

test('openAiAnalysisHistoryRecord 兼容遗留纯文本历史记录', async () => {
    const { app, elements } = createAiHistoryHarness();

    const legacyItem = {
        id: 'art-legacy',
        datasetId: 'dataset-1',
        type: 'ai_analysis',
        title: '遗留分析条目',
        createdAt: '2026-09-04T09:00:00.000Z',
        analysis: '这是一段旧版本纯文本形式保存的分析结论。'
    };

    await app.openAiAnalysisHistoryRecord(legacyItem);

    assert.equal(elements.get('data-analysis-ai-landing').classList.contains('hidden'), true);
    assert.equal(elements.get('data-analysis-ai-result-wrap').classList.contains('hidden'), false);
    assert.equal(elements.get('data-analysis-ai-prompt').value, '遗留分析条目');

    const resultHtml = elements.get('data-analysis-ai-result').innerHTML;
    assert.match(resultHtml, /这是一段旧版本纯文本形式保存的分析结论/);
});
