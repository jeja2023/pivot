'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('skill discovery UI searches and reports a stale contract without rendering untrusted HTML', async () => {
    const nodes = new Map();
    for (const id of ['agent-skill-discovery-form', 'agent-skill-discovery-query', 'agent-skill-discovery-domain', 'agent-skill-discovery-capability', 'agent-skill-discovery-results', 'agent-skill-discovery-detail']) {
        nodes.set(id, { value: '', textContent: '', markup: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, replaceChildren() { this.textContent = ''; this.markup = ''; } });
    }
    nodes.get('agent-skill-discovery-domain').value = '财务';
    let factory;
    const context = { URLSearchParams, API_BASE: '/api', document: { getElementById: id => nodes.get(id), querySelector: () => null }, window: { Pivot: { exposeModule: (_name, module) => { factory = module.create; } }, addEventListener: () => {} } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-personal-experience.js'), 'utf8'), context);
    const calls = [];
    const instance = factory({
        state: {}, escape: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), escapeAttr: String,
        setMarkup: (node, markup) => { node.markup = markup; }, setNotice: () => {},
        apiJson: async (url, options) => {
            calls.push({ url, options });
            if (url.includes('/describe')) throw new Error('技能发布版本已变化，请重新搜索。');
            return { data: { total: 1, candidates: [{ title: '<img>', description: '说明', domains: ['财务'], scope: 'personal', reference: { name: 'skill', releaseId: '1', version: '1.0.0', digest: 'abc' } }] } };
        }
    });
    instance.bindControls();
    await nodes.get('agent-skill-discovery-form').handlers.submit({ preventDefault() {} });
    assert.match(calls[0].url, /domain=/);
    assert.match(nodes.get('agent-skill-discovery-results').markup, /&lt;img&gt;/);
    nodes.get('agent-skill-discovery-results').handlers.click({ target: { closest: () => ({ dataset: { agentSkillDiscoveryIndex: '0' } }) } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(calls[1].options.body).reference.digest, 'abc');
    assert.match(nodes.get('agent-skill-discovery-detail').textContent, /重新搜索/);
});
