'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    classifyNativeToolCallError,
    normalizeToolCallMode,
    shouldUseNativeToolCalls
} = require('../server/services/model-tool-call-capabilities');
const { isStreamingToolsEnabled } = require('../server/services/agent-streaming-runtime');

test('native tool-call capability mode is safe by default and honors explicit overrides', () => {
    assert.equal(normalizeToolCallMode('ENABLED'), 'enabled');
    assert.equal(normalizeToolCallMode('invalid'), 'auto');
    assert.equal(shouldUseNativeToolCalls({ tool_call_mode: 'auto' }, {}), true);
    assert.equal(shouldUseNativeToolCalls({ tool_call_mode: 'auto', tool_call_probe_status: 'unsupported' }, {}), false);
    assert.equal(shouldUseNativeToolCalls({ tool_call_mode: 'enabled', tool_call_probe_status: 'unsupported' }, {}), true);
    assert.equal(shouldUseNativeToolCalls({ tool_call_mode: 'disabled' }, {}), false);
    assert.equal(shouldUseNativeToolCalls({ tool_call_mode: 'enabled' }, { AGENT_NATIVE_TOOL_CALLS: 'disabled' }), false);
    assert.equal(isStreamingToolsEnabled({ tool_call_mode: 'enabled' }, { AGENT_STREAMING_TOOLS: 'off' }), false);
});

test('native tool-call errors classify endpoint incompatibility separately from transient degradation', () => {
    assert.deepEqual(
        classifyNativeToolCallError({ response: { status: 400, data: { error: { message: 'tool_calls is not supported by this endpoint' } } } }),
        { status: 'unsupported', httpStatus: 400, reason: 'tool_calls is not supported by this endpoint' }
    );
    assert.deepEqual(
        classifyNativeToolCallError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })),
        { status: 'degraded', httpStatus: null, reason: 'connection reset' }
    );
});
