'use strict';

const { query } = require('../db/client');
const { redactRoutingText } = require('./decision-provider');
const { verificationDetails } = require('./task-verification-details');

function parse(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch (_) { return {}; } }
const PROVIDER_REASONS = Object.freeze({ intent_timeout: '任务意图判断超时', intent_invalid_contract: '意图判断响应格式或范围无效',
    intent_provider_unavailable: '意图判断模型调用失败', intent_context_unavailable: '任务理解上下文不可用', intent_context_incomplete: '长请求需要补全原始上下文后再查询', provider_timeout: '决策组件调用超时',
    artifact_not_active: '决策模型制品未启用', provider_version_not_configured: '决策模型版本未配置' });
function safe(value, limit = 240) { return redactRoutingText(String(value || '')).slice(0, limit); }
function safeText(value, limit = 160) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function getDecisionFailureDetails(options = {}, deps = {}) {
    const kind = options.kind === 'provider' ? 'provider' : 'delivery';
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const offset = Math.max(0, Math.min(Number.parseInt(options.offset, 10) || 0, 100000));
    const queryFn = deps.query || query;
    const interval = kind === 'provider' ? 1440 : 30;
    const from = kind === 'provider'
        ? "FROM decision_records d CROSS JOIN LATERAL jsonb_array_elements(d.provider_outputs) p(value) WHERE d.created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute') AND COALESCE(p.value->>'error', '') <> ''"
        : "FROM decision_outcomes o JOIN decision_records d ON d.decision_id=o.decision_id WHERE o.occurred_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day') AND d.scenario='chat.execution' AND o.event_type='execution' AND o.status='failure'";
    try {
        const countPromise = queryFn('SELECT COUNT(*) AS count ' + from, [interval]);
        const sql = kind === 'provider'
            ? "SELECT f.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname FROM (SELECT d.decision_id, d.scenario, d.user_id, d.created_at AS occurred_at, p.value AS provider " + from + ' ORDER BY d.created_at DESC, d.decision_id DESC LIMIT ? OFFSET ?) f LEFT JOIN users u ON u.id=f.user_id ORDER BY f.occurred_at DESC, f.decision_id DESC'
            : "SELECT f.*, COALESCE(r.user_id, f.decision_user_id) AS user_id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, r.created_at AS run_created_at, r.metadata AS run_metadata, r.status AS run_status, v.report AS verification_report FROM (SELECT o.id, d.decision_id, d.user_id AS decision_user_id, o.result_reference AS run_id, o.metadata AS outcome_metadata, o.reason_code, o.occurred_at " + from + ' ORDER BY o.occurred_at DESC, o.id DESC LIMIT ? OFFSET ?) f LEFT JOIN agent_runs r ON r.id=f.run_id LEFT JOIN users u ON u.id=COALESCE(r.user_id, f.decision_user_id) LEFT JOIN agent_verifications v ON v.run_id=r.id ORDER BY f.occurred_at DESC, f.id DESC';
        const [countRows, records] = await Promise.all([countPromise, queryFn(sql, [interval, limit, offset])]);
        const items = records.map(row => {
            const initiator = { userId: safeText(row.user_id, 80), username: safeText(row.username, 128), nickname: safeText(row.nickname, 128) };
            if (kind === 'provider') {
                const provider = parse(row.provider), code = safeText(provider.error, 80);
                return { ...initiator, decisionId: safeText(row.decision_id, 128), scenario: safeText(row.scenario, 80), occurredAt: row.occurred_at,
                    providerId: safeText(provider.providerId, 80), providerVersion: safeText(provider.providerVersion, 128),
                    reasonCode: code, label: PROVIDER_REASONS[code] || '决策组件调用异常', detail: safe(provider.error, 240), durationMs: Math.max(0, Number(provider.durationMs) || 0) };
            }
            const snapshot = parse(row.outcome_metadata).verification;
            const historical = !snapshot;
            const report = parse(row.verification_report || parse(row.run_metadata).taskVerification);
            const detail = snapshot ? { reasonCode: safeText(snapshot.reasonCode, 100), label: safe(snapshot.label), missing: Array.isArray(snapshot.missing) ? snapshot.missing.slice(0, 12).map(value => safe(value, 500)) : [],
                ruleFailures: Array.isArray(snapshot.ruleFailures) ? snapshot.ruleFailures.slice(0, 12).map(rule => ({ key: safeText(rule.key, 100), label: safe(rule.label), detail: safe(rule.detail, 300) })) : [], executionReason: safe(snapshot.executionReason, 500) } : verificationDetails(Object.keys(report).length ? report : null, { historical });
            return { ...initiator, outcomeId: safeText(row.id, 128), decisionId: safeText(row.decision_id, 128), runId: safeText(row.run_id, 160), occurredAt: row.occurred_at, runCreatedAt: row.run_created_at ?? null,
                status: safeText(row.run_status, 40), ...detail, detailSource: snapshot ? 'event_snapshot' : Object.keys(report).length ? 'current_report' : 'unavailable' };
        });
        const total = Number(countRows[0]?.count || 0);
        return { kind, items, total, limit, offset, hasMore: offset + items.length < total, unavailable: false, window: kind === 'provider' ? '24h' : '30d' };
    } catch (error) { return { kind, items: [], total: null, limit, offset, hasMore: false, unavailable: true, errorCode: safeText(error.code || 'failure_details_unavailable', 80) }; }
}

module.exports = { getDecisionFailureDetails };
