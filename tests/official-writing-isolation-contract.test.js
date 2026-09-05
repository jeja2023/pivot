const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Sqlite = require('better-sqlite3');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function withOfficialWritingDbClient(fakeClient, callback) {
    const dbClientPath = require.resolve('../server/db/client');
    const servicePath = require.resolve('../server/services/official-writing-documents');
    const savedClient = require.cache[dbClientPath];
    const savedService = require.cache[servicePath];
    delete require.cache[servicePath];
    require.cache[dbClientPath] = { id: dbClientPath, filename: dbClientPath, loaded: true, exports: fakeClient };
    try {
        return await callback(require('../server/services/official-writing-documents'));
    } finally {
        delete require.cache[servicePath];
        if (savedService) require.cache[servicePath] = savedService;
        if (savedClient) require.cache[dbClientPath] = savedClient;
        else delete require.cache[dbClientPath];
    }
}

test('公文写作文档迁移建立按用户归属的服务端表', () => {
    const migrations = require('../server/db/migrations/official-writing-documents');
    const db = new Sqlite(':memory:');
    try {
        db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
        migrations[0].up(db);
        const columns = db.pragma('table_info(official_writing_documents)');
        assert.ok(columns.some(column => column.name === 'user_id' && column.notnull === 1));
        assert.ok(columns.some(column => column.name === 'client_id' && column.notnull === 1));
        assert.ok(columns.some(column => column.name === 'state' && column.notnull === 1));
        assert.ok(columns.some(column => column.name === 'deleted_at'));
        assert.deepEqual(db.pragma('index_list(official_writing_documents)').map(index => index.name), [
            'idx_official_writing_documents_user_updated',
            'sqlite_autoindex_official_writing_documents_1'
        ]);
    } finally {
        db.close();
    }
});

test('公文写作前端不再读取或写入跨账号 localStorage，并清除旧缓存', () => {
    const core = read('client/chat/apps-workbench-core.js');
    const auth = read('client/chat/auth.js');
    const config = read('client/chat/config.js');

    assert.match(core, /const OFFICIAL_WRITING_DOCUMENTS_API = `\$\{API_BASE\}\/apps\/official-writing\/documents`;/);
    assert.match(core, /await apiFetch\(OFFICIAL_WRITING_DOCUMENTS_API\)/);
    assert.match(core, /method: 'PUT'/);
    assert.match(core, /method: 'DELETE'/);
    assert.doesNotMatch(core, /localStorage\.getItem\(OFFICIAL_WRITING_LIBRARY_KEY\)/);
    assert.doesNotMatch(core, /localStorage\.setItem\(OFFICIAL_WRITING_LIBRARY_KEY/);
    assert.match(core, /localStorage\.removeItem\(OFFICIAL_WRITING_LIBRARY_KEY\)/);
    assert.match(auth, /localStorage\.removeItem\('pivot_official_writing_library_v2'\)/);
    assert.match(config, /localStorage\.removeItem\('pivot_official_writing_library_v2'\)/);
});

test('公文写作服务端 API 对文档读写删除均以当前 user_id 作为边界', () => {
    const service = read('server/services/official-writing-documents.js');
    const routes = read('server/routes/apps/index.js');

    assert.match(service, /WHERE user_id = \? AND deleted_at IS NULL/);
    assert.match(service, /ON CONFLICT \(user_id, client_id\) DO UPDATE/);
    assert.match(service, /WHERE official_writing_documents\.deleted_at IS NULL/);
    assert.match(service, /WHERE user_id = \? AND client_id = \? AND deleted_at IS NULL/);
    assert.match(routes, /router\.get\('\/apps\/official-writing\/documents', authMiddleware/);
    assert.match(routes, /router\.put\('\/apps\/official-writing\/documents\/:clientId', authMiddleware/);
    assert.match(routes, /router\.delete\('\/apps\/official-writing\/documents\/:clientId', authMiddleware/);
});

test('公文写作文档服务不会接受或查询其他用户的文档归属', async () => {
    const calls = [];
    await withOfficialWritingDbClient({
        query: async (sql, params) => {
            calls.push({ type: 'query', sql, params });
            return [{ client_id: 'doc-one', title: '我的公文', manual_title: 0, state: '{"draft":"私有内容"}', version: 1, created_at: '2026-09-05', updated_at: '2026-09-05' }];
        },
        queryOne: async (sql, params) => {
            calls.push({ type: 'queryOne', sql, params });
            return { client_id: 'doc-one', title: '我的公文', manual_title: 0, state: '{"draft":"私有内容"}', version: 2, created_at: '2026-09-05', updated_at: '2026-09-05' };
        },
        execute: async (sql, params) => {
            calls.push({ type: 'execute', sql, params });
            return 1;
        }
    }, async service => {
        const owner = { id: 17, role: 'user' };
        const listed = await service.listOfficialWritingDocuments(owner);
        assert.equal(listed[0].state.draft, '私有内容');
        await service.saveOfficialWritingDocument(owner, 'doc-one', { title: '我的公文', state: { draft: '更新内容' } });
        assert.equal(await service.deleteOfficialWritingDocument(owner, 'doc-one'), true);
    });
    assert.deepEqual(calls[0].params, [17]);
    assert.equal(calls[1].params[0], 17);
    assert.deepEqual(calls[2].params, [17, 'doc-one']);
    assert.ok(calls.every(call => !call.params.includes(18)));
});
