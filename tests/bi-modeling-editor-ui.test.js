'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function createHarness() {
    const elements = new Map();
    const register = (id, initialHtml = '') => {
        const el = {
            id,
            innerHTML: initialHtml,
            textContent: '',
            dataset: {},
            classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            replaceWith(next) { elements.set(id, next); }
        };
        elements.set(id, el);
        return el;
    };
    register('data-analysis-modeling-panel');
    register('modeling-list');
    register('modeling-editor');
    register('modeling-title');
    register('modeling-version');
    register('modeling-status');
    register('modeling-save-state');
    register('modeling-content');
    register('modeling-palette-datasets-list');
    register('modeling-dataset-count');
    register('modeling-preview-dock');

    const datasets = [
        {
            id: 'ds_fact',
            name: '学生成绩',
            rowCount: 2,
            columns: [
                { key: 'c_1', name: '学生编号', type: 'varchar' },
                { key: 'c_2', name: '语文成绩', type: 'double' }
            ],
            previewRows: [
                { c_1: 'S001', c_2: 95 },
                { c_1: 'S002', c_2: 88 }
            ]
        },
        {
            id: 'ds_dim',
            name: '班级字典',
            rowCount: 1,
            columns: [{ key: 'c_1', name: '班级编码', type: 'varchar' }],
            previewRows: [{ c_1: 'C1' }]
        }
    ];

    const app = {
        state: { datasets },
        API: '/apps/data-analysis',
        fetchJson: async () => ({}),
        esc: value => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'),
        toast() {}
    };
    const document = {
        hidden: false,
        getElementById: id => elements.get(id) || null,
        querySelector: () => null,
        createElement: () => ({
            firstElementChild: null,
            set innerHTML(val) { this._html = val; },
            get innerHTML() { return this._html || ''; }
        }),
        addEventListener() {}
    };
    const legacy = { PivotDataAnalysis: app, currentUser: { id: 1 } };
    const context = {
        window: { Pivot: { legacy }, crypto, addEventListener() {} },
        document,
        PivotSafeHtml: { setHtml(el, val) { el.innerHTML = val; } },
        setTimeout,
        clearTimeout,
        Event: globalThis.Event,
        URLSearchParams
    };

    for (const file of ['modeling-state.js', 'modeling-view.js', 'modeling-preview.js', 'modeling-operators.js', 'modeling-canvas.js', 'modeling.js']) {
        vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis', file), 'utf8'), context);
    }

    const m = app.modeling;
    const realRender = m.render;
    m.render = () => {};
    m.renderSaveState = () => {};
    m.columns = nodeId => {
        const node = m.state.draft?.nodes?.find(item => item.id === nodeId);
        return datasets.find(ds => ds.id === node?.datasetId)?.columns || [];
    };
    Object.assign(m.state, {
        selected: { id: 'model_1', name: '测试模型', isOwner: true, lifecycle: 'draft', version: 1, sources: [] },
        draft: {
            nodes: [{ id: 'fact', role: 'fact', name: '学生成绩', datasetId: 'ds_fact', grainKeys: [] }],
            relations: [],
            dimensions: [{ id: 'dim_1', name: '学生编号', nodeId: 'fact', fieldKey: 'c_1', logicalType: 'text' }],
            metrics: [{ id: 'met_1', name: '语文成绩合计', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_2' } }]
        },
        selectedNodeId: 'fact',
        previewOpen: true,
        previewNodeId: 'fact'
    });

    return { m, app, realRender, elements };
}

test('字段列表就地切换主键直接更新模型节点主键并保留只读保护', async () => {
    const { m } = createHarness();
    await m.action('toggle-grain-key', 'fact:c_1');
    assert.deepEqual(Array.from(m.state.draft.nodes[0].grainKeys), ['c_1']);
    assert.equal(m.state.dirty, true);
    assert.equal(m.state.saveState, 'unsaved');

    await m.action('toggle-grain-key', 'fact:c_1');
    assert.deepEqual(Array.from(m.state.draft.nodes[0].grainKeys), []);

    m.state.selected.isOwner = false;
    await assert.rejects(() => m.action('toggle-grain-key', 'fact:c_1'), /只读/);
});

test('执行器未启用时预览面板提供来源本地样本兜底与字段结构切换，且不污染执行结果状态', async () => {
    const { m } = createHarness();
    m.state.previewError = '数据建模执行服务尚未启用，请联系维护者配置隔离执行器。草稿仍可保存。';
    const errDock = m.renderPreviewDock();
    assert.match(errDock, /modeling-preview-error-card/);
    assert.match(errDock, /本地样本（2 行）/);
    assert.match(errDock, /字段结构/);

    await m.action('preview-toggle-local-sample', '');
    assert.equal(m.state.previewLocalSample, true);
    assert.equal(m.state.previewData, null);
    const sampleDock = m.renderPreviewDock();
    assert.match(sampleDock, /非隔离执行器计算结果/);
    assert.match(sampleDock, /S001/);
    assert.match(sampleDock, /95/);

    await m.action('toggle-grain-key', 'fact:c_1');
    await m.action('preview-tab', 'schema');
    assert.equal(m.state.previewTab, 'schema');
    const schemaDock = m.renderPreviewDock();
    assert.match(schemaDock, /学生编号/);
    assert.match(schemaDock, /主键/);
    assert.match(schemaDock, /维度/);
    assert.match(schemaDock, /指标/);
});

test('可用数据集搜索局部更新列表并正确区分已加入与可添加数据集', () => {
    const { m, elements } = createHarness();
    const initial = m.canvasPalette();
    assert.match(initial, /学生成绩/);
    assert.match(initial, /已加入/);
    assert.match(initial, /班级字典/);
    assert.match(initial, /1 列/);

    m.state.datasetSearch = '班级';
    m.updateDatasetPaletteDom();
    const listHtml = elements.get('modeling-palette-datasets-list').innerHTML;
    assert.match(listHtml, /班级字典/);
    assert.doesNotMatch(listHtml, /学生成绩/);
    assert.equal(elements.get('modeling-dataset-count').textContent, '1 / 2');
});

test('可用数据集过多时支持分段加载与仅未加入筛选，且抽屉关闭按钮与全模式等宽正确', async () => {
    const { m, app, realRender, elements } = createHarness();
    for (let idx = 1; idx <= 35; idx++) {
        app.state.datasets.push({
            id: `ds_extra_${idx}`,
            name: `额外指标表_${idx}`,
            rowCount: 10,
            columns: [{ key: 'c_1', name: '编码', type: 'varchar' }]
        });
    }

    // 验证 > 30 个数据集时首屏截断为 30 个，并提供展开更多按钮
    m.updateDatasetPaletteDom();
    let listHtml = elements.get('modeling-palette-datasets-list').innerHTML;
    assert.match(listHtml, /展开更多（剩余 7 个）/);
    assert.doesNotMatch(listHtml, /额外指标表_35/);
    assert.equal(elements.get('modeling-dataset-count').textContent, '37 个');

    await m.action('dataset-show-more', '');
    assert.equal(m.state.datasetDisplayLimit, 60);
    listHtml = elements.get('modeling-palette-datasets-list').innerHTML;
    assert.match(listHtml, /额外指标表_35/);
    assert.doesNotMatch(listHtml, /展开更多/);

    await m.action('dataset-filter-unused', '');
    assert.equal(m.state.datasetFilterMode, 'unused');
    listHtml = elements.get('modeling-palette-datasets-list').innerHTML;
    assert.match(listHtml, /班级字典/);
    assert.doesNotMatch(listHtml, /学生成绩/);
    assert.equal(elements.get('modeling-dataset-count').textContent, '36 / 37');

    // 验证所有抽屉标签模式保持统一宽度、右上角关闭按钮为红色字体和边框且状态栏不展示业务时区
    m.state.draft.timezone = 'Asia/Shanghai';
    for (const drawerMode of ['node', 'semantics', 'quality', 'trial']) {
        m.state.drawerOpen = true;
        m.state.drawerMode = drawerMode;
        realRender();
        const studioHtml = elements.get('modeling-content').innerHTML;
        assert.doesNotMatch(studioHtml, /has-wide-drawer/);
        assert.doesNotMatch(studioHtml, /\bis-wide\b/);
        assert.match(studioHtml, /class="btn-danger-outline modeling-drawer-close"[^>]*data-modeling-action="close-drawer"[^>]*>关闭<\/button>/);
    }
    assert.doesNotMatch(elements.get('modeling-status').textContent, /业务时区/);
    assert.match(elements.get('modeling-status').textContent, /所有者可编辑/);
});
