const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
    return {
        value: '',
        options: [],
        dataset: {},
        disabled: false,
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {} }
    };
}

function installOptions(element, markup, selected) {
    const options = Array.from(String(markup).matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g))
        .map(([, value, label]) => ({ value, textContent: label }));
    element.options = options;
    element.innerHTML = String(markup);
    element.value = options.some(option => option.value === String(selected || '')) ? String(selected || '') : '';
}

function createSemanticHistoryHarness() {
    const elements = new Map([
        ['data-analysis-semantic-dataset', makeElement()],
        ['data-analysis-semantic-job', makeElement()],
        ['data-analysis-semantic-field', makeElement()],
        ['data-analysis-semantic-id-field', makeElement()],
        ['data-analysis-semantic-instruction', makeElement()],
        ['data-analysis-semantic-batch-tokens', makeElement()],
        ['data-analysis-semantic-status', makeElement()],
        ['data-analysis-semantic-progress', makeElement()],
        ['data-analysis-semantic-report', makeElement()],
        ['data-analysis-semantic-copy-report', makeElement()],
        ['data-analysis-semantic-run', makeElement()],
        ['data-analysis-semantic-cancel', makeElement()],
        ['data-analysis-semantic-retry', makeElement()]
    ]);
    const completedJob = {
        id: 'sem-history-1',
        datasetId: 'dataset-1',
        status: 'succeeded',
        textField: 'content',
        idField: 'record_id',
        instruction: '提取风险项',
        totalRows: 3,
        analyzedRows: 3,
        totalChars: 80,
        totalBatches: 1,
        completedBatches: 1,
        progress: 100,
        report: '历史汇总报告',
        result: { report: '历史汇总报告' },
        options: { textFieldName: '正文', batchTokens: 24000 },
        createdAt: '2026-09-04T10:30:00.000Z'
    };
    const calls = [];
    const state = {
        datasets: [{
            id: 'dataset-1',
            columns: [{ key: 'content', name: '正文' }, { key: 'record_id', name: '记录 ID' }],
            profile: [{ key: 'content', type: 'text' }, { key: 'record_id', type: 'text' }]
        }],
        semanticDatasetId: 'dataset-1',
        semanticJobs: [],
        semanticJob: null,
        semanticSelectedJobId: '',
        semanticLoadVersion: 0,
        semanticPollTimer: null
    };
    const app = {
        API: '/api/apps/data-analysis',
        state,
        fetchJson: async url => {
            calls.push(url);
            if (url.includes('/semantic-analysis/jobs?')) return { jobs: [completedJob] };
            if (url.endsWith('/semantic-analysis/jobs/sem-history-1')) return { job: completedJob };
            if (url.endsWith('/datasets/dataset-1')) return { dataset: state.datasets[0] };
            throw new Error(`未预期的请求：${url}`);
        },
        guardButton: async (_id, _label, fn) => fn(),
        toast() {},
        setSelectOptions(id, markup, value) {
            installOptions(elements.get(id), markup, value);
        },
        buildOptions(columns, options = {}) {
            const values = options.includeEmpty ? [`<option value="">${options.emptyLabel || ''}</option>`] : [];
            columns.forEach(column => values.push(`<option value="${column.key}">${column.name}</option>`));
            return values.join('');
        },
        esc(value) { return String(value ?? ''); },
        fmtNumber(value) { return String(value); },
        activeDataset() { return null; }
    };
    installOptions(elements.get('data-analysis-semantic-dataset'), '<option value="dataset-1">测试数据集</option>', 'dataset-1');
    const context = {
        window: { PivotDataAnalysis: app },
        document: { getElementById: id => elements.get(id) || null },
        PivotSafeHtml: { setHtml(element, markup) { element.innerHTML = String(markup); } },
        renderMarkdown: value => `<p>${value}</p>`,
        console,
        setInterval,
        clearInterval,
        Array,
        String,
        Number,
        Set,
        encodeURIComponent
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'data-analysis', 'ai.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'client/chat/data-analysis/ai.js' });
    return { app, calls, completedJob, elements, state };
}

test('全量语义分析加载数据集后可选择并回放已完成历史任务', async () => {
    const { app, calls, elements, state } = createSemanticHistoryHarness();

    await app.loadSemanticJobs('dataset-1');

    assert.equal(state.semanticSelectedJobId, 'sem-history-1');
    assert.equal(state.semanticJob?.report, '历史汇总报告');
    assert.equal(elements.get('data-analysis-semantic-job').value, 'sem-history-1');
    assert.equal(elements.get('data-analysis-semantic-dataset').value, 'dataset-1');
    assert.match(elements.get('data-analysis-semantic-report').innerHTML, /历史汇总报告/);
    assert.equal(elements.get('data-analysis-semantic-copy-report').disabled, false);
    assert.equal(elements.get('data-analysis-semantic-instruction').value, '提取风险项');
    assert.ok(calls.some(url => url.includes('semantic-analysis/jobs?limit=100')));
    assert.ok(calls.some(url => url.endsWith('/semantic-analysis/jobs/sem-history-1')));
});

test('历史记录入口按任务标识恢复所属数据集和完整任务详情', async () => {
    const { app, elements, state } = createSemanticHistoryHarness();
    state.semanticDatasetId = '';

    await app.openSemanticHistoryRecord({
        datasetId: 'dataset-1',
        semantic: { jobId: 'sem-history-1', report: 'artifact 回退报告' }
    }, 'dataset-1');

    assert.equal(state.semanticDatasetId, 'dataset-1');
    assert.equal(state.semanticSelectedJobId, 'sem-history-1');
    assert.equal(state.semanticJob?.instruction, '提取风险项');
    assert.equal(elements.get('data-analysis-semantic-field').value, 'content');
});
