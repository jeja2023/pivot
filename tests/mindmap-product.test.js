'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const documents = require('../server/services/mindmaps/documents');
const product = require('../server/services/mindmaps/product');
const crdt = require('../client/common/mindmap-crdt');
const key = () => `product:${crypto.randomUUID()}`;
const tree = () => ({ id: 'root', text: '协作项目', children: [{ id: 'a', text: '甲分支' }, { id: 'b', text: '乙分支' }] });
test('完整纯文本样式与个人主题按账号保存，拒绝主题携带内容和外部资源', async () => {
    const owner = await user(); const other = await user();
    try {
        const document = require('../client/common/mindmap-document').normalize(tree());
        document.presentation.nodes.a = { fontFamily: 'serif', fontStyle: 'italic', textAlign: 'center', textDecoration: 'underline', borderWidth: 3, borderColor: '#123456', borderDasharray: '5,5', lineColor: '#234567', lineWidth: 4, paddingX: 20, paddingY: 10 };
        document.presentation.customTheme = { version: 1, label: '企业主题', root: '#123456', line: '#234567', background: '#ffffff', styles: { root: { fontFamily: 'sans-serif', fontSize: 24 }, node: { paddingX: 18, fontStyle: 'italic' } } }; document.presentation.themeId = 'custom';
        const schema = require('../client/common/mindmap-document'); assert.deepEqual(schema.fromEngine(schema.toEngine(document), document), schema.normalize(document));
        const theme = await product.saveTheme(owner, document.presentation.customTheme); assert.equal((await product.themes(owner)).length, 1); assert.equal((await product.themes(other)).length, 0);
        await product.removeTheme(other, theme.id); assert.equal((await product.themes(owner)).length, 1);
        assert.equal((await product.saveTheme(owner, { ...document.presentation.customTheme, line: '#345678' })).id, theme.id);
        assert.throws(() => schema.themePack({ ...document.presentation.customTheme, styles: { node: { note: '不能携带用户内容' } } }), /内容/);
        assert.throws(() => schema.themePack({ ...document.presentation.customTheme, backgroundImage: 'https://invalid' }), /主题包/);
        await product.removeTheme(owner, theme.id); assert.equal((await product.themes(owner)).length, 0);
    } finally { await execute('DELETE FROM users WHERE id=?', [owner.id]); await execute('DELETE FROM users WHERE id=?', [other.id]); }
});
async function user() { return queryOne("INSERT INTO users(username,password_hash,nickname,unit,role,status,created_at) VALUES(?,?,?,'QA','user','active',NOW()) RETURNING id,username,role,unit", [`mindmap_${crypto.randomUUID()}`, 'test-hash', '导图协作测试']); }
function client(snapshot) { const doc = crdt.create(); crdt.apply(doc, Buffer.from(snapshot.collaborationState, 'base64')); const vector = crdt.vector(doc); return { doc, update: () => Buffer.from(crdt.update(doc, vector)).toString('base64') }; }

test('CRDT 独立字段合并可收敛，本地撤销不撤销远端修改，循环合并拒绝', () => {
    const base = crdt.create(); crdt.write(base, tree(), 'server');
    const a = crdt.create(); const b = crdt.create(); crdt.apply(a, crdt.encode(base)); crdt.apply(b, crdt.encode(base));
    const undo = crdt.undoManager(a);
    let next = crdt.read(a); next.tree.children[0].text = '甲的修改'; crdt.write(a, next);
    next = crdt.read(b); next.tree.children[1].text = '乙的修改'; crdt.write(b, next);
    crdt.apply(a, crdt.encode(b)); crdt.apply(b, crdt.encode(a)); assert.deepEqual(crdt.read(a), crdt.read(b));
    undo.undo(); assert.equal(crdt.read(a).tree.children[0].text, '甲分支'); assert.equal(crdt.read(a).tree.children[1].text, '乙的修改');
    undo.redo(); assert.equal(crdt.read(a).tree.children[0].text, '甲的修改');
    undo.destroy(); a.destroy(); b.destroy(); base.destroy();
    const seed = crdt.create(); crdt.write(seed, tree(), 'server'); const left = crdt.create(); const right = crdt.create(); crdt.apply(left, crdt.encode(seed)); crdt.apply(right, crdt.encode(seed));
    crdt.write(left, { id: 'root', text: '协作项目', children: [{ id: 'b', text: '乙分支', children: [{ id: 'a', text: '甲分支' }] }] });
    crdt.write(right, { id: 'root', text: '协作项目', children: [{ id: 'a', text: '甲分支', children: [{ id: 'b', text: '乙分支' }] }] });
    crdt.apply(left, crdt.encode(right)); assert.throws(() => crdt.read(left), error => error.status === 409);
    seed.destroy(); left.destroy(); right.destroy();
});

test('真实 PostgreSQL 团队授权、离线协作合并、撤权与会话重置安全', async () => {
    const owner = await user(); const editor = await user(); const viewer = await user(); let created;
    try {
        created = await documents.save(owner, { tree: tree(), requestKey: key() });
        await assert.rejects(documents.get(editor, created.id), error => error.status === 404);
        await product.setSharing(owner, created.id, { enabled: true, expectedVersionId: created.versionId, expectedRevision: 1, members: [{ userId: editor.id, role: 'editor' }, { userId: viewer.id, role: 'viewer' }] });
        const first = await documents.get(owner, created.id); const second = await documents.get(editor, created.id);
        assert.equal(second.role, 'editor'); assert.equal((await documents.get(viewer, created.id)).canEdit, false);
        assert.ok((await documents.list(editor, { scope: 'shared' })).rows.some(row => row.id === created.id));
        assert.equal((await documents.list(editor, { scope: 'owned' })).rows.some(row => row.id === created.id), false);
        await assert.rejects(documents.save(viewer, { artifactId: created.id, document: first.document, expectedVersionId: first.versionId, requestKey: key() }), error => error.status === 403);
        await assert.rejects(documents.restore(editor, created.id, first.versionId, { expectedVersionId: first.versionId, requestKey: key() }), error => error.status === 403);
        await assert.rejects(documents.remove(editor, created.id, first.versionId), error => error.status === 403);
        await assert.rejects(product.setSharing(editor, created.id, { enabled: false, expectedVersionId: first.versionId, expectedRevision: 2, members: [] }), error => error.status === 403);
        const a = client(first); const b = client(second);
        const docA = crdt.read(a.doc); docA.tree.children[0].text = '所有者编辑甲'; crdt.write(a.doc, docA);
        const docB = crdt.read(b.doc); docB.tree.children[1].text = '编辑者离线编辑乙'; crdt.write(b.doc, docB);
        await documents.save(owner, { artifactId: created.id, document: docA, expectedVersionId: first.versionId, requestKey: key(), collaborationEpoch: first.collaborationEpoch, collaborationUpdate: a.update() });
        const merged = await documents.save(editor, { artifactId: created.id, document: docB, expectedVersionId: second.versionId, requestKey: key(), collaborationEpoch: second.collaborationEpoch, collaborationUpdate: b.update() });
        assert.equal(merged.document.tree.children[0].text, '所有者编辑甲'); assert.equal(merged.document.tree.children[1].text, '编辑者离线编辑乙'); assert.equal(merged.version, 3);
        const current = await documents.get(owner, created.id);
        const invalid = client(current); invalid.doc.getMap('meta').set('root', 'missing-root');
        await assert.rejects(documents.save(editor, { artifactId: created.id, document: current.document, expectedVersionId: current.versionId, requestKey: key(), collaborationEpoch: current.collaborationEpoch, collaborationUpdate: invalid.update() }), error => error.status === 409);
        assert.equal((await documents.get(owner, created.id)).collaborationState, current.collaborationState); invalid.doc.destroy();
        await assert.rejects(require('../server/services/mindmaps/exports').create(editor, created.id, { versionId: current.versionId, format: 'json' }), error => error.status === 403);
        await product.setSharing(owner, created.id, { enabled: true, expectedVersionId: current.versionId, expectedRevision: 2, members: [{ userId: viewer.id, role: 'viewer' }] });
        await assert.rejects(documents.get(editor, created.id), error => error.status === 404);
        await assert.rejects(documents.save(editor, { artifactId: created.id, document: docB, expectedVersionId: second.versionId, requestKey: key(), collaborationEpoch: second.collaborationEpoch, collaborationUpdate: b.update() }), error => error.status === 404);
        await product.setSharing(owner, created.id, { enabled: false, expectedVersionId: current.versionId, expectedRevision: 3, members: [] });
        await product.setSharing(owner, created.id, { enabled: true, expectedVersionId: current.versionId, expectedRevision: 4, members: [{ userId: editor.id, role: 'editor' }] });
        const refreshed = await documents.get(editor, created.id); assert.notEqual(refreshed.collaborationEpoch, first.collaborationEpoch);
        await assert.rejects(documents.save(editor, { artifactId: created.id, document: docB, expectedVersionId: second.versionId, requestKey: key(), collaborationEpoch: second.collaborationEpoch, collaborationUpdate: b.update() }), error => error.status === 409);
        const savedFlag = process.env.PIVOT_ENTERPRISE_ACCESS; process.env.PIVOT_ENTERPRISE_ACCESS = 'true';
        try { assert.equal((await product.shareTargets(owner)).users.length, 0); await assert.rejects(documents.get(editor, created.id), error => error.status === 404); await assert.rejects(product.setSharing(owner, created.id, { enabled: true, expectedVersionId: current.versionId, expectedRevision: 5, members: [{ userId: editor.id, role: 'editor' }] }), error => error.status === 403); }
        finally { if (savedFlag === undefined) delete process.env.PIVOT_ENTERPRISE_ACCESS; else process.env.PIVOT_ENTERPRISE_ACCESS = savedFlag; }
        await documents.remove(owner, created.id, current.versionId); const recovered = await product.recover(owner, created.id);
        assert.equal(recovered.collaboration, false); await assert.rejects(documents.get(editor, created.id), error => error.status === 404);
        a.doc.destroy(); b.doc.destroy();
    } finally { if (created) await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); for (const account of [owner, editor, viewer]) await execute('DELETE FROM users WHERE id=?', [account.id]); }
});

test('收藏、标签和模板按账号隔离，内容快照不受个人整理影响', async () => {
    const owner = await user(); const other = await user(); let created; let template;
    try {
        created = await documents.save(owner, { tree: tree(), requestKey: key() });
        await product.settings(owner, created.id, { favorite: true, tags: ['项目', '复盘'] });
        const filtered = await documents.list(owner, { favorite: 'true', tag: '复盘' }); assert.equal(filtered.total, 1); assert.deepEqual(filtered.rows[0].tags, ['项目', '复盘']);
        assert.equal((await documents.get(owner, created.id)).versionId, created.versionId);
        await assert.rejects(product.settings(other, created.id, { favorite: true, tags: [] }), error => error.status === 404);
        template = await product.saveTemplate(owner, { name: '测试个人模板', artifactId: created.id });
        assert.equal((await product.saveTemplate(owner, { name: '测试个人模板', artifactId: created.id })).id, template.id);
        assert.ok((await product.templates(owner)).some(item => item.id === template.id)); assert.equal((await product.templates(other)).length, 0);
        await assert.rejects(product.template(other, template.id), error => error.status === 404);
        assert.deepEqual((await product.template(owner, template.id)).tree, created.document.tree);
        await product.removeTemplate(owner, template.id); template = null;
        await documents.remove(owner, created.id, created.versionId);
        assert.equal((await documents.list(owner, { scope: 'trash' })).rows[0].id, created.id);
        await assert.rejects(product.recover(other, created.id), error => error.status === 404);
        const recovered = await product.recover(owner, created.id); assert.equal(recovered.version, 2); assert.notEqual(recovered.versionId, created.versionId);
        assert.equal((await documents.list(owner, { scope: 'trash' })).total, 0);
        await assert.rejects(documents.save(owner, { artifactId: created.id, expectedVersionId: created.versionId, tree: tree(), requestKey: key() }), error => error.status === 409);
    } finally { if (template) await product.removeTemplate(owner, template.id); if (created) await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); for (const account of [owner, other]) await execute('DELETE FROM users WHERE id=?', [account.id]); }
});

test('回收站在历史配额耗尽时幂等恢复为新副本，原记录保持删除状态', async () => {
    const owner = await user(); let original; let copy;
    try {
        original = await documents.save(owner, { tree: tree(), requestKey: key() });
        await execute("INSERT INTO agent_artifact_versions(artifact_id,version,content,note,created_by,created_at) VALUES(?,1000,?,'配额边界测试',?,NOW())", [original.id, JSON.stringify(original.document), owner.id]);
        await documents.remove(owner, original.id, original.versionId); copy = await product.recover(owner, original.id);
        assert.equal(copy.recoveredAsCopy, true); assert.notEqual(copy.id, original.id); assert.equal(copy.version, 1);
        assert.equal((await product.recover(owner, original.id)).id, copy.id); assert.equal((await documents.list(owner, { scope: 'trash' })).total, 1);
    } finally { if (copy) await execute('DELETE FROM agent_artifacts WHERE id=?', [copy.id]); if (original) await execute('DELETE FROM agent_artifacts WHERE id=?', [original.id]); await execute('DELETE FROM users WHERE id=?', [owner.id]); }
});
