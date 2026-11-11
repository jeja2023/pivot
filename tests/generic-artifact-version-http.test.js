'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-min-32-chars-for-testing-node';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { query, queryOne, execute } = require('../server/db/client');
const { ArtifactManager } = require('../server/services/agent-runtime/artifact-manager');
const { createStandaloneArtifact } = require('../server/services/agent-artifacts');
const { generateAccessToken } = require('../server/auth');

async function fixture(run) {
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES (?,'hash','user','active','测试') RETURNING id,username,role,status,unit,token_version", [`artifact_http_${crypto.randomUUID()}`]);
    try { await run(user); }
    finally { await execute('DELETE FROM agent_artifacts WHERE user_id = ?', [user.id]); await execute('DELETE FROM users WHERE id = ?', [user.id]); }
}

test('真实产物初始版本、并发修订、旧记录补齐和回滚共用单调版本指针', { skip: !process.env.DATABASE_URL }, async () => fixture(async user => {
    const manager = new ArtifactManager();
    const created = await createStandaloneArtifact(user, { type: 'html', title: '任务原稿', content: '<p>初始</p>' });
    const updated = await manager.update(created.id, user, { content: '<p>新版</p>', expectedVersion: 1 });
    assert.equal(updated.version, 2);
    assert.equal((await queryOne('SELECT version FROM agent_artifact_versions WHERE id=?', [updated.current_version_id])).version, 2);
    const outcomes = await Promise.allSettled([manager.update(created.id, user, { content: '甲', expectedVersion: 2 }), manager.update(created.id, user, { content: '乙', expectedVersion: 2 })]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'ARTIFACT_VERSION_CONFLICT');
    const restored = await manager.restoreVersion(created.id, user, 1, 3); assert.equal(restored.version, 4); assert.equal(restored.content, '<p>初始</p>');
    const legacy = await queryOne("INSERT INTO agent_artifacts(user_id,title,type,content,version,status) VALUES (?,'旧产物','html','旧当前正文',2,NULL) RETURNING id", [user.id]);
    await execute('INSERT INTO agent_artifact_versions(artifact_id,version,content) VALUES (?,1,?)', [legacy.id, '旧初稿']);
    assert.equal((await manager.update(legacy.id, user, { content: '统一后修订', expectedVersion: 2 })).version, 3);
    assert.deepEqual((await query('SELECT version,content FROM agent_artifact_versions WHERE artifact_id=? ORDER BY version', [legacy.id])).map(item => item.content), ['旧初稿', '旧当前正文', '统一后修订']);
}));

test('真实 HTTP 分享链接有只读页面，权限失败使用正确状态且到期或删除立即失效', { skip: !process.env.DATABASE_URL }, async () => fixture(async user => {
    const app = express(); app.use(express.json()); app.use('/api/artifacts', require('../server/routes/api/artifacts'));
    require('../server/routes/artifact-share-page').registerArtifactSharePage(app, 'v0.7.149');
    const server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${generateAccessToken(user, { sessionIp: '127.0.0.1' })}`, 'Content-Type': 'application/json' };
    try {
        const createdResponse = await fetch(`${base}/api/artifacts`, { method: 'POST', headers, body: JSON.stringify({ title: '公开原稿', type: 'markdown', content: '允许公开的内容' }) });
        assert.equal(createdResponse.status, 201); const artifact = (await createdResponse.json()).data;
        const invalidShare = await fetch(`${base}/api/artifacts/${artifact.id}/share`, { method: 'POST', headers, body: JSON.stringify({ expiresIn: 0.5 }) });
        assert.equal(invalidShare.status, 400);
        const shareResponse = await fetch(`${base}/api/artifacts/${artifact.id}/share`, { method: 'POST', headers, body: JSON.stringify({ expiresIn: 60 }) });
        assert.equal(shareResponse.status, 200); const share = (await shareResponse.json()).data;
        const page = await fetch(base + share.shareUrl); assert.equal(page.status, 200); assert.match(await page.text(), /只读预览/);
        const anonymous = await fetch(`${base}/api/artifacts/shared/${share.shareId}`); assert.equal(anonymous.status, 200); assert.match(anonymous.headers.get('cache-control'), /no-store/);
        const conflict = await fetch(`${base}/api/artifacts/${artifact.id}`, { method: 'PUT', headers, body: JSON.stringify({ content: '不能覆盖', expectedVersion: 99 }) });
        assert.equal(conflict.status, 409);
        await execute("UPDATE agent_artifact_shares SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [share.shareId]);
        assert.equal((await fetch(`${base}/api/artifacts/shared/${share.shareId}`)).status, 404);
        await execute("UPDATE agent_artifacts SET status='deleted' WHERE id=?", [artifact.id]);
        assert.equal((await fetch(`${base}/api/artifacts/${artifact.id}`, { headers })).status, 404);
    } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
}));
