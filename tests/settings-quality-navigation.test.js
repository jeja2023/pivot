'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/settings-quality.js'), 'utf8');

function fixture({ admin = true, storageDisabled = false } = {}) {
    const storage = new Map();
    const listeners = {};
    const modules = {};
    const loads = [];
    const cancelled = [];
    function element(dataset, classes = '') {
        const values = new Set(classes.split(' ').filter(Boolean));
        return { dataset, attributes: {}, classList: { contains: name => values.has(name), remove: name => values.delete(name),
            toggle(name, active) { if (active) values.add(name); else values.delete(name); } },
        setAttribute(key, value) { this.attributes[key] = value; } };
    }
    const buttons = ['overview', 'services', 'quality', 'configuration', 'evaluation'].map(section => element({ qualityTab: ['overview','services','quality'].includes(section) ? 'monitor' : 'models', qualitySection: section }, section === 'evaluation' ? 'hidden' : ''));
    const panels = buttons.map(button => element({ qualityPanels: button.dataset.qualityTab, qualityPanel: button.dataset.qualitySection }));
    const content = element({});
    const monitor = element({});
    const document = {
        querySelectorAll(selector) {
            const match = selector.match(/\[data-quality-(tab|panels)="(monitor|models)"\]/);
            return match ? (match[1] === 'tab' ? buttons.filter(item => item.dataset.qualityTab === match[2]) : panels.filter(item => item.dataset.qualityPanels === match[2])) : [];
        },
        querySelector(selector) { return selector.includes('admin-content') ? content : this.querySelectorAll(selector).find(item => item.classList.contains('active')); },
        getElementById: id => id === 'tab-content-monitor' ? monitor : null,
        addEventListener: (name, listener) => { listeners[name] = listener; }
    };
    const legacy = { cancelMonitorSummaryLoad: () => cancelled.push('cancel'), clearMonitorRefreshTimer: () => cancelled.push('timer'),
        loadMonitorSummary: async () => loads.push('overview'), loadModels: async () => loads.push('configuration'),
        switchTab: (tab, options) => loads.push({ tab, options }) };
    modules['decision.feedbackReview'] = { loadRouteFeedbackReviewQueue: async () => loads.push('quality') };
    modules['decision.goldReview'] = { loadDecisionGoldReviewQueue: async () => loads.push('evaluation') };
    vm.runInNewContext(source, { document, isAdminUser: () => admin,
        sessionStorage: { getItem: key => { if (storageDisabled) throw Error('禁用存储'); return storage.get(key); }, setItem: (key, value) => { if (storageDisabled) throw Error('禁用存储'); storage.set(key, value); } },
        window: { Pivot: { legacy, moduleApi: name => modules[name], exposeModule: (name, value) => { modules[name] = value; } } } });
    return { api: modules['settings.quality'], modules, buttons, panels, content, monitor, loads, storage, listeners, cancelled };
}

test('旧路由入口和已保存金标页签迁移到正确分区', () => {
    const env = fixture();
    assert.equal(env.api.resolveTab('route-feedback'), 'monitor');
    env.api.prepare('monitor');
    assert.equal(env.api.getSection('monitor'), 'quality');
    env.storage.set('pivot_settings_decision_review_subtab', 'gold');
    assert.equal(env.api.resolveTab('decision-review'), 'evaluation-review');
    assert.equal(env.api.resolveTab('decision-gold-review'), 'evaluation-review');
    env.storage.set('pivot_settings_models_section', 'evaluation');
    assert.equal(env.api.resolveTab('models'), 'evaluation-review');
    assert.equal(env.api.resolveTab('models'), 'models', '旧模型子页签状态只迁移一次');
    assert.equal(env.api.resolveTab('models', 'evaluation'), 'evaluation-review');
});

test('对话质量停止自动刷新，并加载路由指标与审核队列', async () => {
    const env = fixture();
    env.api.prepare('monitor', 'quality');
    assert.deepEqual(env.cancelled, ['cancel','timer']);
    assert.equal(env.content.classList.contains('is-monitor-tab-active'), false);
    assert.equal(env.monitor.classList.contains('is-quality-view'), true);
    await env.api.load('monitor');
    assert.deepEqual(env.loads, ['quality','overview']);
    await env.api.load('evaluation-review');
    assert.deepEqual(env.loads, ['quality','overview','evaluation']);
    env.api.prepare('monitor', 'overview');
    await env.api.load('monitor');
    assert.equal(env.content.classList.contains('is-monitor-tab-active'), false);
    assert.deepEqual(env.loads, ['quality','overview','evaluation','overview']);
});

test('普通用户不能通过保存状态或直接方法进入管理员评测', async () => {
    const env = fixture({ admin: false });
    env.storage.set('pivot_settings_models_section', 'evaluation');
    assert.equal(env.api.resolveTab('models', 'evaluation'), 'models');
    assert.equal(env.api.resolveTab('decision-gold-review'), 'models');
    await env.api.load('evaluation-review');
    await env.api.load('models');
    assert.deepEqual(env.loads, ['configuration']);
});

test('无存储环境仍能切换，页签 ARIA 与可见内容一致', async () => {
    const env = fixture({ storageDisabled: true });
    env.api.prepare('monitor', 'quality');
    await env.api.load('monitor');
    assert.deepEqual(env.loads, ['quality','overview']);
    const button = env.buttons.find(item => item.dataset.qualitySection === 'quality');
    const panel = env.panels.find(item => item.dataset.qualityPanel === 'quality');
    assert.equal(button.attributes['aria-selected'], 'true');
    assert.equal(button.tabIndex, 0);
    assert.equal(panel.attributes['aria-hidden'], 'false');
});
