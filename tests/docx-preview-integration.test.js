'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { queryOne, execute } = require('../server/db/client');
const { createStandaloneArtifact } = require('../server/services/agent-artifacts');
const { createRendition } = require('../server/services/agent-artifact-renditions');
const { createAgentDeliveryRouter } = require('../server/routes/agent-delivery');

test('DOCX 预览按用户和版本授权，ONLYOFFICE 回源票据限制文件、账号和期限', async () => {
    const owner = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const ir = { ir_version: '1', doc_type: 'report', meta: { title: '旅行方案' }, blocks: [
        { type: 'heading', level: 1, text: '广州之行' }, { type: 'paragraph', runs: [{ text: '行程规划 <script>alert(1)</script>' }] }
    ] };
    const artifact = await createStandaloneArtifact(owner, { type: 'document', title: '旅行方案', content: JSON.stringify(ir) });
    const prior = {};
    for (const key of ['PIVOT_ONLYOFFICE_PATH', 'PIVOT_ONLYOFFICE_PIVOT_URL', 'PIVOT_ONLYOFFICE_JWT_SECRET']) prior[key] = process.env[key];
    process.env.PIVOT_ONLYOFFICE_PATH = '/onlyoffice';
    process.env.PIVOT_ONLYOFFICE_PIVOT_URL = 'http://pivot:3000';
    process.env.PIVOT_ONLYOFFICE_JWT_SECRET = 'onlyoffice-test-secret-0123456789abcdef';
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentDeliveryRouter({ authMiddleware: (req, res, next) => {
        if (req.headers['x-test-user'] === 'owner') { req.user = owner; return next(); }
        if (req.headers['x-test-user'] === 'other') { req.user = { ...owner, id: Number(owner.id) + 999999 }; return next(); }
        res.sendStatus(401);
    } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${service.address().port}/api/agents`;
    try {
        const result = await createRendition({ user: owner, artifactId: artifact.id, toolCallId: 'docx-test:1', ir, format: 'docx' });
        const id = result.rendition.id;
        const local = await fetch(`${base}/renditions/${id}/document-preview`, { headers: { 'x-test-user': 'owner' } });
        assert.equal(local.status, 200);
        const data = await local.json();
        assert.match(data.html, /广州之行/);
        assert.match(data.html, /&lt;script&gt;/);
        assert.doesNotMatch(data.html, /<script>/);
        assert.equal((await fetch(`${base}/renditions/${id}/document-preview`, { headers: { 'x-test-user': 'other' } })).status, 404);
        assert.equal((await fetch(`${base}/renditions/${id}/document-preview`)).status, 401);
        const response = await fetch(`${base}/renditions/${id}/onlyoffice-preview`, { method: 'POST', headers: { 'x-test-user': 'owner' } });
        const config = (await response.json()).onlyoffice;
        const file = new URL(config.editor.document.url);
        const fetched = await fetch(`${base}/onlyoffice/file${file.search}`);
        assert.equal(fetched.status, 200);
        assert.equal((await fetched.arrayBuffer()).byteLength, Number(result.rendition.byte_size));
        assert.equal((await fetch(`${base}/onlyoffice/file?token=invalid`)).status, 403);
        assert.equal((await fetch(`${base}/renditions/${id}/onlyoffice-preview`, { method: 'POST', headers: { 'x-test-user': 'other' } })).status, 404);
        await execute('UPDATE users SET token_version = ? WHERE id = ?', [Number(owner.token_version || 0) + 1, owner.id]);
        assert.equal((await fetch(`${base}/onlyoffice/file${file.search}`)).status, 403);
        await execute('UPDATE users SET token_version = ? WHERE id = ?', [Number(owner.token_version || 0), owner.id]);
        await execute("UPDATE agent_artifact_renditions SET status = 'failed' WHERE id = ?", [id]);
        assert.equal((await fetch(`${base}/onlyoffice/file${file.search}`)).status, 404);
        assert.equal((await fetch(`${base}/renditions/${id}/document-preview`, { headers: { 'x-test-user': 'owner' } })).status, 410);
    } finally {
        await execute('UPDATE users SET token_version = ? WHERE id = ?', [Number(owner.token_version || 0), owner.id]);
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
        await execute('DELETE FROM agent_artifacts WHERE id = ?', [artifact.id]);
        for (const key of Object.keys(prior)) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    }
});
