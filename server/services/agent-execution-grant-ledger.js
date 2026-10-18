'use strict';

/*
 * 执行授权账本：签名令牌保证内容不可伪造，账本保证同一短期令牌不能被
 * 重放。控制面签发后先登记，执行面在启动 Worker 前原子消费一次。
 */
const crypto = require('crypto');
const { transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

function ledgerError(message, code = 'AGENT_EXECUTION_GRANT_LEDGER_INVALID', status = 403) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'policy';
    return error;
}

function tokenDigest(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function claimFields(payload = {}) {
    const grantId = String(payload.grantId || '').trim();
    const runId = String(payload.runId || '').trim();
    const userId = Number.parseInt(payload.userId, 10);
    const inputDigest = String(payload.inputDigest || '').trim();
    const policySnapshot = String(payload.policySnapshot || '').trim();
    const expiresAt = Number(payload.exp || 0) ? new Date(Number(payload.exp) * 1000).toISOString() : '';
    const issuedAt = Number(payload.iat || 0) ? new Date(Number(payload.iat) * 1000).toISOString() : '';
    if (!/^[0-9a-f-]{36}$/i.test(grantId) || !runId || !Number.isSafeInteger(userId) || userId <= 0
        || !/^[a-f0-9]{64}$/.test(inputDigest) || !/^[a-f0-9]{64}$/.test(policySnapshot) || !expiresAt || !issuedAt) {
        throw ledgerError('执行授权账本载荷不完整。', 'AGENT_EXECUTION_GRANT_CLAIM_INVALID', 400);
    }
    return {
        grantId,
        runId,
        userId,
        tenantId: Number.parseInt(payload.tenantId, 10) || 0,
        tool: String(payload.tool || '').slice(0, 160),
        capability: String(payload.capability || '').slice(0, 120),
        inputDigest,
        policySnapshot,
        workspaceScope: String(payload.workspace?.scopeId || '').slice(0, 160),
        networkMode: String(payload.network?.mode || '').slice(0, 16),
        issuedAt,
        expiresAt
    };
}

function createExecutionGrantLedger(deps = {}) {
    const withTransaction = deps.transaction || transaction;
    const now = deps.now || (() => getBeijingTimestamp());

    async function registerExecutionGrant({ token, payload } = {}) {
        const fields = claimFields(payload);
        const digest = tokenDigest(token);
        return await withTransaction(async trx => {
            const existing = await trx.queryOne('SELECT grant_id, token_digest FROM agent_execution_grants WHERE grant_id = ? FOR UPDATE', [fields.grantId]);
            if (existing) {
                if (String(existing.token_digest || '') !== digest) throw ledgerError('执行授权 ID 冲突。', 'AGENT_EXECUTION_GRANT_ID_CONFLICT', 409);
                return { registered: false, grantId: fields.grantId };
            }
            await trx.execute(`
                INSERT INTO agent_execution_grants (
                    grant_id, run_id, user_id, tenant_id, tool_name, capability, input_digest, policy_snapshot,
                    workspace_scope, network_mode, token_digest, claims, status, issued_at, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'issued', ?, ?, ?, ?)
            `, [
                fields.grantId, fields.runId, fields.userId, fields.tenantId, fields.tool, fields.capability,
                fields.inputDigest, fields.policySnapshot, fields.workspaceScope, fields.networkMode, digest,
                JSON.stringify(payload), fields.issuedAt, fields.expiresAt, now(), now()
            ]);
            return { registered: true, grantId: fields.grantId };
        });
    }

    async function consumeExecutionGrant({ token, payload, consumer = '' } = {}) {
        const fields = claimFields(payload);
        const digest = tokenDigest(token);
        const safeConsumer = String(consumer || '').slice(0, 160);
        return await withTransaction(async trx => {
            const current = now();
            const claimed = await trx.queryOne(`
                UPDATE agent_execution_grants
                SET status = 'consumed', consumed_at = ?, consumer = ?, updated_at = ?
                WHERE grant_id = ?
                  AND token_digest = ?
                  AND run_id = ?
                  AND user_id = ?
                  AND tool_name = ?
                  AND capability = ?
                  AND input_digest = ?
                  AND policy_snapshot = ?
                  AND workspace_scope = ?
                  AND status = 'issued'
                  AND expires_at > ?
                RETURNING grant_id, run_id, user_id, tool_name, capability, consumed_at, expires_at
            `, [
                current, safeConsumer, current, fields.grantId, digest, fields.runId, fields.userId, fields.tool,
                fields.capability, fields.inputDigest, fields.policySnapshot, fields.workspaceScope, current
            ]);
            if (claimed) return { consumed: true, grant: claimed };
            const existing = await trx.queryOne('SELECT status, expires_at FROM agent_execution_grants WHERE grant_id = ? AND token_digest = ?', [fields.grantId, digest]);
            if (!existing) throw ledgerError('执行授权未登记或不属于当前令牌。', 'AGENT_EXECUTION_GRANT_NOT_REGISTERED', 403);
            if (new Date(existing.expires_at).getTime() <= new Date(current).getTime()) {
                await trx.execute("UPDATE agent_execution_grants SET status = 'expired', updated_at = ? WHERE grant_id = ? AND status = 'issued'", [current, fields.grantId]);
                throw ledgerError('执行授权已过期。', 'AGENT_EXECUTION_GRANT_EXPIRED', 403);
            }
            if (existing.status === 'consumed') throw ledgerError('执行授权已被消费，禁止重放。', 'AGENT_EXECUTION_GRANT_REPLAYED', 409);
            throw ledgerError('执行授权不可用。', 'AGENT_EXECUTION_GRANT_UNAVAILABLE', 403);
        });
    }

    async function revokeExecutionGrant({ grantId, runId = '', reason = '' } = {}) {
        const id = String(grantId || '').trim();
        if (!id) return false;
        return await withTransaction(async trx => {
            const changes = await trx.execute(`
                UPDATE agent_execution_grants
                SET status = 'revoked', revoked_at = ?, updated_at = ?, consumer = CASE WHEN consumer = '' THEN ? ELSE consumer END
                WHERE grant_id = ? AND status = 'issued'${runId ? ' AND run_id = ?' : ''}
            `, runId ? [now(), now(), String(reason).slice(0, 160), id, String(runId)] : [now(), now(), String(reason).slice(0, 160), id]);
            return changes === 1;
        });
    }

    return { consumeExecutionGrant, registerExecutionGrant, revokeExecutionGrant };
}

const defaultLedger = createExecutionGrantLedger();

module.exports = {

    consumeExecutionGrant: defaultLedger.consumeExecutionGrant,
    createExecutionGrantLedger,

    registerExecutionGrant: defaultLedger.registerExecutionGrant,

    tokenDigest
};
