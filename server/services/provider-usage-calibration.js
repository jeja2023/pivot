const { execute, queryOne } = require('../db/client');
const { estimateTokens } = require('../llm');
const { toProviderInput } = require('./agent-provider-envelope');

function safeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function firstNumeric(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return Math.floor(number);
    }
    return null;
}

function normalizeProviderUsage(usage) {
    const source = usage?.usage || usage?.response?.usage || usage || {};
    const inputTokens = firstNumeric(source.input_tokens, source.prompt_tokens, source.inputTokens);
    const outputTokens = firstNumeric(source.output_tokens, source.completion_tokens, source.outputTokens);
    const reportedTotal = firstNumeric(source.total_tokens, source.totalTokens);
    const totalTokens = reportedTotal === null
        ? (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens)
        : reportedTotal;
    return {
        inputTokens,
        outputTokens,
        totalTokens,
        inputAvailable: inputTokens !== null,
        outputAvailable: outputTokens !== null,
        totalAvailable: totalTokens !== null,
        raw: source
    };
}

function estimateProviderUsage(messages, output) {
    let providerMessages;
    try { providerMessages = toProviderInput(messages); } catch (_) { providerMessages = messages; }
    return {
        inputTokens: estimateTokens(JSON.stringify(providerMessages || [])),
        outputTokens: estimateTokens(String(output || ''))
    };
}

function calculateUsageCalibrationSample({ estimatedInputTokens = 0, estimatedOutputTokens = 0, usage } = {}) {
    const actual = normalizeProviderUsage(usage);
    if (!actual.inputAvailable && !actual.outputAvailable) return null;
    const estimatedInput = safeCount(estimatedInputTokens);
    const estimatedOutput = safeCount(estimatedOutputTokens);
    const actualInput = actual.inputAvailable ? actual.inputTokens : 0;
    const actualOutput = actual.outputAvailable ? actual.outputTokens : 0;
    return {
        inputAvailable: actual.inputAvailable,
        outputAvailable: actual.outputAvailable,
        estimatedInputTokens: estimatedInput,
        estimatedOutputTokens: estimatedOutput,
        actualInputTokens: actualInput,
        actualOutputTokens: actualOutput,
        inputSignedError: actual.inputAvailable ? actualInput - estimatedInput : 0,
        outputSignedError: actual.outputAvailable ? actualOutput - estimatedOutput : 0,
        inputAbsError: actual.inputAvailable ? Math.abs(actualInput - estimatedInput) : 0,
        outputAbsError: actual.outputAvailable ? Math.abs(actualOutput - estimatedOutput) : 0,
        actualTotalTokens: actual.totalAvailable
            ? actual.totalTokens
            : actualInput + actualOutput
    };
}

function protocolFromUsage(usage, fallback = 'unknown') {
    const explicit = String(usage?.protocol || '').trim().toLowerCase();
    if (explicit) return explicit.slice(0, 32);
    if (usage?.prompt_tokens !== undefined || usage?.completion_tokens !== undefined) return 'chat_completions';
    if (usage?.input_tokens !== undefined || usage?.output_tokens !== undefined) return 'responses';
    return String(fallback || 'unknown').trim().toLowerCase().slice(0, 32) || 'unknown';
}

async function recordProviderUsageCalibration({ modelId, protocol = 'unknown', source = 'agent', messages, output, estimated, usage } = {}) {
    const normalizedModelId = Number(modelId);
    if (!Number.isSafeInteger(normalizedModelId) || normalizedModelId <= 0) return null;
    const estimate = estimated || estimateProviderUsage(messages, output);
    const sample = calculateUsageCalibrationSample({
        estimatedInputTokens: estimate.inputTokens,
        estimatedOutputTokens: estimate.outputTokens,
        usage
    });
    if (!sample) return null;
    const safeProtocol = protocolFromUsage(usage, protocol);
    const now = new Date().toISOString();
    await execute(`
        INSERT INTO model_usage_calibrations (
            model_id, protocol, sample_count, input_sample_count, output_sample_count,
            estimated_input_tokens, actual_input_tokens, input_abs_error_tokens, input_signed_error_tokens, max_input_abs_error_tokens,
            estimated_output_tokens, actual_output_tokens, output_abs_error_tokens, output_signed_error_tokens, max_output_abs_error_tokens,
            last_actual_total_tokens, last_source, last_sample_at, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (model_id, protocol) DO UPDATE SET
            sample_count = model_usage_calibrations.sample_count + 1,
            input_sample_count = model_usage_calibrations.input_sample_count + EXCLUDED.input_sample_count,
            output_sample_count = model_usage_calibrations.output_sample_count + EXCLUDED.output_sample_count,
            estimated_input_tokens = model_usage_calibrations.estimated_input_tokens + EXCLUDED.estimated_input_tokens,
            actual_input_tokens = model_usage_calibrations.actual_input_tokens + EXCLUDED.actual_input_tokens,
            input_abs_error_tokens = model_usage_calibrations.input_abs_error_tokens + EXCLUDED.input_abs_error_tokens,
            input_signed_error_tokens = model_usage_calibrations.input_signed_error_tokens + EXCLUDED.input_signed_error_tokens,
            max_input_abs_error_tokens = GREATEST(model_usage_calibrations.max_input_abs_error_tokens, EXCLUDED.max_input_abs_error_tokens),
            estimated_output_tokens = model_usage_calibrations.estimated_output_tokens + EXCLUDED.estimated_output_tokens,
            actual_output_tokens = model_usage_calibrations.actual_output_tokens + EXCLUDED.actual_output_tokens,
            output_abs_error_tokens = model_usage_calibrations.output_abs_error_tokens + EXCLUDED.output_abs_error_tokens,
            output_signed_error_tokens = model_usage_calibrations.output_signed_error_tokens + EXCLUDED.output_signed_error_tokens,
            max_output_abs_error_tokens = GREATEST(model_usage_calibrations.max_output_abs_error_tokens, EXCLUDED.max_output_abs_error_tokens),
            last_actual_total_tokens = EXCLUDED.last_actual_total_tokens,
            last_source = EXCLUDED.last_source,
            last_sample_at = EXCLUDED.last_sample_at,
            updated_at = EXCLUDED.updated_at
    `, [
        normalizedModelId,
        safeProtocol,
        sample.inputAvailable ? 1 : 0,
        sample.outputAvailable ? 1 : 0,
        sample.inputAvailable ? sample.estimatedInputTokens : 0,
        sample.inputAvailable ? sample.actualInputTokens : 0,
        sample.inputAbsError,
        sample.inputSignedError,
        sample.inputAbsError,
        sample.outputAvailable ? sample.estimatedOutputTokens : 0,
        sample.outputAvailable ? sample.actualOutputTokens : 0,
        sample.outputAbsError,
        sample.outputSignedError,
        sample.outputAbsError,
        sample.actualTotalTokens,
        String(source || 'agent').slice(0, 80),
        now,
        now,
        now
    ]);
    return sample;
}

function normalizeCalibrationRow(row) {
    if (!row) return null;
    const number = value => Number(value || 0);
    const inputSamples = number(row.input_sample_count);
    const outputSamples = number(row.output_sample_count);
    const estimatedInput = number(row.estimated_input_tokens);
    const actualInput = number(row.actual_input_tokens);
    const estimatedOutput = number(row.estimated_output_tokens);
    const actualOutput = number(row.actual_output_tokens);
    return {
        ...row,
        model_id: number(row.model_id),
        sample_count: number(row.sample_count),
        input_sample_count: inputSamples,
        output_sample_count: outputSamples,
        input_bias_ratio: estimatedInput > 0 ? actualInput / estimatedInput : null,
        output_bias_ratio: estimatedOutput > 0 ? actualOutput / estimatedOutput : null,
        input_mean_absolute_error: inputSamples > 0 ? number(row.input_abs_error_tokens) / inputSamples : null,
        output_mean_absolute_error: outputSamples > 0 ? number(row.output_abs_error_tokens) / outputSamples : null,
        input_mean_signed_error: inputSamples > 0 ? number(row.input_signed_error_tokens) / inputSamples : null,
        output_mean_signed_error: outputSamples > 0 ? number(row.output_signed_error_tokens) / outputSamples : null,
        input_relative_absolute_error: actualInput > 0 ? number(row.input_abs_error_tokens) / actualInput : null,
        output_relative_absolute_error: actualOutput > 0 ? number(row.output_abs_error_tokens) / actualOutput : null
    };
}

async function getProviderUsageCalibration({ modelId, protocol = '' } = {}) {
    const normalizedModelId = Number(modelId);
    if (!Number.isSafeInteger(normalizedModelId) || normalizedModelId <= 0) return null;
    const clauses = ['model_id = ?'];
    const params = [normalizedModelId];
    if (protocol) {
        clauses.push('protocol = ?');
        params.push(String(protocol).trim().toLowerCase().slice(0, 32));
    }
    const row = await queryOne(`
        SELECT * FROM model_usage_calibrations
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT 1
    `, params);
    return normalizeCalibrationRow(row);
}

module.exports = {
    calculateUsageCalibrationSample,
    estimateProviderUsage,
    getProviderUsageCalibration,
    normalizeCalibrationRow,
    normalizeProviderUsage,
    protocolFromUsage,
    recordProviderUsageCalibration
};
