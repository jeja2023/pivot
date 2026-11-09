'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { verificationObservations } = require('../server/services/agent-verification-context');

test('核验按工具原始参数区分历史字符串写入与修正数值，输入本身不能成为执行证据', () => {
    const observations = [
        { tool: 'tools.execute', input: { toolRef: { toolName: 'write' }, input: { path: 'result.json', content: '{"total":"280.00"}', expected_version: 0 } }, output: { saved: true, version: 1 } },
        { tool: 'tools.execute', input: { toolRef: { toolName: 'validate' }, input: { path: 'result.json' } }, output: { valid: false, errors: ['total数值不符合任务资料'] } },
        { tool: 'tools.execute', input: { toolRef: { toolName: 'write' }, input: { path: 'result.json', content: '{"total":280.00}', expected_version: 1 } }, output: { saved: true, version: 2 } },
        { tool: 'tools.execute', input: { toolRef: { toolName: 'validate' }, input: { path: 'result.json' } }, output: { valid: true, version: 2 } }
    ];
    const result = verificationObservations(observations);
    assert.equal(result[0].inputPreview.input.content, '{"total":"280.00"}');
    assert.equal(result[2].inputPreview.input.content, '{"total":280.00}');
    assert.equal(result[1].output.valid, false); assert.equal(result[3].output.valid, true);
    const unexecuted = verificationObservations([{ tool: 'tools.execute', input: { toolRef: { toolName: 'send' }, input: { text: '已完成' } }, output: { executed: false } }]);
    assert.equal(unexecuted[0].output.executed, false);
});

test('核验参数预览复用现有脱敏与大小限制，不把密钥或超大输入再次送入核验模型', () => {
    const result = verificationObservations([{ tool: 'tools.execute', input: { toolRef: { toolName: 'send' },
        input: { password: 'private-password', authorization: 'Bearer hidden', content: '业务正文'.repeat(1000) } }, output: { executed: false } }]);
    assert.equal(result[0].inputPreview.input.password, '[已脱敏]');
    assert.equal(result[0].inputPreview.input.authorization, '[已脱敏]');
    assert(result[0].inputPreview.input.content.length < 600);
    const large = verificationObservations([{ tool: 'send', input: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`field${index}`, '大文本'.repeat(300)])), output: { executed: false } }]);
    assert.equal(large[0].inputPreview.omitted, true);
});

test('核验上下文保留整批字段、错误和提交证据，工具契约不能伪装成交付', () => {
    const result = verificationObservations([
        { tool: 'tools.describe', output: { type: 'tools_descriptions', descriptions: [{ name: 'commit', description: '声称已完成' }] } },
        { tool: 'tools.batch_read', output: { type: 'tools_batch_read', results: Array.from({ length: 8 }, (_, index) => ({ toolName: 'read', output: {
            content: [{ type: 'text', text: JSON.stringify({ content: JSON.stringify({ value: index, next: `part-${index + 1}`, background: '背景'.repeat(5000) }) }) }]
        } })) } },
        { tool: 'tools.execute', error: 'OUTCOME_UNKNOWN', output: { isError: true, error: '结果不明' } },
        { tool: 'tools.execute', output: { content: [{ type: 'text', text: '{"committed":true,"version":2}' }] } }
    ]);
    assert.equal(result[0].output.executed, false);
    assert.equal(result[1].output.results.length, 8);
    assert.equal(result[1].output.results[7].output.structuredContent.content.value, 7);
    assert.equal(result[2].error, 'OUTCOME_UNKNOWN'); assert.equal(result[2].output.isError, true);
    assert.equal(result[3].output.structuredContent.committed, true);
    assert(JSON.stringify(result).length < 8000);
});

test('核验保留子任务完成回执与先后顺序，不重复传入子任务内部元数据和工具契约', () => {
    const observations = [
        { tool: 'agent.wait', output: { type: 'agent_wait', complete: false, children: [{ id: 'child', status: 'running', metadata: { workingState: '历史'.repeat(10000) } }] } },
        { type: 'agent_control', messageId: 'receipt', payload: { kind: 'delegation_completion', childRunId: 'child', status: 'completed', summary: '{"sum":31}' } },
        { tool: 'tools.execute', output: { type: 'tool_contract_required', executed: false, contract: { description: '契约'.repeat(10000) } } },
        { tool: 'commit', output: { committed: true } }
    ];
    const result = verificationObservations(observations);
    assert.equal(result[0].output.children[0].status, 'running');
    assert.equal(result[0].output.children[0].metadata, undefined);
    assert.equal(result[1].output.payload.status, 'completed');
    assert.equal(result[2].output.executed, false); assert.equal(result[2].output.contract, undefined);
    assert.equal(result[3].output.committed, true); assert(JSON.stringify(result).length < 1200);
});
