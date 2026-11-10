'use strict';

const LATENCIES = Object.freeze([10, 50, 100, 250, 500, 1000, 2000, 5000, 15000, 30000, 60000, 120000, 300000, Number.MAX_SAFE_INTEGER]);
const QUOTA_CODES = new Set(['ANALYSIS_MODEL_QUEUE_FULL', 'ANALYSIS_QUERY_QUEUE_FULL', 'ANALYSIS_MODEL_CAPACITY_EXCEEDED', 'ANALYSIS_MODEL_OUTPUT_LIMIT']);

function classify({ status = 200, code = '', cancelled = false } = {}) {
    if (cancelled) return 'cancelled';
    if ([401, 403, 404].includes(status)) return 'auth_denied';
    if (QUOTA_CODES.has(code)) return 'quota_exceeded';
    if (status === 400 || /_(?:INPUT_INVALID|DEFINITION_INVALID|QUERY_INVALID|FLOW_INVALID|VERSION_CONFLICT|REQUEST_CONFLICT|CHECK_REQUIRED|WARNINGS_UNACCEPTED|INGESTION_INVALID)$/.test(code)) return 'invalid';
    if (status >= 400) return 'platform_failure';
    return 'success';
}

function operation(method, route) {
    if (method === 'GET') return /\/models\/?$/.test(route) ? 'list' : 'read';
    if (/\/(publish|rollback)$/.test(route)) return 'publish';
    if (/\/(checks|queries|trial-queries|data-refresh|exports|submit|model-run|pivot|node-preview|node-datasets)$/.test(route)) return 'submit';
    return ['PUT', 'POST', 'DELETE', 'PATCH'].includes(method) ? 'save' : 'other';
}

module.exports = { LATENCIES, classify, operation };
