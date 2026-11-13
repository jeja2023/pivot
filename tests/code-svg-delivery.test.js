'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { queryOne, execute } = require('../server/db/client');
const { createAgentDeliveryRouter } = require('../server/routes/agent-delivery');

test('SVG 和常见源码格式经真实受控接口创建和下载，拒绝匿名、越权及不安全输入', async () => {
    const owner = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const app = express(); app.use(express.json());
    app.use('/api', createAgentDeliveryRouter({ authMiddleware: (req, res, next) => {
        if (req.headers['x-test-user'] === 'owner') { req.user = owner; return next(); }
        if (req.headers['x-test-user'] === 'other') { req.user = { ...owner, id: Number(owner.id) + 999999 }; return next(); }
        res.sendStatus(401);
    } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${service.address().port}/api/agents`;
    const post = (route, body, user = 'owner') => fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body)
    });
    const artifactIds = [];
    try {
        const input = { filename: '小白兔.svg', language: 'svg', content: '<svg width="400" height="400"><title>小白兔</title><ellipse cx="200" cy="200" rx="80" ry="90" fill="white"/></svg>' };
        assert.equal((await post('/code-renditions', input, '')).status, 401);
        const before = await queryOne('SELECT COUNT(*) AS total FROM agent_artifacts WHERE user_id = ?', [owner.id]);
        const invalid = await post('/code-renditions', { ...input, content: '<svg onload="alert(1)"></svg>' });
        assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'CODE_SVG_INVALID');
        assert.equal((await queryOne('SELECT COUNT(*) AS total FROM agent_artifacts WHERE user_id = ?', [owner.id])).total, before.total);
        assert.equal((await post('/code-renditions', { ...input, filename: '小白兔.exe' })).status, 400);
        const response = await post('/code-renditions', input);
        assert.equal(response.status, 201);
        const data = await response.json(); artifactIds.push(data.artifact.id);
        assert.equal(data.rendition.format, 'svg');
        assert.equal(data.rendition.mime_type, 'image/svg+xml; charset=utf-8');
        const route = `/renditions/${data.rendition.id}`;
        assert.equal((await post(route + '/download-token', {}, '')).status, 401);
        assert.equal((await post(route + '/download-token', {}, 'other')).status, 404);
        const issued = await post(route + '/download-token', {});
        assert.equal(issued.status, 201);
        const { token } = await issued.json();
        const file = await fetch(base + route + `/download?token=${encodeURIComponent(token)}`, { headers: { 'x-test-user': 'owner' } });
        assert.equal(file.status, 200);
        assert.match(file.headers.get('content-type'), /^image\/svg\+xml/);
        assert.match(file.headers.get('content-disposition'), new RegExp(encodeURIComponent('小白兔.svg')));
        assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
        const svg = await file.text();
        assert.match(svg, /小白兔/); assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
        assert.equal(Number(file.headers.get('content-length')), Buffer.byteLength(svg));
        for (const [language, filename, canonical, content, mime] of [
            ['svg', '动画.svg', '动画.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="5"><animate attributeName="cx" from="0" to="100" dur="1s" repeatCount="indefinite"></animate></circle></svg>', 'image/svg+xml'],
            ['html', '页面.htm', '页面.html', '<h1>页面</h1><script>console.log("源码保留")</script>', 'text/html'],
            ['csv', '表格.csv', '表格.csv', '名称,说明\n测试,"包含,逗号"\n', 'text/csv'],
            ['tsv', '表格.tsv', '表格.tsv', '名称\t数量\n测试\t01\n', 'text/tab-separated-values'],
            ['ini', '配置.ini', '配置.ini', '[配置]\nname=测试\n', 'text/plain'],
            ['toml', '配置.toml', '配置.toml', '[配置]\nname="测试"\n', 'application/toml'],
            ['ndjson', '记录.ndjson', '记录.jsonl', '{"名称":"测试"}\n', 'application/x-ndjson'],
            ['csharp', '程序.cs', '程序.cs', 'Console.WriteLine("测试");\n', 'text/plain'],
            ['python3', '程序.py', '程序.py', 'print("测试")\n', 'text/x-python'],
            ['unknown', '源码.txt', '源码.txt', '\n原始源码\n\n\n', 'text/plain']
        ]) {
            const created = await post('/code-renditions', { language, filename, content }); assert.equal(created.status, 201, language);
            const entry = await created.json(); artifactIds.push(entry.artifact.id); assert.equal(entry.artifact.title, canonical);
            const issued = await post(`/renditions/${entry.rendition.id}/download-token`, {}); const { token } = await issued.json();
            const downloaded = await fetch(`${base}/renditions/${entry.rendition.id}/download?token=${encodeURIComponent(token)}`, { headers: { 'x-test-user': 'owner' } });
            assert.equal(downloaded.status, 200); assert.ok(downloaded.headers.get('content-type').startsWith(mime));
            assert.equal(await downloaded.text(), content); assert.equal(Number(downloaded.headers.get('content-length')), Buffer.byteLength(content));
        }
    } finally {
        service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
        for (const id of artifactIds) await execute('DELETE FROM agent_artifacts WHERE id = ?', [id]);
    }
});
