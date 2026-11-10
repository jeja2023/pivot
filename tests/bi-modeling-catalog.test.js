'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const { queryOne, query, execute } = require('../server/db/client');
const service = require('../server/services/data-analysis/semantic-models');
const jobs = require('../server/services/data-analysis/bi/jobs');
const delivery = require('../server/services/data-analysis/bi/delivery');

async function withCatalogJournal(run) {
    const journal = require('../server/services/data-analysis/bi/security-journal');
    const stats = { intervalMs: 1000, completedFlushes: 0, failures: [] };
    let pending = null, failure = null;
    const refresh = () => {
        if (pending || failure) return;
        pending = journal.flush().then(() => { stats.completedFlushes++; }).catch(error => {
            failure = error; stats.failures.push(error.code);
        }).finally(() => { pending = null; });
    };
    refresh(); await pending; if (failure) throw failure;
    // 此测试直接调用服务，必须像正式维护服务一样持续确认真实日志。
    const timer = setInterval(refresh, 1000); timer.unref();
    try { const result = await run(stats); await pending; if (failure) throw failure; return result; }
    finally { clearInterval(timer); await pending; }
}

async function confirmFixtureWrite(sql, params) {
    try { return await execute(sql, params); }
    catch (error) {
        if (error.code !== 'ANALYSIS_SECURITY_COMMITTED_PENDING' || !error.applied || !error.securityTransactionId) throw error;
        // 批量夹具已提交，只继续确认同一持久事件事务，禁止重复插入或跳过独立日志。
        for (let attempt = 0; attempt < 4; attempt++) {
            try { await require('../server/services/data-analysis/bi/security-journal').committed({ transactionId: error.securityTransactionId }); return; }
            catch (pending) { if (pending.code !== 'ANALYSIS_SECURITY_COMMITTED_PENDING' || attempt === 3) throw pending; }
        }
    }
}

async function publish(user, model) {
    const report = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
}

async function readerFixture(run) {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','目录验收') RETURNING id,username,status,unit", [`bi_catalog_${crypto.randomUUID()}`]);
    try { await run(reader); }
    finally { await execute('DELETE FROM users WHERE id=?', [reader.id]); }
}

test('千个模型、多主体和共享范围的真实 HTTP 目录按当前身份批量读取并记录延迟', async t => fixture(async ({ user, model, fact }) => {
    await publish(user, model);
    await withCatalogJournal(async journalStats => readerFixture(async reader => {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_units='目录验收' WHERE id=?", [fact.id]);
        await confirmFixtureWrite(`INSERT INTO analysis_data_models(id,user_id,name,description,scope,allowed_units,allowed_user_ids,version,model_kind,definition_json,semantic_hash,published_version,business_owner,maintenance_contact)
            SELECT ?||n,?, '容量目录'||n,'批量元数据验证',CASE WHEN n%3=0 THEN 'personal' ELSE 'shared' END,
            CASE WHEN n%3=1 THEN '目录验收' ELSE '' END,CASE WHEN n%3=2 THEN ? ELSE '' END,version,model_kind,definition_json,semantic_hash,published_version,business_owner,maintenance_contact
            FROM analysis_data_models CROSS JOIN generate_series(1,1000) AS n WHERE id=?`, [`${model.id}_catalog_`, user.id, String(reader.id), model.id]);
        await confirmFixtureWrite(`INSERT INTO analysis_data_model_versions(model_id,version,definition_json,semantic_hash,policy_json,published_by,request_key,request_hash,review_json,warning_acceptance_json)
            SELECT m.id,v.version,v.definition_json,v.semantic_hash,v.policy_json,v.published_by,m.id,v.request_hash,v.review_json,v.warning_acceptance_json
            FROM analysis_data_models m CROSS JOIN analysis_data_model_versions v WHERE m.user_id=? AND m.id<>? AND v.model_id=?`, [user.id, model.id, model.id]);
        await confirmFixtureWrite(`INSERT INTO analysis_model_data_bindings(model_id,published_version,manifest_id,check_id)
            SELECT m.id,b.published_version,b.manifest_id,b.check_id FROM analysis_data_models m CROSS JOIN analysis_model_data_bindings b WHERE m.user_id=? AND m.id<>? AND b.model_id=?`, [user.id, model.id, model.id]);
        const count = await queryOne('SELECT COUNT(*) AS total FROM analysis_data_models WHERE user_id=?', [user.id]);
        assert.equal(Number(count.total), 1001);
        await require('../server/services/data-analysis/bi/security-journal').flush({ force: true });
        const app = express();
        app.get('/:actor', delivery.handler(async (req, res) => res.json(await service.listDataModels(req.params.actor === 'owner' ? user : reader, { limit: 200 }))));
        app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const samples = [];
            for (let group = 0; group < 5; group++) {
                const responses = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
                    const started = performance.now();
                    const response = await fetch(`http://127.0.0.1:${server.address().port}/${index % 2 ? 'owner' : 'reader'}`);
                    const body = await response.json();
                    samples.push(performance.now() - started);
                    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.length, 200);
                    assert.equal(response.headers.get('cache-control'), 'private, no-store');
                    assert.ok(body.every(item => item.availability === 'available' && item.publishedVersion === 1 && item.definition === undefined && item.sources === undefined));
                    return body;
                }));
                assert.ok(responses[0].every(item => !item.isOwner && item.scope === 'shared'));
                assert.ok(responses[1].every(item => item.isOwner));
            }
            samples.sort((a, b) => a - b);
            const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
            t.diagnostic(JSON.stringify({ models: 1001, sessions: 4, requests: samples.length, pageSize: 200, p95Ms: Math.round(p95), maxMs: Math.round(samples.at(-1)), hardwareScope: 'local', backgroundSecurityJournal: journalStats }));
            assert.ok(p95 <= 1000, `本机目录 p95 ${p95.toFixed(1)}ms 超过方案 1000ms`);
        } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    }));
}));

test('目录摘要不泄露不可用来源，复合关联字段撤权后状态关闭，准备后的共享撤销阻止交付', async () => fixture(async ({ user, model, fact }) => {
    await publish(user, model);
    await readerFixture(async reader => {
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), model.id]);
        let summary = (await service.listDataModels(reader))[0];
        assert.equal(summary.availability, 'source_unavailable'); assert.equal(summary.dataTimes, undefined);
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), fact.id]);
        summary = (await service.listDataModels(reader))[0]; assert.equal(summary.availability, 'available');
        await execute("INSERT INTO analysis_field_governance(dataset_id,user_id,field_key,sensitivity) VALUES (?,?,'c_1','restricted')", [fact.id, user.id]);
        summary = (await service.listDataModels(reader))[0]; assert.equal(summary.availability, 'source_unavailable');
        assert.equal(summary.definition, undefined); assert.equal(summary.dataBinding, undefined);
        await execute("UPDATE analysis_field_governance SET sensitivity='internal' WHERE dataset_id=?", [fact.id]);
        const prepared = await service.listDataModels(reader);
        await execute("UPDATE analysis_data_models SET scope='personal' WHERE id=?", [model.id]);
        let sent = false;
        await assert.rejects(delivery.consume(prepared, () => { sent = true; }), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
        assert.equal(sent, false);
        assert.equal((await service.listDataModels({ ...reader, unit: user.unit })).length, 0);
        await execute("UPDATE users SET status='disabled' WHERE id=?", [reader.id]);
        await assert.rejects(service.listDataModels(reader), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
    });
}));

test('旧探索仍按范围可见，共享正式草稿不进入目录，草稿变更后旧摘要不交付', async () => fixture(async ({ user, model }) => {
    await readerFixture(async reader => {
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_user_ids=? WHERE id=?", [String(reader.id), model.id]);
        assert.equal((await service.listDataModels(reader)).length, 0);
        await service.saveDataModel({ user, body: { name: '旧探索目录' } });
        const ownerRows = await service.listDataModels(user);
        assert.equal(ownerRows.filter(row => row.modelKind === 'exploration').length, 1);
        await execute('UPDATE analysis_data_models SET version=version+1 WHERE id=?', [model.id]);
        await assert.rejects(delivery.consume(ownerRows, () => {}), error => error.code === 'ANALYSIS_MODEL_VERSION_CONFLICT');
        const revisions = await query("SELECT revision FROM analysis_authorization_revisions WHERE resource_kind='model' AND resource_id=?", [model.id]);
        assert.ok(revisions.length);
    });
}));
test('模型目录在二百条之后仍可按名称检索、稳定分页并返回真实筛选总数', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    await confirmFixtureWrite(`INSERT INTO analysis_data_models(id,user_id,name,description,version,model_kind,definition_json,semantic_hash,business_owner,maintenance_contact,updated_at)
        SELECT ?||n,?,'目录模型'||n,'分页样例',version,model_kind,definition_json,semantic_hash,business_owner,maintenance_contact,NOW()-n*INTERVAL '1 second'
        FROM analysis_data_models CROSS JOIN generate_series(1,220) n WHERE id=?`, [`${model.id}_page_`, user.id, model.id]);
    const directory = input => service.listDataModels(user, { page: 1, limit: 10, ...input });
    const first = await directory({});
    assert.equal(first.total, 221); assert.equal(first.models.length, 10);
    await delivery.consume(first, value => { assert.equal(value.models.length, 10); });
    await execute('UPDATE analysis_data_models SET updated_at=NOW() WHERE id=?', [model.id]);
    const fractional = await directory({ search: model.name });
    await delivery.consume(fractional, value => { assert.equal(value.total, 1); });
    const second = await directory({ page: 2 });
    assert.equal(new Set([...first.models, ...second.models].map(item => item.id)).size, 20);
    const last = await directory({ search: '目录模型220' });
    assert.equal(last.total, 1); assert.equal(last.models[0].id, `${model.id}_page_220`);
    assert.equal((await directory({ page: 23 })).models.length, 1);
    assert.equal((await directory({ ownership: 'shared' })).total, 0);
    assert.equal((await directory({ lifecycle: 'published' })).total, 0);
    assert.equal((await directory({ availability: 'available' })).total, 221);
    await execute('UPDATE analysis_datasets SET deleted_at=NOW() WHERE id=?', [fact.id]);
    assert.equal((await directory({ availability: 'available' })).total, 0);
    assert.equal((await directory({ availability: 'source_unavailable' })).total, 221);
    for (const input of [{ page: 0 }, { limit: 201 }, { ownership: 'invalid' }, { search: 'x'.repeat(121) }]) await assert.rejects(directory(input), error => error.code === 'ANALYSIS_MODEL_INPUT_INVALID');
}));
