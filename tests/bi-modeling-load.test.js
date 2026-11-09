'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { fixture, checked, cleanupUser } = require('../scripts/test_support/bi_modeling');
const { queryOne, query, execute } = require('../server/db/client');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const delivery = require('../server/services/data-analysis/bi/delivery');

test('十个授权会话每五秒提交分析并混合刷新，超载单列且已接纳任务保持全局二槽、每人一槽和同一精确口径', { timeout: 300000 }, async t => fixture(async ({ user, model, fact }) => {
    const check = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: check.id, requestKey: crypto.randomUUID() } });
    const readers = [], created = [], overloads = [], samples = [], latencies = [], started = performance.now();
    let server, poll = null, monitoring = null, sampling = false;
    try {
        for (let i = 0; i < 10; i++) readers.push(await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','负载验收') RETURNING id,username,status,unit", [`bi_load_${crypto.randomUUID()}`]));
        const allowed = readers.map(actor => actor.id).join(',');
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_user_ids=? WHERE id=?", [allowed, model.id]);
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [allowed, fact.id]);
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { req.actor = readers.find(actor => Number(actor.id) === Number(req.headers['x-fixture-user'])); next(); });
        app.post('/queries', delivery.handler(async (req, res) => res.status(202).json(await jobs.createModelQuery({ user: req.actor, modelId: model.id, body: req.body }))));
        app.get('/queries/:id', delivery.handler(async (req, res) => res.json(await jobs.getModelJob(req.actor, req.params.id))));
        app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
        server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        poll = setInterval(() => runner.dispatchModelJobs(), 400);
        monitoring = setInterval(async () => {
            if (sampling) return; sampling = true;
            try {
                const rows = await query('SELECT q.user_id,COUNT(*) AS n FROM analysis_runtime_slots s JOIN analysis_query_jobs q ON q.id=s.job_id GROUP BY q.user_id');
                samples.push(rows.map(row => Number(row.n)));
            } finally { sampling = false; }
        }, 100);
        const refresh = await jobs.createModelRefresh({ user, modelId: model.id, body: { publishedVersion: 1, bindingRevision: 1, requestKey: crypto.randomUUID() } });
        const waveStart = Date.now();
        for (let round = 0; round < 2; round++) {
            const wait = waveStart + round * 5000 - Date.now(); if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            await Promise.all(readers.map(async actor => {
                const submittedAt = performance.now(), response = await fetch(`${base}/queries`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': String(actor.id) }, body: JSON.stringify({ publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], execution: 'async', requestKey: crypto.randomUUID() }) });
                const job = await response.json();
                if (response.status === 202) created.push({ actor, id: job.id, submittedAt });
                else {
                    // 首波在公布队列预算内必须接纳；重叠次波的明确队满拒绝单独报告。
                    assert.equal(round, 1); assert.equal(response.status, 429, JSON.stringify(job));
                    assert.equal(job.code, 'ANALYSIS_MODEL_QUEUE_FULL'); assert.equal(job.id, undefined);
                    overloads.push({ userId: actor.id, round, status: response.status, code: job.code });
                }
            }));
        }
        assert.equal(created.length + overloads.length, 20); assert.ok(created.length >= 10);
        const pending = new Set(created);
        while (pending.size && performance.now() - started < 240000) {
            await Promise.all([...pending].map(async item => {
                const response = await fetch(`${base}/queries/${item.id}`, { headers: { 'x-fixture-user': String(item.actor.id) } }), job = await response.json();
                assert.equal(response.status, 200, JSON.stringify(job));
                if (job.status === 'succeeded') {
                    assert.equal(job.result.total.values.amount.value, '250.00'); assert.equal(job.result.total.values.orders.value, '2'); assert.equal(job.result.total.values.average.value, '125.00');
                    latencies.push(performance.now() - item.submittedAt); pending.delete(item);
                } else assert.ok(['queued', 'running', 'retry_wait'].includes(job.status), job.lastError);
            }));
            if (pending.size) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.equal(pending.size, 0);
        while (['queued', 'running', 'retry_wait'].includes((await jobs.getModelJob(user, refresh.job.id)).status) && performance.now() - started < 240000) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.equal((await jobs.getModelJob(user, refresh.job.id)).status, 'succeeded');
        assert.ok(samples.length > 10); assert.ok(samples.every(counts => counts.reduce((total, count) => total + count, 0) <= 2 && counts.every(count => count <= 1)));
        assert.ok(samples.some(counts => counts.reduce((total, count) => total + count, 0) === 2));
        latencies.sort((a, b) => a - b);
        t.diagnostic(JSON.stringify({ sessions: 10, rounds: 2, waveIntervalMs: 5000, attemptedQueries: 20, acceptedQueries: created.length, overloadedQueries: overloads.length, overloads, refreshes: 1, p95Ms: Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]), durationMs: Math.round(performance.now() - started), maxRunning: 2, sourceRows: 3, productionSoak: false }));
    } finally {
        clearInterval(poll); clearInterval(monitoring);
        if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await runner.processModelJobs();
        for (const actor of readers) await cleanupUser(actor);
    }
}));
