'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../../server/db/client');
const semanticModels = require('../../server/services/data-analysis/semantic-models');
const models = require('../../server/services/data-analysis/bi/models');
const service = require('../../server/services/data-analysis/bi/jobs');
const runner = require('../../server/services/data-analysis/bi/runner');

process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true';
process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';

async function cleanupConfirmed(sql, params) {
    try { return await execute(sql, params); }
    catch (error) {
        if (error.code !== 'ANALYSIS_SECURITY_COMMITTED_PENDING' || !error.applied || !error.securityTransactionId) throw error;
        // 批量测试夹具清理允许合理超过单个同步确认（ACK）时间窗口；数据行已删除，
        // 直接完成当前持久化事件事务，不伪造回滚或重试 DML。

        for (let attempt = 0; attempt < 4; attempt++) {
            try { await require('../../server/services/data-analysis/bi/security-journal').committed({ transactionId: error.securityTransactionId }); return; }
            catch (pending) { if (pending.code !== 'ANALYSIS_SECURITY_COMMITTED_PENDING' || attempt === 3) throw pending; }
        }
    }
}

async function createFixture() {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomBytes(6).toString('hex');
    const user = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`bi_pipeline_${suffix}`]);
    try {
        const fact = await require('../../server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '订单', rows: [{ 订单: 'a', 明细: '1', 金额: '100.25', 地区: '北' }, { 订单: 'a', 明细: '2', 金额: '99.75', 地区: '北' }, { 订单: 'b', 明细: '1', 金额: '50.00', 地区: '南' }] });
        const created = await semanticModels.saveDataModel({ user, body: { modelKind: 'production', name: '订单分析', factDatasetId: fact.id, businessOwner: '订单业务负责人', maintenanceContact: '订单维护联系人' } });
        const saved = await models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 1, definition: { ...created.definition, grainDescription: '一条订单商品明细', nodes: [{ ...created.definition.nodes[0], grainKeys: ['c_1', 'c_2'] }],
            dimensions: [{ id: 'region', name: '地区', nodeId: 'fact', fieldKey: 'c_4' }], metrics: [{ id: 'amount', name: '实付金额', description: '订单明细实付', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_3' }, currency: 'CNY' },
                { id: 'orders', type: 'count_distinct', field: { nodeId: 'fact', fieldKey: 'c_1' } }, { id: 'average', type: 'derived', expression: { op: 'divide', args: [{ metricId: 'amount' }, { metricId: 'orders' }] } }] } } });
        return { user, model: saved, fact };
    } catch (error) { await cleanupUser(user); throw error; }
}

async function fixture(run) {
    const created = await createFixture();
    let failure;
    try { return await run(created); }
    catch (error) { failure = error; throw error; }
    finally {
        try { await cleanupUser(created.user); }
        catch (error) { if (!failure) throw error; }
    }
}

async function cleanupUser(user) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    assert.ok(Number.isSafeInteger(Number(user?.id)) && Number(user.id) > 0);
        await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_dashboard_items WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_saved_views WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_refresh_runs WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_dashboards WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_ingestion_sessions WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_model_data_bindings WHERE model_id IN (SELECT id FROM analysis_data_models WHERE user_id=?)', [user.id]);
        await execute('UPDATE analysis_data_models SET sharing_review_id=NULL WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_model_reviews WHERE owner_id=?', [user.id]);
        await execute('DELETE FROM analysis_data_model_checks WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_data_model_versions WHERE published_by=?', [user.id]);
        await execute('DELETE FROM analysis_source_manifests WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [user.id]);
        await cleanupConfirmed('DELETE FROM analysis_data_models WHERE user_id=?', [user.id]);
        await cleanupConfirmed('DELETE FROM users WHERE id=?', [user.id]);
}

async function checked(user, model) {
    const input = { user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } };
    const created = await service.createModelCheck(input);
    assert.equal(created.check.status, 'queued');
    assert.equal((await service.createModelCheck(input)).check.id, created.check.id);
    await runner.processModelJobs();
    const report = await service.getModelCheck(user, model.id, created.check.id);
    assert.equal(report.status, 'passed', JSON.stringify(report.report)); assert.equal(report.complete, true);
    return report;
}

module.exports = { fixture, createFixture, checked, cleanupUser };
