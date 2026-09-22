const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    canReadKnowledgeResource
} = require('../server/services/knowledge-access');
const {
    canAccessSharedResource,
    normalizeShareSettings
} = require('../server/services/unit-visibility');
const { getGraphSummary } = require('../server/services/knowledge-graph');

const owner = { id: 10, role: 'user', unit: '研发部' };
const sameUnit = { id: 20, role: 'user', unit: '研发部' };
const otherUnit = { id: 30, role: 'user', unit: '市场部' };
const admin = { id: 1, username: 'admin', role: 'admin', unit: '管理部' };
const regularAdmin = { id: 2, username: 'operations_admin', role: 'admin', unit: '管理部' };

test('普通用户只能把知识资源共享给本单位', () => {
    assert.deepEqual(
        normalizeShareSettings({ scope: 'shared', allowedUnits: ['研发部'] }, owner),
        { scope: 'shared', allowedUnits: '研发部', allowedUserIds: '' }
    );
    assert.throws(
        () => normalizeShareSettings({ scope: 'shared', allowedUnits: ['市场部'] }, owner),
        error => error.status === 403
    );
    assert.deepEqual(
        normalizeShareSettings({ scope: 'shared', allowedUnits: ['研发部', '市场部'] }, admin),
        { scope: 'shared', allowedUnits: '研发部,市场部', allowedUserIds: '' }
    );
});

test('共享资源按单位提供只读访问，写操作只允许所有者', () => {
    const shared = { user_id: owner.id, scope: 'shared', allowed_units: '研发部' };
    assert.equal(canAccessSharedResource(shared, owner), true);
    assert.equal(canAccessSharedResource(shared, sameUnit), true);
    assert.equal(canAccessSharedResource(shared, sameUnit, true), false);
    assert.equal(canAccessSharedResource(shared, otherUnit), false);
    assert.equal(canAccessSharedResource({ ...shared, scope: 'personal' }, sameUnit), false);
});

test('知识库文档严格按所有者隔离，普通用户不能因共享范围读取其他用户资源', () => {
    const shared = { user_id: owner.id, scope: 'shared', allowed_units: '', allowed_user_ids: String(otherUnit.id) };
    assert.equal(canAccessSharedResource(shared, otherUnit), true);
    assert.equal(canAccessSharedResource(shared, sameUnit), false);
    assert.equal(canReadKnowledgeResource(shared, otherUnit), false);
    assert.equal(canReadKnowledgeResource(shared, sameUnit), false);
    assert.equal(canReadKnowledgeResource(shared, admin), true);
});

test('全局工具资源允许读取但不允许写入', () => {
    const globalResource = { user_id: null, scope: 'personal' };
    assert.equal(canAccessSharedResource(globalResource, otherUnit), true);
    assert.equal(canAccessSharedResource(globalResource, otherUnit, true), false);
});

test('知识库资源 SQL 过滤器仅允许所有者，只有超级管理员可跨用户读取', () => {
    const collection = { user_id: owner.id, scope: 'shared', allowed_units: '研发部' };
    assert.equal(canReadKnowledgeResource(collection, sameUnit), false);
    assert.equal(canReadKnowledgeResource(collection, otherUnit), false);

    const collectionFilter = buildCollectionAccessFilter(sameUnit, 'c');
    assert.match(collectionFilter.sql, /c\.user_id = \?/);
    assert.doesNotMatch(collectionFilter.sql, /scope = 'shared'/);
    assert.deepEqual(collectionFilter.params, [sameUnit.id]);

    const documentFilter = buildDocumentAccessFilter(sameUnit, 'd', 'c');
    assert.equal(documentFilter.sql, 'd.user_id = ?');
    assert.deepEqual(documentFilter.params, [sameUnit.id]);

    const adminFilter = buildDocumentAccessFilter(admin, 'd', 'c');
    assert.equal(adminFilter.sql, '1 = 1');
    assert.deepEqual(adminFilter.params, []);

    const regularAdminFilter = buildDocumentAccessFilter(regularAdmin, 'd', 'c');
    assert.equal(regularAdminFilter.sql, 'd.user_id = ?');
    assert.deepEqual(regularAdminFilter.params, [regularAdmin.id]);
});

test('知识库集合筛选不受普通用户单位字段影响', () => {
    const filter = buildCollectionAccessFilter({ id: 20, role: 'user', unit: '%' }, 'c');
    assert.equal(filter.sql, 'c.user_id = ?');
    assert.deepEqual(filter.params, [20]);
});

test('知识图谱跨用户访问仅向超级管理员开放', () => {
    const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../server/services/knowledge-graph.js'), 'utf8');
    assert.match(source, /isSuperAdmin\(userOrId\)/);
    assert.doesNotMatch(source, /user\.isAdmin\) return \{ sql: '1 = 1'/);
    assert.equal(typeof getGraphSummary, 'function');
});
