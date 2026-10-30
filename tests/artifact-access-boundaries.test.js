const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../server/db/client');
const managerPath = require.resolve('../server/services/agent-runtime/artifact-manager');

test('评论和交互必须先检查访问权，非公开分享不能访问', async () => {
    const oldDb = require.cache[dbPath];
    const oldManager = require.cache[managerPath];
    const writes = [];
    let allowed = false;
    let visibility = 'private';
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        queryOne: async sql => {
            if (sql.includes('agent_artifact_shares')) return { id: 's', artifact_id: 'a', visibility };
            if (sql.includes('SELECT id FROM agent_artifacts')) return allowed ? { id: 'a' } : null;
            if (sql.includes('SELECT * FROM agent_artifacts')) return { id: 'a', user_id: '1', type: 'html', status: 'active' };
            if (sql.includes('COUNT')) return { count: 0 };
            return null;
        },
        query: async sql => { writes.push(sql); return []; },
        execute: async sql => { writes.push(sql); },
        transaction: async () => {}
    } };
    delete require.cache[managerPath];
    try {
        const { ArtifactManager } = require(managerPath);
        const manager = new ArtifactManager();
        await assert.rejects(manager.recordInteraction('a', '2', { type: 'view' }), { status: 404 });
        await assert.rejects(manager.addComment('a', '2', { content: 'x' }), { status: 404 });
        await assert.rejects(manager.getComments('a', '2'), { status: 404 });
        await assert.rejects(manager.getShared('s'), /不存在/);
        assert.equal(writes.length, 0);
        allowed = true;
        await manager.recordInteraction('a', '1', { type: 'view' });
        assert.equal(writes.length, 1);
        visibility = 'public';
        await manager.recordSharedInteraction('s', { type: 'shared_view' });
        assert.equal(writes.length, 2);
    } finally {
        delete require.cache[managerPath];
        if (oldManager) require.cache[managerPath] = oldManager;
        if (oldDb) require.cache[dbPath] = oldDb;
        else delete require.cache[dbPath];
    }
});
