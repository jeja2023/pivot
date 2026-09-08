const test = require('node:test');
const assert = require('node:assert/strict');
const {
    RUNTIME_SETTING_KEYS,
    normalizeRuntimeSettingValue
} = require('../server/services/runtime-settings-defs');

test('runtime setting bootstrap normalization clamps invalid environment values through the same contract', () => {
    const key = RUNTIME_SETTING_KEYS.maxConcurrentAiRequests;
    assert.equal(normalizeRuntimeSettingValue(key, 0).error !== undefined, true);
    assert.equal(normalizeRuntimeSettingValue(key, 99999).error !== undefined, true);
    assert.equal(normalizeRuntimeSettingValue(key, 8).value, 8);
});
