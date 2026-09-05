const { execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const TOOL_CALL_MODES = new Set(['auto', 'enabled', 'disabled']);
const TOOL_CALL_PROBE_STATUSES = new Set(['unknown', 'supported', 'unsupported', 'degraded']);

function normalizeToolCallMode(value, fallback = 'auto') {
    const mode = String(value || '').trim().toLowerCase();
    return TOOL_CALL_MODES.has(mode) ? mode : fallback;
}

function normalizeToolCallProbeStatus(value, fallback = 'unknown') {
    const status = String(value || '').trim().toLowerCase();
    return TOOL_CALL_PROBE_STATUSES.has(status) ? status : fallback;
}

function shouldUseNativeToolCalls(modelCfg = {}, env = process.env) {
    const globalMode = String(env.AGENT_NATIVE_TOOL_CALLS || 'auto').trim().toLowerCase();
    if (['0', 'false', 'disabled', 'off'].includes(globalMode)) return false;
    const mode = normalizeToolCallMode(modelCfg.tool_call_mode ?? modelCfg.toolCallMode);
    if (mode === 'disabled') return false;
    if (mode === 'enabled') return true;
    // auto is the production default. A previously verified incompatibility is
    // sticky until an administrator deliberately changes the model setting.
    return normalizeToolCallProbeStatus(modelCfg.tool_call_probe_status ?? modelCfg.toolCallProbeStatus) !== 'unsupported';
}

function classifyNativeToolCallError(error) {
    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0) || 0;
    const detail = [
        error?.response?.data?.error?.message,
        error?.response?.data?.message,
        error?.message,
        error?.code
    ].filter(Boolean).join(' ').toLowerCase();
    const unsupported = status === 404 || /(?:unsupported|not supported|unknown|unrecognized|invalid).{0,80}(?:tool|tools|tool_calls|function_call)|(?:tool_calls|function_call|tools).{0,80}(?:unsupported|not supported|unknown|unrecognized|invalid)|does not support tools/i.test(detail);
    return {
        status: unsupported ? 'unsupported' : 'degraded',
        httpStatus: status || null,
        reason: String(error?.response?.data?.error?.message || error?.message || error?.code || 'native_tool_calls_failed').slice(0, 1000)
    };
}

async function recordNativeToolCallCapability(modelCfg = {}, result = {}) {
    const modelId = Number(modelCfg?.id || 0);
    if (!Number.isSafeInteger(modelId) || modelId <= 0) return false;
    const status = normalizeToolCallProbeStatus(result.status);
    const protocol = String(result.protocol || '').slice(0, 32);
    const reason = String(result.reason || '').slice(0, 1000);
    const supported = status === 'supported';
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE models
        SET supports_tool_calls = ?,
            tool_call_probe_status = ?,
            tool_call_probe_protocol = ?,
            tool_call_probe_error = ?,
            tool_call_probed_at = ?
        WHERE id = ?
    `, [supported, status, protocol, reason, now, modelId]);
    return changes > 0;
}

module.exports = {
    TOOL_CALL_MODES,
    TOOL_CALL_PROBE_STATUSES,
    classifyNativeToolCallError,
    normalizeToolCallMode,
    normalizeToolCallProbeStatus,
    recordNativeToolCallCapability,
    shouldUseNativeToolCalls
};
