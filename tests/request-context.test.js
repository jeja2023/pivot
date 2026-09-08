const test = require('node:test');
const assert = require('node:assert/strict');
const { getRequestContext, runWithRequestContext } = require('../server/services/request-context');

test('request context propagates request ID across asynchronous service work', async () => {
    const result = await runWithRequestContext({ requestId: 'req-test-123', userId: 7 }, async () => {
        await new Promise(resolve => setImmediate(resolve));
        return getRequestContext();
    });
    assert.deepEqual(result, { requestId: 'req-test-123', userId: 7 });
});
