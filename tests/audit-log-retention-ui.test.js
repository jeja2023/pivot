'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function renderMaintenance(maintenance) {
    const health = {};
    let api;
    const elements = new Map([['monitor-health-maintenance-list', health], ['monitor-updated-at', {}]]);
    const context = {
        AbortController,
        API_BASE: '/api',
        isAdminUser: () => true,
        apiFetch: async () => ({ ok: true, json: async () => ({ maintenance, http: { routes: [] } }) }),
        document: { body: { dataset: {} }, getElementById: id => elements.get(id) || null },
        PivotSafeHtml: { setHtml: (element, html) => { if (element) element.html = html; } },
        escapeHtml: value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`),
        formatMetricNumber: value => String(value || 0),
        formatBytes: value => String(value || 0),
        formatDuration: value => String(value || 0),
        formatDateToCN: value => String(value || ''),
        renderMonitorEndpointLists() {},
        showToast: message => { throw new Error(message); },
        window: { Pivot: {
            legacy: {}, moduleApi: () => ({ render() {} }),
            exposeModule: (_name, value) => { api = value; }
        } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/stats-monitor.js'), 'utf8'), context);
    await api.loadMonitorSummary({ propagateErrors: true });
    return health.html;
}

test('监控优先显示保全状态，恢复后显示实际成功清理记录与保留期', async () => {
    const auditCleanup = { paused: true, retentionDays: 365, lastChanges: 3, lastSuccessAt: '2026-11-09 08:00:00' };
    const paused = await renderMaintenance({ auditCleanup });
    assert.match(paused, /保全中 · 暂停清理/);
    assert.match(paused, /保留 365 天/);
    assert.doesNotMatch(paused, /2026-11-09 08:00/);

    const resumed = await renderMaintenance({ auditCleanup: { ...auditCleanup, paused: false } });
    assert.doesNotMatch(resumed, /保全中/);
    assert.match(resumed, /2026-11-09 08:00 · 3 条/);
    assert.match(resumed, /保留 365 天/);
});

test('监控读取旧状态兼容顶层保留期，缺失配置时不编造天数', async () => {
    assert.match(await renderMaintenance({ retentionDays: 730 }), /保留 730 天/);
    assert.match(await renderMaintenance({}), /保留期暂不可用/);
});
