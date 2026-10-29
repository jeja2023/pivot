'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createExperimentalApiGuard } = require('../server/middleware/experimental-api-guard');
const { OrchestrationDSLParser, OrchestrationExecutor, exampleDSL } = require('../server/services/agent-runtime/orchestration-dsl');

test('未完成的接口先鉴权并返回明确的不可用状态，纯解析接口仍可访问', async () => {
    const app = express();
    const auth = (req, res, next) => req.headers.authorization === 'Bearer test'
        ? next() : res.status(401).json({ error: '未授权' });
    const guard = createExperimentalApiGuard(auth, { allow: [
        { method: 'POST', path: '/parse' },
        { method: 'POST', path: '/validate' },
        { method: 'GET', path: '/example' }
    ] });
    app.use('/api/orchestration', guard, (_req, res) => res.json({ reached: true }));
    app.use('/api/evaluation', createExperimentalApiGuard(auth), (_req, res) => res.json({ reached: true }));
    app.use('/api/tools', createExperimentalApiGuard(auth, { block: [{ method: 'POST', path: '/recommend' }, { method: 'GET', path: '/stats' }] }), (_req, res) => res.json({ reached: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const anonymous = await fetch(`${base}/api/evaluation/suites`);
        assert.equal(anonymous.status, 401);
        const unavailable = await fetch(`${base}/api/evaluation/suites`, { headers: { authorization: 'Bearer test' } });
        assert.equal(unavailable.status, 503);
        assert.equal((await unavailable.json()).code, 'EXPERIMENTAL_API_UNAVAILABLE');
        const execution = await fetch(`${base}/api/orchestration/execute`, { method: 'POST', headers: { authorization: 'Bearer test' } });
        assert.equal(execution.status, 503);
        const parse = await fetch(`${base}/api/orchestration/parse`, { method: 'POST' });
        assert.equal(parse.status, 200);
        const methodMismatch = await fetch(`${base}/api/orchestration/parse`, { headers: { authorization: 'Bearer test' } });
        assert.equal(methodMismatch.status, 503);
        const catalog = await fetch(`${base}/api/tools/catalog`);
        assert.equal(catalog.status, 200);
        const alternate = await fetch(`${base}/api/tools/Recommend/`, { method: 'POST', headers: { authorization: 'Bearer test' } });
        assert.equal(alternate.status, 503);
        const head = await fetch(`${base}/api/tools/stats`, { method: 'HEAD', headers: { authorization: 'Bearer test' } });
        assert.equal(head.status, 503);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('编排执行器在未接入真实运行时前不会报告模拟成功', async () => {
    const executor = new OrchestrationExecutor(null);
    await assert.rejects(executor.execute('anything'), { code: 'ORCHESTRATION_RUNTIME_UNAVAILABLE' });
});

test('DSL 示例保留嵌套步骤、Agent 引用与空依赖', () => {
    const ast = new OrchestrationDSLParser().parse(exampleDSL);
    assert.equal(ast.workflows.length, 1);
    assert.equal(ast.workflows[0].steps.length, 4);
    assert.equal(ast.workflows[0].steps[0].agent, '静态分析师');
    assert.deepEqual(ast.workflows[0].steps[0].dependsOn, []);
    assert.deepEqual(ast.workflows[0].steps[2].dependsOn, ['静态分析', '安全扫描']);
    assert.equal(ast.triggers.length, 1);
});
