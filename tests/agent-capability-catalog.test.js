const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('personal capability catalog is backed only by authorized releases and governed capability packages', () => {
    const route = read('server/routes/agent-control-plane.js');
    const client = read('client/chat/agent-personal-experience.js');
    const partial = read('client/chat/partials/workspaces/agent.html');
    const css = read('client/chat/styles/workspaces/agent/agent-harness.css');

    assert.match(route, /\/agents\/capabilities\/catalog/);
    assert.match(route, /listCapabilityPackages\(req\.user\)/);
    assert.match(route, /listSkillCatalogForUser\(req\.user/);
    assert.match(client, /\/agents\/capabilities\/catalog\?limit=300/);
    assert.match(client, /capabilityKindLabel/);
    assert.match(client, /skill:\s*'技能'/);
    assert.match(client, /capabilityScopeLabel/);
    assert.match(client, /capabilityTitleLabel/);
    assert.match(client, /global:\s*'全局'/);
    assert.match(client, /admin:\s*'管理员'/);
    assert.match(client, /user:\s*'个人'/);
    assert.match(route, /已发布技能/);
    assert.match(partial, /id="agent-capability-catalog-search"/);
    assert.match(partial, /id="agent-capability-catalog-list"/);
    assert.match(partial, /已授权的技能、内置工具与受控连接/);
    assert.match(css, /\.agent-capability-catalog-list/);
    assert.match(css, /\.agent-capability-catalog-item/);
});
