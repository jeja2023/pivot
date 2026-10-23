'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { queryOne, execute } = require('../server/db/client');
const { createWorkflowCredential } = require('../server/services/workflow-credentials');
const { synthesizeSpeech } = require('../server/services/speech-synthesis');

test('统一朗读只允许凭据授权账号，使用固定端点且返回有效音频', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const slug = `tts_${Date.now()}`; const credential = await createWorkflowCredential(user, { name: '合成测试', slug, secretValue: 'test-token' });
    const server = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end(); }
        if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ available: true })); }
        res.setHeader('Content-Type', 'audio/wav'); res.end(Buffer.from('RIFF0000WAVEfmt '));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const keys = ['PIVOT_TTS_ENDPOINT', 'PIVOT_TTS_CREDENTIAL', 'ALLOW_SENSITIVE_OUTBOUND_URLS'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.PIVOT_TTS_ENDPOINT = `http://127.0.0.1:${server.address().port}/speech`; process.env.PIVOT_TTS_CREDENTIAL = slug;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        assert.equal((await synthesizeSpeech(user, {}, { method: 'get' })).available, true);
        assert.equal((await synthesizeSpeech(user, { text: '你好' })).subarray(0, 4).toString(), 'RIFF');
        const speech = await require('../server/services/agent-media-generation').executeAgentTextToSpeech({ text: '任务语音' }, user, {
            stepId: 'tts-artifact-test', run: { network_policy: { allowed_origins: [`http://127.0.0.1:${server.address().port}`], allowed_ports: [server.address().port], block_loopback: false, block_private_ranges: false } }
        });
        assert.equal(speech.format, 'wav'); assert.ok(speech.renditionId);
        await execute('DELETE FROM agent_artifacts WHERE id = ?', [speech.artifactId]);
        await assert.rejects(synthesizeSpeech({ id: Number(user.id) + 999999, role: 'user' }, { text: '无权' }), error => error.status === 403);
        await assert.rejects(synthesizeSpeech(user, { text: '字'.repeat(2001) }), error => error.status === 413);
    } finally {
        for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        await new Promise(resolve => server.close(resolve)); await execute('DELETE FROM workflow_credentials WHERE id = ?', [credential.id]);
    }
});
