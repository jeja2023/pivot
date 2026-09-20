'use strict';

const crypto = require('crypto');

function hexDigest(value, length) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function buildToolTraceContext({ runId = '', spanId = '', parentSpanId = '', requestId = '' } = {}) {
    const traceId = hexDigest(runId || requestId || crypto.randomUUID(), 32);
    const childSpanId = /^[a-f0-9]{16}$/i.test(String(spanId || '').replace(/-/g, '').slice(0, 16))
        ? String(spanId).replace(/-/g, '').slice(0, 16).toLowerCase()
        : hexDigest(spanId || parentSpanId || requestId || crypto.randomUUID(), 16);
    const parent = String(parentSpanId || '').replace(/-/g, '').slice(0, 16).toLowerCase();
    return {
        traceId,
        spanId: childSpanId,
        parentSpanId: /^[a-f0-9]{16}$/i.test(parent) ? parent : '',
        traceparent: `00-${traceId}-${childSpanId}-01`
    };
}

module.exports = { buildToolTraceContext, hexDigest };
