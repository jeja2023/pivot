'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { materializeToolArtifact } = require('../server/services/tool-result-artifacts');
const { getRenditionForUser, openRenditionContent } = require('../server/services/agent-artifact-renditions');

test('第三方文档与文件按契约登记，绑定实际调用、摘要和一次性下载，过期后拒绝读取', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`tool-files-${suffix}`]);
    const runId = `tool-files-${suffix}`;
    try {
        await execute("INSERT INTO agent_runs(id,user_id,goal,status,metadata,created_at,updated_at) VALUES (?,?,'第三方文件','running','{}',NOW(),NOW())", [runId, user.id]);
        const png = await require('sharp')({ create: { width: 12, height: 12, channels: 4, background: '#ffffff' } }).png().toBuffer();
        const envelope = { kind: 'file', name: '工具图片', format: 'png', mimeType: 'image/png', encoding: 'base64', content: png.toString('base64'), sha256: crypto.createHash('sha256').update(png).digest('hex') };
        const context = { runId, stepId: `${runId}:png` };
        const output = await materializeToolArtifact({ structuredContent: { pivotArtifact: envelope } }, user, context);
        assert.equal(output.format, 'png');
        assert.ok(output.artifactId);
        assert.doesNotMatch(JSON.stringify(output), new RegExp(png.toString('base64').slice(0, 25)));
        const duplicate = await materializeToolArtifact({ structuredContent: { pivotArtifact: envelope } }, user, context);
        assert.equal(duplicate.renditionId, output.renditionId);
        const rendition = await getRenditionForUser(output.renditionId, user);
        const loaded = await openRenditionContent(rendition, user); loaded.stream.destroy();
        const document = await materializeToolArtifact({ structuredContent: { pivotArtifact: { kind: 'document', format: 'docx', ir: {
            ir_version: '1', doc_type: 'report', meta: { title: '工具文档' }, blocks: [{ type: 'paragraph', runs: [{ text: '第三方规范文档' }] }] } } } }, user, { runId, stepId: `${runId}:doc` });
        assert.equal(document.format, 'docx');
        assert.equal(document.structuredContent.pivotArtifact.ir, undefined);
        await execute("UPDATE agent_artifact_objects SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ?", [rendition.storage_ref.replace('artifact-cas://', '')]);
        await assert.rejects(openRenditionContent(rendition, user), error => error.code === 'ARTIFACT_CAS_EXPIRED');
        const { recordToolInvocationEvent } = require('../server/services/tool-invocation-events');
        const deps = { execute: async (sql, params) => { try { return await execute(sql, params); } catch (error) { assert.fail(`调用事件入库失败：${error.code}`); } } };
        assert.ok(await recordToolInvocationEvent({ actorId: user.id, runId, toolName: 'rag.search', source: 'workflow', status: 'success', totalMs: 20 }, deps));
        assert.ok(await recordToolInvocationEvent({ actorId: user.id, runId, toolName: 'rag.search', source: 'workflow', status: 'error', errorCode: 'MCP_TOOL_EXECUTION_ERROR', totalMs: 80 }, deps));
        const metrics = await require('../server/services/tool-chain-metrics').getToolChainMetrics(user);
        assert.equal(metrics.groups[0].sampleCount, 2);
        assert.equal(metrics.groups[0].invocationSuccessRate, .5);
        assert.equal(metrics.groups[0].businessFailures, 1);
        assert.deepEqual((await require('../server/services/tool-chain-metrics').getToolChainMetrics({ id: Number(user.id) + 999999 })).groups, []);
    } finally {
        await execute('DELETE FROM tool_invocation_events WHERE actor_id = ?', [user.id]);
        await execute('DELETE FROM agent_artifacts WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
