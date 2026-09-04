const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function createHistoryPaginationHarness() {
    const elements = new Map();
    function getOrCreate(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                innerHTML: '',
                children: [],
                replaceChildren(...newChildren) {
                    this.children = newChildren;
                    this.innerHTML = '';
                }
            });
        }
        return elements.get(id);
    }

    const box = getOrCreate('data-analysis-history-result');
    const pager = getOrCreate('data-analysis-history-pagination');

    let lastPaginationOptions = null;
    const window = {
        renderWorkspacePagination(containerOrId, options) {
            lastPaginationOptions = options;
            const container = typeof containerOrId === 'string' ? getOrCreate(containerOrId) : containerOrId;
            const total = Math.max(Number(options.total || 0), 0);
            const limit = Math.max(Number(options.limit || 10), 1);
            const page = Math.max(Number(options.page || 1), 1);
            const totalPages = Math.max(Math.ceil(total / limit), 1);
            container.replaceChildren();
            if (totalPages <= 1) return;
            container.innerHTML = `<span class="summary">第 ${page} / ${totalPages} 页（共 ${total} 条，每页 ${limit} 条）</span>`;
        }
    };

    const context = {
        window,
        document: {
            getElementById(id) { return elements.get(id) || null; }
        },
        PivotSafeHtml: {
            setHtml(el, html) {
                if (el) el.innerHTML = String(html);
            }
        },
        String,
        Number,
        Set,
        Array,
        Math,
        encodeURIComponent
    };

    vm.runInNewContext(read('client/chat/data-analysis/context.js'), context, {
        filename: 'client/chat/data-analysis/context.js'
    });

    const app = context.window.PivotDataAnalysis;
    app.fetchJson = async () => ({ artifacts: [] });

    vm.runInNewContext(read('client/chat/data-analysis/compare-history.js'), context, {
        filename: 'client/chat/data-analysis/compare-history.js'
    });

    return {
        app,
        box,
        pager,
        getLastPaginationOptions: () => lastPaginationOptions
    };
}

test('数据分析历史记录默认分页参数与空数据处理', () => {
    const { app, box, pager, getLastPaginationOptions } = createHistoryPaginationHarness();

    assert.equal(app.state.historyPage, 1);
    assert.equal(app.state.historyPageSize, 10);

    app.state.artifacts = [];
    app.renderHistory();

    assert.match(box.innerHTML, /暂无历史记录/);
    assert.equal(pager.children.length, 0);
    assert.equal(getLastPaginationOptions(), null);
});

test('数据分析历史记录不超过一页时不展示分页控件', () => {
    const { app, box, pager, getLastPaginationOptions } = createHistoryPaginationHarness();

    app.state.artifacts = [
        { type: 'chart', title: '图表 1', createdAt: '2026-09-04 10:00:00', chart: {} },
        { type: 'query', title: '查询 2', createdAt: '2026-09-04 10:01:00' },
        { type: 'pivot', title: '透视 3', createdAt: '2026-09-04 10:02:00' }
    ];

    app.renderHistory();

    assert.match(box.innerHTML, /data-analysis-history-table/);
    assert.match(box.innerHTML, /图表 1/);
    assert.match(box.innerHTML, /透视 3/);
    const pagination = getLastPaginationOptions();
    assert.ok(pagination);
    assert.equal(pagination.total, 3);
    assert.equal(pagination.page, 1);
    // 单页时 renderWorkspacePagination 会清空容器
    assert.equal(pager.innerHTML, '');
});

test('数据分析历史记录超过一页时切片渲染，且操作按钮索引正确映射回原始条目', () => {
    const { app, box, pager, getLastPaginationOptions } = createHistoryPaginationHarness();

    // 生成 25 条历史记录
    app.state.artifacts = Array.from({ length: 25 }, (_, i) => ({
        type: 'chart',
        title: `分析条目_${i + 1}`,
        createdAt: `2026-09-04 10:${String(i).padStart(2, '0')}:00`,
        chart: { id: `chart_${i + 1}` }
    }));

    // 第 1 页渲染
    app.state.historyPage = 1;
    app.renderHistory();

    // 应该只展示第 1 至第 10 条
    assert.match(box.innerHTML, /分析条目_1</);
    assert.match(box.innerHTML, /分析条目_10</);
    assert.doesNotMatch(box.innerHTML, /分析条目_11</);
    // 第一条序号为 1，按钮索引映射为 0
    assert.match(box.innerHTML, /<td class="col-history-index text-center data-analysis-row-index">1<\/td>/);
    assert.match(box.innerHTML, /data-data-analysis-history="0"/);
    // 第十条序号为 10，按钮索引映射为 9
    assert.match(box.innerHTML, /<td class="col-history-index text-center data-analysis-row-index">10<\/td>/);
    assert.match(box.innerHTML, /data-data-analysis-history="9"/);

    // 分页器状态验证
    let pagination = getLastPaginationOptions();
    assert.equal(pagination.total, 25);
    assert.equal(pagination.page, 1);
    assert.equal(pagination.limit, 10);
    assert.match(pager.innerHTML, /第 1 \/ 3 页（共 25 条，每页 10 条）/);

    // 模拟分页切换至第 2 页
    pagination.onPageChange(2);
    assert.equal(app.state.historyPage, 2);

    // 第 2 页展示第 11 至第 20 条
    assert.doesNotMatch(box.innerHTML, /分析条目_10</);
    assert.match(box.innerHTML, /分析条目_11</);
    assert.match(box.innerHTML, /分析条目_20</);
    assert.doesNotMatch(box.innerHTML, /分析条目_21</);

    // 第 11 条序号为 11，按钮索引依然精准映射至原始数组 index 10
    assert.match(box.innerHTML, /<td class="col-history-index text-center data-analysis-row-index">11<\/td>/);
    assert.match(box.innerHTML, /data-data-analysis-history="10"/);

    // 再次切换至第 3 页
    pagination = getLastPaginationOptions();
    pagination.onPageChange(3);
    assert.equal(app.state.historyPage, 3);
    assert.match(box.innerHTML, /分析条目_21</);
    assert.match(box.innerHTML, /分析条目_25</);
    assert.match(box.innerHTML, /<td class="col-history-index text-center data-analysis-row-index">25<\/td>/);
    assert.match(box.innerHTML, /data-data-analysis-history="24"/);
});
