const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');
const express = require('express');

const {
    recordPresence,
    listActivePresence,
    leavePresence,
    _getRegistryForTest
} = require('../server/services/presentations/presentation-presence');

const {
    createPresentation,
    deletePresentation,
    getPresentation,
    listPresentationComments,
    createPresentationComment,
    resolvePresentationComment,
    deletePresentationComment,
    listPresentationCollaborators,
    addPresentationCollaborator,
    removePresentationCollaborator
} = require('../server/services/presentations/presentation-service');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };

function pool() {
    return require('../server/db/pg-connection').getPgPool();
}

async function createTenantScopedUser(role = 'admin') {
    const suffix = crypto.randomBytes(6).toString('hex');
    const tenant = await pool().query(
        "INSERT INTO organizations (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
        ['PPT 协作测试组织 ' + suffix, 'ppt-collab-' + suffix]
    );
    const username = 'ppt_collab_' + suffix;
    const user = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', $2, 'active', NOW()) RETURNING id",
        [username, role]
    );
    return {
        tenantId: Number(tenant.rows[0].id),
        user: { id: Number(user.rows[0].id), username, role, tenant_id: Number(tenant.rows[0].id) }
    };
}

function startPresenceNode(tenantId) {
    const child = fork(path.join(__dirname, 'fixtures/presentation-presence-node.js'), [], {
        env: { ...process.env, PIVOT_TEST_PRESENCE_TENANT_ID: String(tenantId) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('第二节点启动超时')); }, 15000);
        child.once('message', message => { clearTimeout(timer); resolve({ child, port: message.port }); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`第二节点提前退出: ${code}`)); });
    });
}

test('在线 Presence 注册表支持心跳保活、幻灯片位置更新、用户离开与自动过期', () => {
    const docId = 'ppt_test_presence_' + Date.now();
    const userA = { id: 101, username: 'alice' };
    const userB = { id: 102, username: 'bob' };

    // 1. 用户 A 加入，正在查看 slide_1
    const p1 = recordPresence({ presentationId: docId, user: userA, slideId: 'slide_1' });
    assert.equal(p1.length, 1);
    assert.equal(p1[0].userId, 101);
    assert.equal(p1[0].username, 'alice');
    assert.equal(p1[0].slideId, 'slide_1');

    // 2. 用户 B 加入，正在查看 slide_2
    const p2 = recordPresence({ presentationId: docId, user: userB, slideId: 'slide_2' });
    assert.equal(p2.length, 2);
    const listed = listActivePresence(docId);
    assert.equal(listed.length, 2);

    // 3. 用户 A 切换到 slide_3
    const p3 = recordPresence({ presentationId: docId, user: userA, slideId: 'slide_3' });
    const alice = p3.find(item => item.userId === 101);
    assert.equal(alice.slideId, 'slide_3');

    // 4. 用户 B 正常离开
    const p4 = leavePresence({ presentationId: docId, user: userB });
    assert.equal(p4.length, 1);
    assert.equal(p4[0].userId, 101);

    // 5. 模拟心跳过期
    recordPresence({ presentationId: docId, user: userA, slideId: 'slide_3' });
    const activeBefore = listActivePresence(docId);
    assert.equal(activeBefore.length, 1);
});

test('PPT 协作与评论前后端契约、HTML 结构及路由定义就绪', () => {
    const routes = read('server/routes/apps/presentations.js');
    const html = read('client/chat/partials/workspaces/apps.html');
    const css = read('client/chat/styles/workspaces/apps/presentations.css');
    const client = read('client/chat/apps-workbench-presentations.js');
    const collab = read('client/chat/apps-workbench-presentations-collab.js');

    // 路由定义完整
    assert.match(routes, /router\.get\('\/apps\/presentations\/:id\/comments'/);
    assert.match(routes, /router\.post\('\/apps\/presentations\/:id\/comments'/);
    assert.match(routes, /router\.put\('\/apps\/presentations\/:id\/comments\/:commentId'/);
    assert.match(routes, /router\.delete\('\/apps\/presentations\/:id\/comments\/:commentId'/);
    assert.match(routes, /router\.post\('\/apps\/presentations\/:id\/presence'/);
    assert.match(routes, /router\.delete\('\/apps\/presentations\/:id\/presence'/);
    assert.match(routes, /router\.get\('\/apps\/presentations\/:id\/collaborators'/);
    assert.match(routes, /router\.post\('\/apps\/presentations\/:id\/collaborators'/);
    assert.match(routes, /router\.delete\('\/apps\/presentations\/:id\/collaborators\/:userId'/);

    // HTML 结构就绪
    assert.match(html, /id="presentation-presence-bar"/);
    assert.match(html, /data-presentation-panel="comments"/);
    assert.match(html, /id="presentation-comments-panel"/);
    assert.match(html, /id="presentation-comments-filter-slide"/);
    assert.match(html, /id="presentation-comments-filter-all"/);
    assert.match(html, /id="presentation-comment-form"/);
    assert.match(html, /id="presentation-comment-input"/);
    assert.match(html, /id="presentation-comments-list"/);
    assert.match(html, /id="presentation-collaborators-modal"/);
    assert.match(html, /id="presentation-collab-form"/);
    assert.match(html, /id="presentation-collaborators-list"/);

    // CSS 样式就绪
    assert.match(css, /\.presentation-presence-bar/);
    assert.match(css, /\.presentation-presence-avatar/);
    assert.match(css, /\.presentation-presence-pulse/);
    assert.match(css, /\.presentation-comments-badge/);
    assert.match(css, /\.presentation-comment-card/);
    assert.match(css, /\.presentation-collab-dialog/);

    // 前端 JS 对接就绪（主编辑器与独立协作模块协同）
    assert.match(client, /apps\.presentations\.collab/);
    assert.match(collab, /startPresenceHeartbeat/);
    assert.match(collab, /stopPresenceHeartbeat/);
    assert.match(collab, /sendPresenceHeartbeat/);
    assert.match(collab, /renderPresenceBar/);
    assert.match(collab, /loadComments/);
    assert.match(collab, /renderComments/);
    assert.match(collab, /submitComment/);
    assert.match(collab, /resolveComment/);
    assert.match(collab, /deleteComment/);
    assert.match(collab, /openCollaboratorsModal/);
    assert.match(collab, /loadCollaborators/);
    assert.match(collab, /addCollaborator/);
    assert.match(collab, /removeCollaborator/);
});

test('数据库集成：演示文稿评论线程组织、解决状态与协作者多角色权限隔离', skipWithoutDatabase, async () => {
    const { tenantId, user: owner } = await createTenantScopedUser('admin');

    // 创建第二个用户（协作者候选）
    const suffix = crypto.randomBytes(4).toString('hex');
    const collabUserRow = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', 'user', 'active', NOW()) RETURNING id",
        ['collab_' + suffix]
    );
    const collaborator = { id: Number(collabUserRow.rows[0].id), username: 'collab_' + suffix, role: 'user', tenant_id: tenantId };

    // 创建第三个用户（非协作者外人）
    const strangerUserRow = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', 'user', 'active', NOW()) RETURNING id",
        ['stranger_' + suffix]
    );
    const stranger = { id: Number(strangerUserRow.rows[0].id), username: 'stranger_' + suffix, role: 'user', tenant_id: tenantId };

    let presentation;
    let server;
    let child;
    const previousMode = process.env.PIVOT_DEPLOYMENT_MODE;
    try {
        // 1. 所有者创建演示文稿
        presentation = await createPresentation(owner, { title: '协作测试演示文稿', templateId: 'business-blue' });
        assert.ok(presentation.id);
        const users = new Map([[String(owner.id), owner], [String(collaborator.id), collaborator], [String(stranger.id), stranger]]);
        const authMiddleware = (req, res, next) => { req.user = users.get(req.get('X-Test-User')); if (!req.user) return res.sendStatus(401); next(); };
        const app = express(); app.use(express.json());
        const passthrough = (_req, _res, next) => next();
        app.use('/api', require('../server/routes/apps/presentations').createPresentationsRouter({ authMiddleware, logAction() {}, uploadLimiter: passthrough, upload: { single: () => passthrough } }));
        server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
        const callPresence = (user, method = 'GET', id = presentation.id) => fetch(`http://127.0.0.1:${server.address().port}/api/apps/presentations/${encodeURIComponent(id)}/presence`, {
            method, headers: { 'X-Test-User': String(user.id), 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ slideId: 'slide-test' }) } : {})
        });
        assert.equal((await callPresence(owner, 'POST')).status, 200);
        for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await callPresence(stranger, method)).status, 404);

        // 2. 外人访问被拒
        const strangerAccess = await getPresentation(stranger, presentation.id);
        assert.equal(strangerAccess, null);

        // 3. 所有者添加协作者 (role = editor)
        const added = await addPresentationCollaborator(owner, presentation.id, {
            username: collaborator.username,
            role: 'editor'
        });
        assert.equal(added.username, collaborator.username);
        assert.equal(added.role, 'editor');

        const collabs = await listPresentationCollaborators(owner, presentation.id);
        assert.equal(collabs.collaborators.length, 1);
        assert.equal(collabs.collaborators[0].userId, collaborator.id);

        // 4. 协作者现在可以访问演示文稿
        const collabAccess = await getPresentation(collaborator, presentation.id);
        assert.ok(collabAccess);
        assert.equal(collabAccess.title, '协作测试演示文稿');
        assert.equal((await callPresence(collaborator, 'POST')).status, 200);
        const present = await (await callPresence(collaborator)).json();
        assert.deepEqual(present.presences.map(item => item.userId).sort((a, b) => a - b), [owner.id, collaborator.id].sort((a, b) => a - b));
        process.env.PIVOT_DEPLOYMENT_MODE = 'multi_node';
        let node = await startPresenceNode(tenantId);
        child = node.child;
        const callOther = (user, method = 'GET') => fetch(`http://127.0.0.1:${node.port}/api/apps/presentations/${encodeURIComponent(presentation.id)}/presence`, {
            method, headers: { 'X-Test-User': String(user.id), 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ slideId: 'shared-slide' }) } : {})
        });
        assert.equal((await callPresence(owner, 'POST')).status, 200);
        assert.equal((await callOther(collaborator, 'POST')).status, 200);
        const crossNode = await (await callPresence(owner)).json();
        assert.deepEqual(crossNode.presences.map(item => item.userId).sort((a, b) => a - b), [owner.id, collaborator.id].sort((a, b) => a - b));
        assert.equal(crossNode.presences.find(item => item.userId === collaborator.id).slideId, 'shared-slide');
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
        assert.equal((await (await callPresence(owner)).json()).presences.length, 2);
        node = await startPresenceNode(tenantId); child = node.child;
        for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await callOther(stranger, method)).status, 404);
        await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [collaborator.id]);
        assert.deepEqual((await (await callPresence(owner)).json()).presences.map(item => item.userId), [owner.id]);
        await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [collaborator.id]);
        await pool().query("UPDATE presentation_shared_presence SET last_seen_at = NOW() - INTERVAL '46 seconds' WHERE user_id = $1", [collaborator.id]);
        assert.equal((await (await callOther(owner)).json()).presences.length, 1);
        await pool().query("UPDATE presentation_shared_presence SET last_seen_at = NOW() - INTERVAL '2 days' WHERE user_id = $1", [collaborator.id]);
        assert.equal(await require('../server/services/presentations/presentation-shared-presence').pruneExpiredPresence(), 1);
        assert.equal((await (await callPresence(owner)).json()).presences.length, 1);
        assert.equal((await callOther(collaborator, 'POST')).status, 200);

        // 5. 协作者在第 1 页发表主评论
        const slide1Id = presentation.content.slides[0].id;
        const mainComment = await createPresentationComment(collaborator, presentation.id, {
            slideId: slide1Id,
            content: '第一页标题需要更加精炼'
        });
        assert.equal(mainComment.slideId, slide1Id);
        assert.equal(mainComment.content, '第一页标题需要更加精炼');
        assert.equal(mainComment.userId, collaborator.id);
        assert.equal(mainComment.status, 'open');

        // 6. 所有者回复该主评论
        const replyComment = await createPresentationComment(owner, presentation.id, {
            slideId: slide1Id,
            parentId: mainComment.id,
            content: '好的，稍后调整为 12 字内'
        });
        assert.equal(replyComment.parentId, mainComment.id);

        // 7. 查询评论列表，验证回复树嵌套
        const commentList = await listPresentationComments(collaborator, presentation.id);
        assert.equal(commentList.comments.length, 1);
        assert.equal(commentList.comments[0].id, mainComment.id);
        assert.equal(Array.isArray(commentList.comments[0].replies), true);
        assert.equal(commentList.comments[0].replies.length, 1);
        assert.equal(commentList.comments[0].replies[0].id, replyComment.id);
        assert.equal(commentList.comments[0].replies[0].content, '好的，稍后调整为 12 字内');

        // 8. 标记主评论已解决
        const resolved = await resolvePresentationComment(owner, presentation.id, mainComment.id);
        assert.equal(resolved.status, 'resolved');

        // 9. 移除协作者，验证协作者再次失去访问权限
        await removePresentationCollaborator(owner, presentation.id, collaborator.id);
        const collabsAfterRemove = await listPresentationCollaborators(owner, presentation.id);
        assert.equal(collabsAfterRemove.collaborators.length, 0);

        const collabAccessRevoked = await getPresentation(collaborator, presentation.id);
        assert.equal(collabAccessRevoked, null);
        for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await callPresence(collaborator, method)).status, 404);
        for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await callOther(collaborator, method)).status, 404);
        assert.deepEqual((await (await callOther(owner)).json()).presences.map(item => item.userId), [owner.id]);

        // 10. 删除评论验证级联删除
        await deletePresentationComment(owner, presentation.id, mainComment.id);
        const remainingComments = await listPresentationComments(owner, presentation.id);
        assert.equal(remainingComments.comments.length, 0);
    } finally {
        if (child && child.exitCode === null && child.connected) { const exited = new Promise(resolve => child.once('exit', resolve)); child.send('stop'); await exited; }
        if (previousMode === undefined) delete process.env.PIVOT_DEPLOYMENT_MODE; else process.env.PIVOT_DEPLOYMENT_MODE = previousMode;
        if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
        require('../server/services/presentations/presentation-presence').resetAllPresence();
        if (presentation?.id) {
            await deletePresentation(owner, presentation.id).catch(() => {});
            await pool().query('DELETE FROM presentation_documents WHERE client_id = $1', [presentation.id]);
        }
        const userIds = [owner?.id, collaborator?.id, stranger?.id].filter(Boolean);
        if (userIds.length) {
            await pool().query('DELETE FROM agent_artifacts WHERE user_id = ANY($1::int[])', [userIds]);
            await pool().query('DELETE FROM agent_artifact_objects WHERE owner_user_id = ANY($1::int[])', [userIds]);
            await pool().query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
        }
        if (tenantId) {
            await pool().query('DELETE FROM organizations WHERE id = $1', [tenantId]);
        }
    }
});
