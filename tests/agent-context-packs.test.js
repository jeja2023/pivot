const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeContextConfig } = require('../server/services/agent-validators');

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('project context selection normalizes bounded collection IDs without retaining arbitrary values', () => {
    assert.deepEqual(normalizeContextConfig({
        mode: 'knowledge', notes: '只查项目资料', collectionIds: ['4', 4, 0, '-1', 'bad', 9, 9]
    }), {
        mode: 'knowledge', notes: '只查项目资料', collectionIds: [4, 9]
    });
    assert.deepEqual(normalizeContextConfig({ knowledge_collection_ids: ' [ 2, 7, 7 ] ' }).collectionIds, [2, 7]);
});

test('project context packs are ACL-resolved, persisted as a snapshot, and always narrow rag.search', () => {
    const route = read('server/routes/agent-control-plane.js');
    const creation = read('server/services/agent-runtime/run-creation.js');
    const planner = read('server/services/agent-runtime/planner.js');
    const tools = read('server/services/agent-tools.js');
    const client = read('client/chat/agent-run-actions.js');
    const partial = read('client/chat/partials/workspaces/agent.html');

    assert.match(route, /\/agents\/context-packs\/collections/);
    assert.match(creation, /resolveAgentContextPack/);
    assert.match(creation, /runMetadata\.projectContextPack/);
    assert.match(planner, /项目资料包/);
    assert.match(tools, /runContextConfig\.collectionIds\.length/);
    assert.match(tools, /scope = runContextConfig\.collectionIds\.length/);
    assert.match(client, /collectionIds:/);
    assert.match(partial, /id="agent-context-collections"/);
});
