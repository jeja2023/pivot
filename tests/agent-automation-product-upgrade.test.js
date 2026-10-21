const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseError } = require('../server/services/agent-diagnosis');
const { createApprovalHelpers } = require('../server/services/agent-runtime/approvals');
const { normalizeMissedRunPolicy } = require('../server/services/agent-schedules');

test('智能体自动化与工作流产品级升级契约测试', async (t) => {
    await t.test('Pillar 4: 调度错过补偿策略 (missedRunPolicy) 正规化与默认行为', () => {
        assert.equal(normalizeMissedRunPolicy('skip_missed'), 'skip_missed');
        assert.equal(normalizeMissedRunPolicy('skip'), 'skip_missed');
        assert.equal(normalizeMissedRunPolicy('fire_once'), 'fire_once');
        assert.equal(normalizeMissedRunPolicy('catch_up'), 'fire_once');
        assert.equal(normalizeMissedRunPolicy('invalid_policy'), 'fire_once');
        assert.equal(normalizeMissedRunPolicy(null), 'fire_once');
    });

    await t.test('Pillar 3: 审批授权 rememberForRun 支持本轮免重复打扰', () => {
        const helpers = createApprovalHelpers({
            getRunMetadata: (run) => (typeof run?.metadata === 'string' ? JSON.parse(run.metadata) : run?.metadata || {}),
            normalizeApprovalPolicy: (p) => p || 'standard',
            getTimestamp: () => new Date().toISOString()
        });

        const runId = 'test-run-123';
        const toolName = 'mcp.database.write';

        const runRecord = {
            id: runId,
            metadata: JSON.stringify({
                approvalGrants: [
                    {
                        tool: toolName,
                        rememberForRun: true
                    }
                ]
            })
        };

        const granted = helpers.isApprovalGranted(runRecord, toolName);
        assert.equal(granted, true, 'rememberForRun 为 true 时同一 Run 下相同工具直接授权');

        const differentToolGranted = helpers.isApprovalGranted(runRecord, 'mcp.terminal.exec');
        assert.equal(differentToolGranted, false, '不同工具不受影响仍需授权');

        const noRememberRecord = {
            id: runId,
            metadata: JSON.stringify({
                approvalGrants: [
                    {
                        tool: toolName,
                        key: 'key-1',
                        inputHash: 'hash-abc',
                        rememberForRun: false
                    }
                ]
            })
        };
        assert.equal(helpers.isApprovalGranted(noRememberRecord, toolName, 'key-2', {}), false, '未勾选 rememberForRun 时参数或key不同不自动放行');
    });

    await t.test('Pillar 3: 运行诊断规则引擎扩展与可操作解决步骤 (actionableSteps)', () => {
        // 限流
        const rateLimitDiag = diagnoseError({ message: '429 Too Many Requests: Rate limit exceeded' });
        assert.equal(rateLimitDiag.category, 'rate_limit');
        assert.ok(Array.isArray(rateLimitDiag.actionableSteps));
        assert.ok(rateLimitDiag.actionableSteps.length >= 2);
        assert.ok(rateLimitDiag.retryable);

        // 浏览器崩溃/连接超时
        const browserDiag = diagnoseError({ message: 'Target closed before CDP response received' });
        assert.equal(browserDiag.category, 'browser');
        assert.ok(browserDiag.actionableSteps.length >= 2);
        assert.ok(browserDiag.retryable);

        // 数据契约校验失败
        const schemaDiag = diagnoseError({ message: 'column user_id not found in table users schema' });
        assert.equal(schemaDiag.category, 'schema');
        assert.ok(schemaDiag.retryable);

        // 语法解析异常
        const syntaxDiag = diagnoseError({ message: 'SyntaxError: Unexpected token < in JSON at position 0' });
        assert.equal(syntaxDiag.category, 'syntax');
        assert.equal(syntaxDiag.retryable, false);
    });
});
