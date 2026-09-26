'use strict';

const crypto = require('crypto');
const { execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function sharedToolGuardConfig(env = process.env) {
    return {
        maxConcurrent: boundedInt(env.PIVOT_TOOL_SHARED_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1, 100),
        leaseMs: boundedInt(env.PIVOT_TOOL_SHARED_LEASE_MS, DEFAULT_LEASE_MS, 10_000, 30 * 60 * 1000)
    };
}

function sharedToolGuardKey({ toolName = '', connectionAccountId = null, serverId = null } = {}) {
    const connection = connectionAccountId ? `connection:${connectionAccountId}` : serverId ? `server:${serverId}` : 'platform';
    return `${connection}|tool:${String(toolName || 'unknown').slice(0, 320)}`;
}

function sharedGuardError(message, code = 'TOOL_SHARED_BULKHEAD_FULL', status = 503) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.category = 'bulkhead';
    return error;
}

async function acquireSharedToolLease(input = {}) {
    const config = { ...sharedToolGuardConfig(input.env || process.env), ...(input.config || {}) };
    const maxConcurrent = boundedInt(input.maxConcurrent, config.maxConcurrent, 1, 100);
    const leaseMs = boundedInt(input.leaseMs, config.leaseMs, 10_000, 30 * 60 * 1000);
    const guardKey = sharedToolGuardKey(input);
    const token = `toollease_${crypto.randomUUID()}`;
    const now = getBeijingTimestamp();
    const expiresAt = getBeijingTimestamp(new Date(Date.now() + leaseMs));
    await transaction(async trx => {
        // PostgreSQL 事务级建议锁在多服务实例间按保护键排队，且不影响不相关的下游工具。
        await trx.queryOne('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [guardKey]);
        await trx.execute('DELETE FROM agent_tool_execution_leases WHERE guard_key = ? AND lease_expires_at <= ?', [guardKey, now]);
        const active = await trx.queryOne(`
            SELECT COUNT(*) AS count
            FROM agent_tool_execution_leases
            WHERE guard_key = ? AND lease_expires_at > ?
        `, [guardKey, now]);
        if (Number(active?.count || 0) >= maxConcurrent) {
            throw sharedGuardError('该工具在所有服务实例上的并发已满，请稍后重试。');
        }
        await trx.execute(`
            INSERT INTO agent_tool_execution_leases (
                lease_token, guard_key, tool_name, connection_account_id, server_id, lease_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [token, guardKey, String(input.toolName || '').slice(0, 320), input.connectionAccountId || null, input.serverId || null, expiresAt, now, now]);
    });
    let released = false;
    return {
        token,
        guardKey,
        expiresAt,
        async release() {
            if (released) return false;
            released = true;
            try {
                return (await execute('DELETE FROM agent_tool_execution_leases WHERE lease_token = ?', [token])) > 0;
            } catch (error) {
                logger.warn({ guardKey, token, err: error.message }, '共享工具并发租约释放失败，将由过期回收处理');
                return false;
            }
        }
    };
}

module.exports = {
    acquireSharedToolLease,
    sharedToolGuardKey
};
