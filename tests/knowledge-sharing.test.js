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
const admin = { id: 1, role: 'admin', unit: '管理部' };

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

test('共享资源可以只授权给指定个人', () => {
    const shared = { user_id: owner.id, scope: 'shared', allowed_units: '', allowed_user_ids: String(otherUnit.id) };
    assert.equal(canAccessSharedResource(shared, otherUnit), true);
    assert.equal(canAccessSharedResource(shared, sameUnit), false);
    assert.equal(canReadKnowledgeResource(shared, otherUnit), true);
    assert.equal(canReadKnowledgeResource(shared, sameUnit), false);
});

test('全局工具资源允许读取但不允许写入', () => {
    const globalResource = { user_id: null, scope: 'personal' };
    assert.equal(canAccessSharedResource(globalResource, otherUnit), true);
    assert.equal(canAccessSharedResource(globalResource, otherUnit, true), false);
});

test('知识库资源判定与 SQL 过滤器绑定用户和单位范围', () => {
    const collection = { user_id: owner.id, scope: 'shared', allowed_units: '研发部' };
    assert.equal(canReadKnowledgeResource(collection, sameUnit), true);
    assert.equal(canReadKnowledgeResource(collection, otherUnit), false);

    const collectionFilter = buildCollectionAccessFilter(sameUnit, 'c');
    assert.match(collectionFilter.sql, /c\.user_id = \?/);
    assert.match(collectionFilter.sql, /c\.scope = 'shared'/);
    assert.match(collectionFilter.sql, /c\.allowed_user_ids/);
    assert.deepEqual(collectionFilter.params, [sameUnit.id, sameUnit.unit, sameUnit.id]);

    const documentFilter = buildDocumentAccessFilter(sameUnit, 'd', 'c');
    assert.match(documentFilter.sql, /d\.collection_id IS NOT NULL/);
    assert.match(documentFilter.sql, /c\.scope = 'shared'/);
    assert.deepEqual(documentFilter.params, [sameUnit.id, sameUnit.unit, sameUnit.id]);
});

test('Graph-RAG 汇总接受完整用户上下文以应用共享单位范围', () => {
    assert.doesNotThrow(() => getGraphSummary(sameUnit));
});
