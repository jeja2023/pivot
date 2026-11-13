'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { getDecisionFailureDetails } = require('../server/services/decision-failure-details');
const { verificationDetails } = require('../server/services/task-verification-details');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');

test('核验失败摘要保留缺项，隐藏凭据与路径，历史已通过报告不伪装失败时快照', () => {
    const detail = verificationDetails({ hardFailures: ['artifact_required', 'deliverables_verified'], semanticVerification: {
        reason: 'artifact_format_missing', missing: ['尚未生成 PPTX', 'token Bearer abcdefghijklmnopqrst /uploads/1/private.docx'] } });
    assert.equal(detail.reasonCode, 'artifact_format_missing'); assert.match(detail.label, /格式/);
    assert.equal(detail.ruleFailures[0].label, '尚未生成要求的文件');
    assert.doesNotMatch(JSON.stringify(detail), /abcdefghijklmnop|private.docx|uploads/);
    assert.equal(verificationDetails(null).reasonCode, 'verification_not_recorded');
    assert.equal(verificationDetails({ outcomeStatus: 'verified' }, { historical: true }).reasonCode, 'historical_details_unavailable');
});

test('分页明细只读取所需记录，故障类型、限额和原始正文隔离', async () => {
    const calls = [];
    const query = async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT COUNT')) return [{ count: 121 }];
        return [{ decision_id: 'decision-one', user_id: 7, username: 'member12345678', nickname: '测试用户', scenario: 'chat.execution', provider: { providerId: 'chat-intent', providerVersion: '8', error: 'intent_timeout', durationMs: 30003 } }];
    };
    const data = await getDecisionFailureDetails({ kind: 'provider', limit: 2000, offset: -1 }, { query });
    assert.equal(data.limit, 100); assert.equal(data.offset, 0); assert.equal(data.hasMore, true);
    assert.equal(data.items[0].label, '任务意图判断超时');
    assert.equal(data.items[0].durationMs, 30003);
    assert.equal(data.items[0].userId, '7'); assert.equal(data.items[0].username, 'member12345678'); assert.equal(data.items[0].nickname, '测试用户');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.params[0] === 1440));
    assert.doesNotMatch(calls[1].sql, /request_state|final_answer|goal|content/);
    const unavailable = await getDecisionFailureDetails({}, { query: async () => { throw Object.assign(new Error('secret'), { code: '42P01' }); } });
    assert.equal(unavailable.unavailable, true); assert.equal(unavailable.total, null); assert.doesNotMatch(JSON.stringify(unavailable), /secret/);
});

test('历史任务没有发起时间时保留缺失，不把失败记录时间当作任务发起时间', async () => {
    const occurredAt = '2026-11-13T06:30:00Z';
    const data = await getDecisionFailureDetails({ kind: 'delivery' }, { query: async sql => sql.startsWith('SELECT COUNT') ? [{ count: 1 }]
        : [{ id: 'historical-event', occurred_at: occurredAt, user_id: null, username: null, nickname: null }] });
    assert.equal(data.items[0].occurredAt, occurredAt);
    assert.equal(data.items[0].runCreatedAt, null);
    assert.equal(data.items[0].userId, ''); assert.equal(data.items[0].username, '');
});

test('事件快照优先于后来核验报告，旧事件明确标记当前报告来源', async () => {
    const snapshot = { reasonCode: 'artifact_not_materialized', label: '尚未生成要求的文件', missing: ['缺少结果文件'], ruleFailures: [] };
    const rows = [
        { id: 'event-one', outcome_metadata: { verification: snapshot }, verification_report: { outcomeStatus: 'verified' } },
        { id: 'event-two', run_metadata: { taskVerification: { outcomeStatus: 'needs_input', hardFailures: ['evidence'], semanticVerification: { reason: 'source_revoked' } } } },
        { id: 'event-three', verification_report: { outcomeStatus: 'verified' } }
    ];
    const data = await getDecisionFailureDetails({}, { query: async sql => sql.startsWith('SELECT COUNT') ? [{ count: 3 }] : rows });
    assert.equal(data.items[0].detailSource, 'event_snapshot'); assert.equal(data.items[0].reasonCode, 'artifact_not_materialized');
    assert.equal(data.items[1].detailSource, 'current_report'); assert.equal(data.items[1].reasonCode, 'source_revoked');
    assert.equal(data.items[2].reasonCode, 'historical_details_unavailable');
});

test('语义核验区分缺失交付物、无效响应、模型不可用和调用超时', async () => {
    const input = { run: { id: 'run', model_id: 1 }, user: { id: 1 }, contract: { deliverables: ['完整报告'], acceptance: {} }, answer: '部分摘要' };
    const deps = { getModel: async () => ({ id: 1 }), resolveMemoryEvidence: async () => ({ current: true, memories: [] }) };
    const missing = await verifyAutomaticTask(input, { ...deps, callModelJson: async () => ({ passed: true, coveredDeliverables: [], missing: [] }) });
    assert.equal(missing.reason, 'deliverables_missing'); assert.deepEqual(missing.missing, ['完整报告']);
    const invalid = await verifyAutomaticTask(input, { ...deps, callModelJson: async () => ({ passed: true }) });
    assert.equal(invalid.reason, 'verifier_invalid_response');
    const timeout = await verifyAutomaticTask(input, { ...deps, callModelJson: async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); } });
    assert.equal(timeout.reason, 'verifier_timeout');
    const unavailable = await verifyAutomaticTask(input, { ...deps, getModel: async () => null });
    assert.equal(unavailable.reason, 'verifier_unavailable');
});

test('组件与交付明细保留含有长数字的 UUID 及版本号标识，不被文本脱敏逻辑截断', async () => {
    const uuidWithDigits = 'failure-details-84991092-0154-4979-8044-f1ce89d2ba6d';
    const decisionWithDigits = 'decision-details-12345678-abcd-ef01-2345-6789abcdef01';
    const rows = [
        { id: uuidWithDigits, decision_id: decisionWithDigits, run_id: uuidWithDigits, outcome_metadata: {}, reason_code: 'source_not_fully_read', run_status: 'partial', run_metadata: { taskVerification: { outcomeStatus: 'needs_input', semanticVerification: { reason: 'source_not_fully_read' } } } }
    ];
    const data = await getDecisionFailureDetails({ kind: 'delivery' }, { query: async sql => sql.startsWith('SELECT COUNT') ? [{ count: 1 }] : rows });
    assert.equal(data.items[0].runId, uuidWithDigits);
    assert.equal(data.items[0].decisionId, decisionWithDigits);
    assert.equal(data.items[0].outcomeId, uuidWithDigits);
    assert.equal(data.items[0].reasonCode, 'source_not_fully_read');
});

test('真实数据库明细联接核验报告，并按24小时组件错误与30天失败事件计数', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id, username, nickname FROM users ORDER BY id LIMIT 1');
    const id = crypto.randomUUID(), decisionId = `decision-details-${id}`, runId = `failure-details-${id}`;
    const initiator = await queryOne("INSERT INTO users(username,password_hash,nickname) VALUES (?, 'test-hash', '实际任务发起人') RETURNING id, username, nickname", ['failure_initiator_' + id]);
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata,created_at) VALUES (?,?,'故障明细测试','测试','partial',?,CURRENT_TIMESTAMP - INTERVAL '15 minutes')", [runId, initiator.id, JSON.stringify({ taskVerification: { outcomeStatus: 'needs_input', semanticVerification: { reason: 'source_not_fully_read' } } })]);
    await execute("INSERT INTO decision_records(decision_id,scenario,user_id,request_state,candidate_actions,provider_outputs,policy_outcome,selected_action_id,created_at,updated_at) VALUES (?,'chat.execution',?,'{}','[]',?,'{}','direct_answer',NOW(),NOW())", [decisionId, user.id, JSON.stringify([{ providerId: 'chat-intent', providerVersion: '1', error: 'intent_timeout', durationMs: 30000 }])]);
    await execute("INSERT INTO decision_outcomes(id,decision_id,event_type,source,status,reason_code,result_reference,metadata,occurred_at,created_at) VALUES (?,?,'execution','runtime','failure','delivery_not_verified',?,'{}',NOW(),NOW())", [id, decisionId, runId]);
    await execute("INSERT INTO decision_outcomes(id,decision_id,event_type,source,status,reason_code,result_reference,metadata,occurred_at,created_at) VALUES (?,?,'execution','runtime','failure','delivery_not_verified',?,'{}',NOW(),NOW())", [id + '-missing', decisionId, runId + '-missing']);
    try {
        const delivery = await getDecisionFailureDetails({ kind: 'delivery', limit: 100 });
        assert.equal(delivery.unavailable, false, JSON.stringify(delivery));
        const deliveryItem = delivery.items.find(item => item.runId === runId);
        assert.ok(deliveryItem, `未在 delivery.items 中找到 runId=${runId}，返回项共 ${delivery.items.length} 条`);
        assert.equal(deliveryItem.reasonCode, 'source_not_fully_read');
        assert.equal(deliveryItem.userId, String(initiator.id)); assert.equal(deliveryItem.username, initiator.username); assert.equal(deliveryItem.nickname, initiator.nickname);
        const run = await queryOne('SELECT created_at FROM agent_runs WHERE id=?', [runId]);
        assert.equal(Date.parse(deliveryItem.runCreatedAt), Date.parse(run.created_at));
        assert.ok(Date.parse(deliveryItem.occurredAt) - Date.parse(deliveryItem.runCreatedAt) >= 14 * 60000);
        const missingRun = delivery.items.find(item => item.runId === runId + '-missing');
        assert.ok(missingRun); assert.equal(missingRun.userId, String(user.id)); assert.equal(missingRun.username, user.username); assert.equal(missingRun.runCreatedAt, null);
        const provider = await getDecisionFailureDetails({ kind: 'provider', limit: 100 });
        assert.equal(provider.unavailable, false, JSON.stringify(provider));
        const providerItem = provider.items.find(item => item.decisionId === decisionId);
        assert.ok(providerItem, `未在 provider.items 中找到 decisionId=${decisionId}，返回项共 ${provider.items.length} 条`);
        assert.equal(providerItem.label, '任务意图判断超时');
        assert.equal(providerItem.userId, String(user.id)); assert.equal(providerItem.username, user.username);
    } finally {
        await execute('DELETE FROM decision_records WHERE decision_id=?', [decisionId]).catch(() => {});
        await execute('DELETE FROM agent_runs WHERE id=?', [runId]).catch(() => {});
        await execute('DELETE FROM users WHERE id=?', [initiator.id]).catch(() => {});
    }
});
