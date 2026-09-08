'use strict';

const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { parseJsonObject } = require('./agent-validators');

const DEFAULT_MAX_ATTEMPTS = 4;

function normalizeMetadata(value) {
    return parseJsonObject(value) || {};
}

/**
 * 用 JSONB 比较交换（CAS）更新 Agent run 元数据。
 *
 * 不能在调用方先 SELECT、合并、再无条件 UPDATE：DAG 并发节点、审批、聊天
 * 回写可能同时补不同字段。每次冲突都重新读取并在最新对象上执行 transform，
 * 因而不会让后写者覆盖先写者的键。
 */
async function updateAgentRunMetadataWithRetry(runId, transform, options = {}) {
    const id = String(runId || '').trim();
    if (!id) throw new Error('Agent run id 不能为空。');
    if (typeof transform !== 'function') throw new Error('Agent 元数据更新必须提供转换函数。');
    const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS, 10));
    const userId = options.userId === undefined || options.userId === null ? null : Number(options.userId);
    const ownershipSql = Number.isSafeInteger(userId) && userId > 0 ? ' AND user_id = ?' : '';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const row = await queryOne(`SELECT metadata FROM agent_runs WHERE id = ?${ownershipSql}`, userId ? [id, userId] : [id]);
        if (!row) return null;
        const current = normalizeMetadata(row.metadata);
        const next = transform({ ...current });
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
            throw new Error('Agent 元数据转换函数必须返回对象。');
        }
        const expected = JSON.stringify(current);
        const serialized = JSON.stringify(next);
        const changes = await execute(`
            UPDATE agent_runs
            SET metadata = ?::jsonb, updated_at = ?
            WHERE id = ?${ownershipSql}
              AND COALESCE(metadata, '{}'::jsonb) = ?::jsonb
        `, userId
            ? [serialized, getBeijingTimestamp(), id, userId, expected]
            : [serialized, getBeijingTimestamp(), id, expected]);
        if (Number(changes || 0) === 1) return next;
    }
    const error = new Error('Agent 运行元数据并发更新冲突，请重试。');
    error.code = 'AGENT_METADATA_CONFLICT';
    throw error;
}

async function patchAgentRunMetadata(runId, patch = {}, options = {}) {
    const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    return updateAgentRunMetadataWithRetry(runId, current => ({ ...current, ...safePatch }), options);
}

module.exports = {
    patchAgentRunMetadata,
    updateAgentRunMetadataWithRetry
};
