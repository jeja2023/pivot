'use strict';

// SSE 重连游标是数据库事件 ID，不使用 Number 以免大整数精度丢失。
function normalizeRealtimeCursor(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return '0';
    const raw = String(value ?? '').trim();
    if (!/^\d{1,19}$/.test(raw)) return '0';
    const id = BigInt(raw);
    return id > 0n && id <= 9223372036854775807n ? id.toString() : '0';
}

module.exports = { normalizeRealtimeCursor };
