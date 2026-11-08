'use strict';

// 由测试控制器传入冻结制品路径，子进程实际加载该制品的应用入口和仓储。
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function main(root, mode, inputFile, outputFile) {
    root = await fs.realpath(root);
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const load = file => require(path.join(root, file));
    const { queryOne } = load('server/db/client');
    let result;
    try {
        if (mode === 'initialize') {
            await load('server/db').initPostgresDatabase();
            result = { version: load('package.json').version, migrated: Number((await queryOne('SELECT COUNT(*) AS n FROM schema_migrations')).n) };
        } else if (mode === 'seed') {
            const user = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`upgrade_${crypto.randomUUID()}`]);
            const fact = await load('server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '升级前完整订单', rows: [{ 编号: '1', 金额: '100.25' }, { 编号: '2', 金额: '149.75' }] });
            const created = await load('server/services/data-analysis/semantic-models').saveDataModel({ user, body: { modelKind: 'production', name: '升级前正式资产', factDatasetId: fact.id, businessOwner: '验收负责人', maintenanceContact: '验收联系人' } });
            const model = await load('server/services/data-analysis/bi/models').saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: created.version, definition: { ...created.definition, grainDescription: '每行一个订单',
                nodes: [{ ...created.definition.nodes[0], grainKeys: ['c_1'] }], dimensions: [], metrics: [{ id: 'amount', name: '金额', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_2' }, scale: 2 }] } } });
            const jobs = load('server/services/data-analysis/bi/jobs'), runner = load('server/services/data-analysis/bi/runner');
            const check = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
            await runner.processModelJobs(); assert.equal((await jobs.getModelCheck(user, model.id, check.check.id)).status, 'passed');
            await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: check.check.id, requestKey: crypto.randomUUID() } });
            const job = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
            await runner.processModelJobs(); assert.equal((await jobs.getModelJob(user, job.id)).result.total.values.amount.value, '250.00');
            const version = await load('server/repositories/analysis-production-models').version(model.id, 1);
            result = { userId: user.id, modelId: model.id, factId: fact.id, modelVersion: model.version, checkId: check.check.id, jobId: job.id, semanticHash: version.semantic_hash };
        } else if (mode === 'queue') {
            const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
            const user = await queryOne('SELECT * FROM users WHERE id=?', [input.userId]);
            const job = await load('server/services/data-analysis/bi/jobs').createModelQuery({ user, modelId: input.modelId, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
            result = { jobId: job.id };
        } else if (mode === 'claim-original-worker') {
            const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
            const before = await queryOne('SELECT status,execution_epoch,attempts FROM analysis_query_jobs WHERE id=?', [input.jobId]);
            await assert.rejects(load('server/repositories/analysis-query-jobs').claim(30000), error => /旧执行器|正式协议/.test(error.message));
            assert.deepEqual(await queryOne('SELECT status,execution_epoch,attempts FROM analysis_query_jobs WHERE id=?', [input.jobId]), before);
            result = { version: load('package.json').version, actualOriginalClaimRejected: true, rowUnchanged: true };
        } else if (mode === 'rollback-read') {
            const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
            await load('server/db').initPostgresDatabase();
            const user = await queryOne('SELECT * FROM users WHERE id=?', [input.userId]);
            const jobs = load('server/services/data-analysis/bi/jobs');
            assert.equal((await jobs.getModelJob(user, input.jobId)).result.total.values.amount.value, '250.00');
            const model = await load('server/services/data-analysis/bi/models').getProductionModel(user, input.modelId);
            assert.equal(model.model.publishedVersion, 1);
            const version = await load('server/repositories/analysis-production-models').version(input.modelId, 1);
            assert.equal(version.semantic_hash, input.semanticHash);
            await assert.rejects(load('server/services/data-analysis/semantic-models').saveDataModel({ user, body: { modelKind: 'production', name: '冻结旧客户端不能新建', factDatasetId: input.factId, businessOwner: '测试', maintenanceContact: '测试' } }), error => /ANALYSIS_RELEASE_CREATE_PAUSED/.test(error.message));
            await assert.rejects(jobs.publishModel({ user, modelId: input.modelId, body: { expectedVersion: input.modelVersion, checkId: input.checkId, requestKey: crypto.randomUUID() } }), error => /ANALYSIS_RELEASE_PUBLISH_PAUSED/.test(error.message));
            await assert.rejects(jobs.createModelQuery({ user, modelId: input.modelId, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } }), error => /ANALYSIS_RELEASE_ADMISSION_PAUSED/.test(error.message));
            const http = require('node:http'), server = http.createServer(load('server/app').app);
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            try {
                const token = load('server/auth').generateAccessToken(user, { sessionIp: '127.0.0.1' });
                const response = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/data-analysis/async-queries/${input.jobId}/results`, { headers: { authorization: `Bearer ${token}` } });
                assert.equal(response.status, 200, await response.clone().text()); assert.ok((await response.text()).includes('250.00'));
            } finally {
                await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
                await load('server/services/db-write-queue').flushAllWrites();
            }
            const state = await queryOne("SELECT create_enabled,publish_enabled,admission_enabled,dispatch_enabled FROM analysis_operation_state WHERE id='main'");
            assert.ok(Object.values(state).every(value => value === false));
            result = { version: load('package.json').version, actualOldApplicationStarted: true, httpReadPassed: true, fixedResult: '250.00', publishedHashPreserved: true,
                newAssetDenied: true, publishDenied: true, admissionDenied: true, controlsPreservedByOldStartup: true };
        } else throw new Error('未知的冻结制品验证操作。');
        await fs.writeFile(outputFile, JSON.stringify(result), { mode: 0o600 });
    } finally { await load('server/db/pg-connection').closePgPool(); }
}

if (require.main === module) main(...process.argv.slice(2)).catch(error => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 1; });
