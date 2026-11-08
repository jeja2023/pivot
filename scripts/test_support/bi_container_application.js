'use strict';

// 在隔离容器中启动真实服务入口及后台调度，不以手动调度代替部署验证。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
    assert.equal(process.platform, 'linux');
    assert.equal(process.env.PIVOT_TEST_ANALYSIS_CONTAINER_ACCEPTANCE, 'true');
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_container_[a-f0-9]+$/);
    process.env.PIVOT_TEST_PG_SYNC = 'false';
    process.env.PORT = '3000';
    const { createFixture } = require('./bi_modeling');
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'docker';
    const { user, model } = await createFixture();
    const password = `${crypto.randomBytes(20).toString('hex')}!`;
    await require('../../server/db/client').execute('UPDATE users SET password_hash=? WHERE id=?', [await require('../../server/services/password-hasher').hashPasswordOffThread(password, 12), user.id]);
    const { server } = await require('../../server/index').initPromise;
    const base = 'http://127.0.0.1:3000';
    const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200);
    const shell = await fetch(base); assert.equal(shell.status, 200);
    assert.ok((await shell.text()).includes('<html'));
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password }) });
    assert.equal(login.status, 200, await login.clone().text());
    const cookiePairs = login.headers.getSetCookie().map(value => value.split(';')[0]);
    const cookie = cookiePairs.join('; ');
    const csrfName = require('../../server/auth').CSRF_COOKIE_NAME + '=';
    const csrfCookie = cookiePairs.find(value => value.startsWith(csrfName));
    assert.ok(csrfCookie, '真实登录必须返回CSRF Cookie');
    const csrfToken = decodeURIComponent(csrfCookie.slice(csrfName.length));
    const csrfRejected = await fetch(`${base}/api/apps/data-analysis/models/${model.id}/checks`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: model.version, requestKey: crypto.randomUUID() })
    });
    assert.equal(csrfRejected.status, 403);
    assert.equal((await csrfRejected.json()).code, 'CSRF_INVALID');
    await require('../../server/services/data-analysis/bi/security-journal').flush({ force: true, full: true });
    async function request(route, body) {
        const response = await fetch(`${base}/api/apps/data-analysis${route}`, { method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json(); assert.ok(response.status >= 200 && response.status < 300, JSON.stringify({ status: response.status, value })); return value;
    }
    async function wait(read, complete) {
        const until = Date.now() + 120000;
        let value;
        do { value = await read(); if (complete(value)) return value; await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < until);
        throw new Error(`真实服务后台任务未在期限内完成：${JSON.stringify(value)}`);
    }
    const checked = await request(`/models/${model.id}/checks`, { expectedVersion: model.version, requestKey: crypto.randomUUID() });
    const report = await wait(() => request(`/models/${model.id}/checks/${checked.check.id}`), value => !['queued', 'running', 'retry_wait'].includes(value.check.status));
    assert.equal(report.check.status, 'passed'); assert.equal(report.check.complete, true);
    await request(`/models/${model.id}/publish`, { expectedVersion: model.version, checkId: checked.check.id, requestKey: crypto.randomUUID() });
    const submitted = await request(`/models/${model.id}/queries`, { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], execution: 'async', requestKey: crypto.randomUUID() });
    await wait(async () => {
        const value = await request(`/async-queries/${submitted.job.id}`); return value.job || value;
    }, value => !['queued', 'running', 'retry_wait'].includes(value.status));
    const result = await request(`/async-queries/${submitted.job.id}/results`);
    assert.equal(result.total.values.amount.value, '250.00'); assert.equal(result.total.values.average.value, '125.00');
    const record = { passed: true, actualServerEntry: 'server/index.js', backgroundScheduling: true, health: true, clientShell: true, realLogin: true, csrfMissingRejected: true, csrfProtectedWrite: true, checkPublishQueryHttp: true,
        amount: '250.00', recomputedAverage: '125.00', platform: process.platform, node: process.version, packageVersion: require('../../package.json').version };
    await fs.writeFile(path.join(process.env.DATA_DIR, 'container-application-proof.json'), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`真实容器应用入口验证通过：${JSON.stringify(record)}\n`);
    server.closeIdleConnections();
    process.kill(process.pid, 'SIGTERM');
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; process.kill(process.pid, 'SIGTERM'); });
