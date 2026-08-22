const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    calculateUsageCalibrationSample,
    estimateProviderUsage,
    getProviderUsageCalibration,
    normalizeProviderUsage,
    recordProviderUsageCalibration
} = require('../server/services/provider-usage-calibration');

test('Provider usage calibration normalizes protocols and reports signed/absolute error', () => {
    assert.deepEqual(normalizeProviderUsage({ prompt_tokens: 20, completion_tokens: 7 }), {
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 27,
        inputAvailable: true,
        outputAvailable: true,
        totalAvailable: true,
        raw: { prompt_tokens: 20, completion_tokens: 7 }
    });
    assert.deepEqual(calculateUsageCalibrationSample({
        estimatedInputTokens: 24,
        estimatedOutputTokens: 5,
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 }
    }), {
        inputAvailable: true,
        outputAvailable: true,
        estimatedInputTokens: 24,
        estimatedOutputTokens: 5,
        actualInputTokens: 20,
        actualOutputTokens: 7,
        inputSignedError: -4,
        outputSignedError: 2,
        inputAbsError: 4,
        outputAbsError: 2,
        actualTotalTokens: 27
    });
    assert.equal(calculateUsageCalibrationSample({ estimatedInputTokens: 10, estimatedOutputTokens: 3, usage: {} }), null);
});

test('Provider usage calibration persists model/protocol aggregate metrics', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id, 'test schema must contain a user');
    const model = await queryOne(`
        INSERT INTO models (user_id, name, url, api_key, model_name, status, created_at)
        VALUES (?, ?, ?, '', ?, 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [user.id, `calibration-${process.pid}`, 'http://calibration.invalid', `calibration-${process.pid}`]);
    const protocol = `calibration_test_${process.pid}`.slice(0, 32);
    try {
        const messages = [{ role: 'user', content: '校准样本' }];
        const estimated = estimateProviderUsage(messages, '输出内容');
        const sample = await recordProviderUsageCalibration({
            modelId: model.id,
            protocol,
            source: 'test_calibration',
            messages,
            output: '输出内容',
            estimated,
            usage: { protocol, input_tokens: estimated.inputTokens + 3, output_tokens: estimated.outputTokens - 1, total_tokens: estimated.inputTokens + estimated.outputTokens + 2 }
        });
        assert.equal(sample.inputSignedError, 3);
        const row = await getProviderUsageCalibration({ modelId: model.id, protocol });
        assert.equal(row.sample_count, 1);
        assert.equal(row.input_sample_count, 1);
        assert.equal(row.output_sample_count, 1);
        assert.equal(row.input_mean_absolute_error, 3);
        assert.equal(row.output_mean_absolute_error, 1);
        assert.equal(row.last_source, 'test_calibration');
    } finally {
        await execute('DELETE FROM model_usage_calibrations WHERE model_id = ? AND protocol = ?', [model.id, protocol]);
        await execute('DELETE FROM models WHERE id = ?', [model.id]);
    }
});
