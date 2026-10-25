'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const schema = require('../client/common/mindmap-document');
const documents = require('../server/services/mindmaps/documents');
const { queryOne, execute } = require('../server/db/client');
const requestKey = () => `test:${crypto.randomUUID()}`;
const tree = label => ({ id: 'root', text: label, children: [{ id: 'child', text: '执行阶段', children: [] }] });

test('导图格式往返保留样式与稳定标识，拒绝危险和超限数据', () => {
    const original = schema.normalize(tree('计划'));
    original.presentation.nodes.child = { color: '#123456', note: '备注', expanded: false };
    original.presentation.layout = 'fishbone';
    original.relations = [{ from: 'root', to: 'child', text: '关联' }];
    const native = schema.toEngine(original);
    assert.deepEqual(schema.fromEngine(native), original);
    assert.throws(() => schema.normalize({ ...original, schemaVersion: 999 }), /版本/);
    assert.throws(() => schema.normalize({ ...tree('x'), children: [{ id: 'root', text: '重复' }] }), /标识/);
    assert.throws(() => schema.normalize({ ...original, presentation: { ...original.presentation, nodes: { child: { color: 'url(http://evil)' } } } }), /颜色/);
    assert.throws(() => schema.normalize({ ...native, root: { data: { uid: 'root', text: '<img>', richText: true } } }), /富文本/);
    assert.throws(() => schema.normalize({ ...tree('x'), image: 'https://external.invalid/image.png' }), /图片/);
    assert.throws(() => schema.normalize({ id: 'root', text: 'x', children: Array.from({ length: schema.LIMITS.nodes }, (_, i) => ({ id: `n-${i}`, text: 'x' })) }), /最多/);
    const circular = tree('x'); circular.children.push(circular); assert.throws(() => schema.normalize(circular), /循环/);
    assert.deepEqual(schema.parseMarkdown(schema.markdown(original)).tree, { id: 'root', text: '计划', children: [{ id: 'node-1', text: '执行阶段', children: [] }] });
    assert.throws(() => schema.parseMarkdown('# 主题\n正文内容'), /仅支持/);
});

test('真实数据库保存支持重试、版本冲突、回滚与删除，禁止通用写入口绕过', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const firstKey = requestKey();
    const created = await documents.save(user, { tree: tree('版本一'), requestKey: firstKey });
    try {
        const replay = await documents.save(user, { tree: tree('版本一'), requestKey: firstKey });
        assert.equal(replay.id, created.id); assert.equal(replay.version, 1);
        const original = created.document; original.presentation.nodes.child = { note: '不能丢失' };
        const attempts = await Promise.allSettled([
            documents.save(user, { artifactId: created.id, document: original, expectedVersionId: created.versionId, requestKey: requestKey() }),
            documents.save(user, { artifactId: created.id, tree: tree('另一个窗口'), expectedVersionId: created.versionId, requestKey: requestKey() })
        ]);
        assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
        const latest = await documents.get(user, created.id);
        const history = await documents.versions(user, created.id);
        assert.equal(history.total, 2);
        const restored = await documents.restore(user, created.id, created.versionId, { expectedVersionId: latest.versionId, requestKey: requestKey() });
        assert.equal(restored.version, 3); assert.equal(restored.document.tree.text, '版本一');
        await assert.rejects(documents.get({ id: Number(user.id) + 999999 }, created.id), error => error.status === 404);
        const manager = new (require('../server/services/agent-runtime/artifact-manager').ArtifactManager)();
        await assert.rejects(manager.update(created.id, user.id, { content: '{}' }), /思维导图/);
        await assert.rejects(manager.restoreVersion(created.id, user.id, 1), /思维导图/);
        await assert.rejects(manager.share(created.id, user.id), /本人/);
        const exportsService = require('../server/services/mindmaps/exports');
        const queued = await exportsService.create(user, created.id, { versionId: created.versionId, format: 'json' });
        await exportsService.drain();
        const job = await exportsService.get(user, queued.id);
        assert.equal(job.status, 'ready');
        const renditionService = require('../server/services/agent-artifact-renditions');
        const rendition = await renditionService.getRenditionForUser(job.renditionId, user);
        const source = await renditionService.readRenditionIr(rendition, user);
        assert.equal(source.versionId, created.versionId); assert.equal(source.document.tree.text, '版本一');
        const authorized = await renditionService.issueDownloadToken(user, job.renditionId); assert.ok(authorized.token);
        await documents.remove(user, created.id, restored.versionId);
        await assert.rejects(documents.get(user, created.id), error => error.status === 404);
        assert.equal(await renditionService.issueDownloadToken(user, job.renditionId), null);
        assert.equal(await require('../server/services/agent-artifacts').getAgentArtifactForUser(created.id, user), null);
    } finally { await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); }
});

test('新导图经 HTTP 路由执行参数校验、分页搜索及原子版本保存', async () => {
    const express = require('express');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const app = express(); app.use(express.json()); const router = express.Router();
    require('../server/routes/apps/mindmaps').registerMindmapRoutes(router, { authMiddleware: (req, res, next) => { if (!req.get('x-test-user')) return res.status(401).json({ error: '请登录' }); req.user = { id: Number(req.get('x-test-user')) }; next(); } });
    app.use('/api', router); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/api/apps/mindmaps`;
    const headers = { 'Content-Type': 'application/json', 'x-test-user': String(user.id) };
    let artifactId;
    try {
        assert.equal((await fetch(origin)).status, 401);
        assert.equal((await fetch(origin + '?page=-1', { headers })).status, 400);
        const response = await fetch(origin, { method: 'POST', headers, body: JSON.stringify({ tree: tree('HTTP验收'), requestKey: requestKey() }) });
        assert.equal(response.status, 201); const created = await response.json(); artifactId = created.id;
        const listing = await (await fetch(origin + '?search=HTTP验收', { headers })).json(); assert.ok(listing.rows.some(row => row.id === artifactId));
        const denied = await fetch(origin + '/' + artifactId, { headers: { ...headers, 'x-test-user': String(Number(user.id) + 999999) } }); assert.equal(denied.status, 404);
        assert.equal((await fetch(origin + '/' + artifactId, { method: 'PUT', headers, body: JSON.stringify({ tree: tree('非法保存'), requestKey: requestKey() }) })).status, 400);
        const imported = await (await fetch(origin + '/import', { method: 'POST', headers, body: JSON.stringify({ format: 'markdown', content: '# 导入\n- 分支' }) })).json(); assert.equal(imported.document.tree.children.length, 1);
    } finally { if (artifactId) await execute('DELETE FROM agent_artifacts WHERE id=?', [artifactId]); await new Promise(resolve => server.close(resolve)); }
});

test('受控浏览器生成图形，清洗后中文 PNG 可渲染且无外部资源', { timeout: 60000 }, async () => {
    const document = schema.normalize(tree('中文图形验证')); document.presentation.layout = 'fishbone';
    const renderer = require('../server/services/mindmaps/renderer');
    const svg = await renderer.render(document, 'svg'); assert.match(svg.buffer.toString(), /中文图形验证/); assert.doesNotMatch(svg.buffer.toString(), /svgjs:data|foreignObject|xmlns:svgjs/);
    const png = await require('../server/services/document-rendering/image-renderer').renderImage({ blocks: [{ type: 'image', asset_ref: 'test' }] }, 'png', { imageResolver: async () => svg.buffer });
    assert.ok(png.length > 500); assert.equal((await require('sharp')(png).metadata()).format, 'png');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1'); let artifact;
    try {
        artifact = await require('../server/services/mindmap').saveMindmap(user, { tree: { id: 'root', text: 'Agent 大图', children: Array.from({ length: 120 }, (_, index) => ({ id: `child-${index}`, text: `分支 ${index}`, children: [] })) }, requestKey: requestKey() });
        assert.ok(artifact.exportJobId); assert.equal(artifact.tree, undefined, '大图通过异步任务交付，不能把整树作为工具结果大包返回');
        await require('../server/services/mindmaps/exports').drain();
        assert.equal((await require('../server/services/mindmaps/exports').get(user, artifact.exportJobId)).status, 'ready');
    } finally { if (artifact) await execute('DELETE FROM agent_artifacts WHERE id=?', [artifact.artifactId]); }
});

test('导出队列限制并发，过期租约恢复后拒绝旧处理器提交', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const repository = require('../server/repositories/mindmaps');
    const created = await documents.save(user, { tree: tree('队列验收'), requestKey: requestKey() });
    try {
        const first = await repository.enqueue(user.id, created.id, created.versionId, 'json');
        assert.equal((await repository.enqueue(user.id, created.id, created.versionId, 'json')).id, first.id);
        for (const format of ['md', 'svg', 'png']) await repository.enqueue(user.id, created.id, created.versionId, format);
        const updated = await documents.save(user, { artifactId: created.id, tree: tree('新版'), requestKey: requestKey(), expectedVersionId: created.versionId });
        await assert.rejects(repository.enqueue(user.id, created.id, updated.versionId, 'json'), error => error.status === 429);
        const claimed = await repository.claimJob(); assert.ok(claimed.lease_token);
        await execute("UPDATE mindmap_exports SET lease_until=NOW()-INTERVAL '1 second' WHERE id=?", [claimed.id]);
        assert.equal(await repository.finishJob(claimed, null, '已过期'), null);
        await assert.rejects(repository.registerRendition(claimed, 1, {}, '', '', '', 0, ''), error => error.code === 'MINDMAP_EXPORT_LEASE_EXPIRED');
        const replacement = await repository.claimJob(); assert.equal(replacement.id, claimed.id); assert.notEqual(replacement.lease_token, claimed.lease_token);
        assert.equal(await repository.finishJob(claimed, null, '旧处理器'), null);
        assert.ok(await repository.finishJob(replacement, null, '测试恢复'));
        assert.equal((await repository.job(user.id, replacement.id)).status, 'failed');
    } finally { await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); }
});

test('分支 AI 使用已保存版本并核验节点和结果，数据转图保留本人聚合来源', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const created = await documents.save(user, { tree: tree('分支分析'), requestKey: requestKey() });
    let dataset;
    try {
        const ai = require('../server/services/mindmaps/ai');
        const expanded = await ai.prepare(user, { mode: 'expand', artifactId: created.id, expectedVersionId: created.versionId, nodeId: 'child' });
        assert.ok(expanded.messages[1].content.includes('执行阶段'));
        assert.equal(expanded.transform(JSON.stringify(tree('展开结果'))).extraPayload.document.tree.text, '展开结果');
        await assert.rejects(ai.prepare(user, { mode: 'expand', artifactId: created.id, expectedVersionId: '99999', nodeId: 'child' }), error => error.status === 409);
        await assert.rejects(ai.prepare({ id: Number(user.id) + 999999 }, { mode: 'summarize', artifactId: created.id, expectedVersionId: created.versionId, nodeId: 'child' }), error => error.status === 404);
        const summarized = await ai.prepare(user, { mode: 'summarize', artifactId: created.id, expectedVersionId: created.versionId, nodeId: 'child' });
        assert.equal(summarized.transform('{"summary":"分支总结"}').extraPayload.summary, '分支总结');
        assert.throws(() => summarized.transform('{"summary":""}'), /总结/);
        const datasets = require('../server/services/data-analysis/datasets');
        dataset = await datasets.createDatasetFromRows({ user, name: '导图来源验收', rows: [{ 类别: '甲', 金额: 10 }, { 类别: '甲', 金额: 15 }, { 类别: '乙', 金额: 8 }] });
        const governance = require('../server/services/data-analysis/governance');
        const view = await governance.saveAnalysisView({ user, datasetId: dataset.id, body: { name: '类别金额汇总', viewType: 'chart', config: { chartType: 'bar', xField: 'c_1', yField: 'c_2', aggregation: 'sum', limit: 20 } } });
        const data = require('../server/services/mindmaps/data-source');
        const choices = await data.views(user); assert.ok(choices.some(item => item.id === view.id));
        const preview = await data.preview(user, view.id); assert.equal(preview.tree.children.length, 2); assert.match(preview.tree.children[0].text, /25/); assert.equal(preview.source.viewId, view.id);
        assert.equal(schema.fromEngine(schema.toEngine(preview), preview).source.datasetId, dataset.id);
        await assert.rejects(data.preview({ id: Number(user.id) + 999999 }, view.id));
        await governance.deleteSavedView(user, view.id);
    } finally {
        await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]);
        if (dataset) await require('../server/services/data-analysis/datasets').softDeleteDataset(user.id, dataset.id);
    }
});
