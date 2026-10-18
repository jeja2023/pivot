'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getAgentContextCompactionMetrics } = require('../server/services/agent-monitoring');

test('context compaction metrics aggregate only redacted numeric audit fields', async () => {
    let captured = null;
    const result = await getAgentContextCompactionMetrics({ id: 7, tenant_id: 3, role: 'user' }, 14, {
        queryOne: async (sql, params) => {
            captured = { sql, params };
            return {
                event_count: '5', run_count: '3', input_tokens_before: '12000',
                input_tokens_after: '4500', hard_field_losses: '0'
            };
        }
    });
    assert.deepEqual(captured.params, [7, 3]);
    assert.match(captured.sql, /jsonb_exists\(e\.payload,\s*'compaction'\)/);
    assert.match(captured.sql, /hardFieldLoss/);
    assert.equal(result.eventCount, 5);
    assert.equal(result.runCount, 3);
    assert.equal(result.savingsRate, 0.625);
    assert.equal(result.hardFieldLosses, 0);
});
