const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function createSessionStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

function createElement(id, tab) {
    const classes = new Set(id === 'data-analysis-overview-panel' || tab === 'overview' ? ['active'] : []);
    return {
        id,
        dataset: tab ? { dataAnalysisTab: tab } : {},
        value: '',
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        }
    };
}

function createNavigationHarness() {
    const sessionStorage = createSessionStorage();
    const window = { sessionStorage, Pivot: { legacy: {} } };
    const context = { window, String, Number, Set };
    vm.runInNewContext(read('client/chat/data-analysis/context.js'), context, {
        filename: 'client/chat/data-analysis/context.js'
    });

    const tabs = ['overview', 'cleaning', 'chart', 'compare', 'query', 'pivot', 'ai', 'history']
        .map(tab => createElement('', tab));
    const panels = tabs.map(tab => createElement(`data-analysis-${tab}-panel`));
    const elements = new Map([
        ['data-analysis-query-sql', createElement('data-analysis-query-sql')],
        ['data-analysis-query-mode-visual', createElement('data-analysis-query-mode-visual')],
        ['data-analysis-query-mode-sql', createElement('data-analysis-query-mode-sql')],
        ['data-analysis-query-visual-box', createElement('data-analysis-query-visual-box')],
        ['data-analysis-query-sql-box', createElement('data-analysis-query-sql-box')]
    ]);
    const document = {
        querySelector(selector) {
            if (selector === '.data-analysis-tab.active') return tabs.find(tab => tab.classList.contains('active')) || null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.data-analysis-tab') return tabs;
            if (selector === '.data-analysis-tab-panel') return panels;
            return [];
        },
        getElementById(id) { return elements.get(id) || null; }
    };
    context.document = document;
    const app = context.window.Pivot.legacy.PivotDataAnalysis;
    app.updateToolbarHeader = () => {};
    app.renderVisualQueryControls = () => {};
    app.renderQuery = () => {};
    app.renderChart = () => {};
    app.renderCompare = () => {};
    app.renderCompareKeyOptions = () => {};
    app.renderPivot = () => {};
    app.renderHistory = () => {};
    app.resetAiWorkspace = () => {};
    app.resumeAiWorkspace = () => {};
    vm.runInNewContext(read('client/chat/data-analysis/events.js'), context, {
        filename: 'client/chat/data-analysis/events.js'
    });
    return { app, sessionStorage };
}

test('数据分析页签刷新时恢复当前页，并在切换后清空上一页的临时查询结果', () => {
    const { app, sessionStorage } = createNavigationHarness();
    const { state } = app;

    app.activateTab('query');
    assert.equal(sessionStorage.getItem('pivot_data_analysis_active_tab'), 'query');
    assert.equal(app.getStoredActiveTab(), 'query');

    state.query = { rows: [{ id: 1 }] };
    state.queryPage = 3;
    state.queryMode = 'sql';
    state.visualQuery.filters[0].value = '旧条件';
    app.activateTab('chart');

    assert.equal(state.query, null);
    assert.equal(state.queryPage, 1);
    assert.equal(state.queryMode, 'visual');
    assert.equal(state.visualQuery.filters.length, 1);
    assert.equal(state.visualQuery.filters[0].field, '');
    assert.equal(state.visualQuery.filters[0].operator, 'eq');
    assert.equal(state.visualQuery.filters[0].value, '');
    assert.equal(sessionStorage.getItem('pivot_data_analysis_active_tab'), 'chart');

    state.chart = { title: '旧图表' };
    app.activateTab('pivot');
    assert.equal(state.chart, null);

    state.pivot = { rows: [{ label: '旧透视结果' }] };
    app.activateTab('ai');
    assert.equal(state.pivot, null);

    let resetAiCalls = 0;
    app.resetAiWorkspace = () => { resetAiCalls += 1; };
    app.activateTab('history');
    assert.equal(resetAiCalls, 1);

    state.artifacts = [{ id: 'old-artifact' }];
    app.activateTab('overview');
    assert.equal(state.artifacts.length, 0);
});

test('无效的已存页签安全回退到数据总览', () => {
    const { app, sessionStorage } = createNavigationHarness();
    sessionStorage.setItem('pivot_data_analysis_active_tab', 'unknown-tab');

    assert.equal(app.getStoredActiveTab(), 'overview');
});

test('数据清洗页签可被保存恢复，离开时会清理临时规则与预览', () => {
    const { app, sessionStorage } = createNavigationHarness();
    let resetCalls = 0;
    app.resetCleaningWorkspace = () => { resetCalls += 1; };

    app.activateTab('cleaning');
    assert.equal(sessionStorage.getItem('pivot_data_analysis_active_tab'), 'cleaning');
    assert.equal(app.getStoredActiveTab(), 'cleaning');

    app.activateTab('chart');
    assert.equal(resetCalls, 1);
});

test('数据分析入口未指定页签时使用已保存的页签', () => {
    const core = read('client/chat/data-analysis/core.js');

    assert.match(core, /const requestedTab = normalizeTab\(explicitTab \|\| getStoredActiveTab\(\)\);/);
});
