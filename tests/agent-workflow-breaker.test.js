'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sweepWorkflowReleaseBreakers } = require('../server/services/agent-workflow-breaker');

test('工作流灰度异常会按冻结阈值自动暂停，且仅统计关联 release 的运行', async () => {
    const actions = [];
    const read = async sql => {
        if (sql.includes('FROM agent_workflow_releases')) return [{ id: 8, workflow_id: 3, breaker_thresholds: { minSamples: 2, toolErrorRate: 0.2 }, previous_release_id: null }];
        if (sql.includes('FROM agent_tool_calls')) return [{ samples: 2, policy_denied: 0, tool_errors: 1, timeouts: 0 }];
        if (sql.includes('FROM agent_feedback')) return [{ negative_feedback: 0 }];
        throw new Error('出现未预期的查询。');
    };
    const result = await sweepWorkflowReleaseBreakers({
        read,
        pause: async (release, reason) => { actions.push({ release, reason }); return { action: 'paused' }; },
        rollback: async () => { throw new Error('不应回滚'); }
    });
    assert.equal(result.tripped, 1);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].release.id, 8);
    assert.match(actions[0].reason, /tool_error_rate/);
});
