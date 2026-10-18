'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    executionInputDigest,
    issueExecutionGrant,
    issueToolExecutionGrant,
    verifyExecutionGrant
} = require('../server/services/agent-execution-grant');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const { assertTerminalExecutionGrant } = require('../server/services/agent-terminal-runtime');
const { createExecutionGrantLedger } = require('../server/services/agent-execution-grant-ledger');

const SECRET = 'execution-grant-test-secret-must-be-at-least-32-bytes';
const NOW = Date.UTC(2026, 9, 20, 0, 0, 0);

test('预览运行在工具入口拒绝副作用且不会进入检查点或执行', async () => {
    const events = [];
    let checkpointCalls = 0;
    let executed = false;
    const orchestrator = createToolOrchestrator({
        recordAgentEvent: async event => events.push(event),
        beginAgentToolCheckpoint: async () => { checkpointCalls += 1; return { replay: false }; }
    });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'preview-denied', user_id: 7, metadata: { workflowRunSource: 'preview' } }, user: { id: 7 },
        tool: { name: 'workflow.notify', side_effect: true }, input: {},
        execute: async () => { executed = true; }
    }), error => error.code === 'AGENT_PREVIEW_SIDE_EFFECT_BLOCKED');
    assert.equal(checkpointCalls, 0);
    assert.equal(executed, false);
    assert.ok(events.some(item => item.type === 'tool.denied' && item.payload.errorCode === 'AGENT_PREVIEW_SIDE_EFFECT_BLOCKED'));
});

test('预览运行仍可执行已声明的只读工具', async () => {
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => {}, recordAgentEvent: async () => {},
        issueToolExecutionGrant: () => null, stageDeferredToolEffect: async () => null
    });
    const result = await orchestrator.execute({
        run: { id: 'preview-read', user_id: 7, metadata: { workflowRunSource: 'preview' } }, user: { id: 7 },
        tool: { name: 'example.read', side_effect: false, approval_required: false }, input: {},
        execute: async () => ({ value: '只读结果' })
    });
    assert.deepEqual(result, { value: '只读结果' });
});

test('执行授权签发失败会结束检查点并调用失败回调', async () => {
    const failures = [];
    const events = [];
    const grantError = Object.assign(new Error('测试授权失败'), { code: 'AGENT_EXECUTION_GRANT_INVALID' });
    let executed = false;
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        failAgentToolCheckpoint: async (key, error) => { failures.push([key, error.code]); return true; },
        recordAgentEvent: async event => events.push(event), issueToolExecutionGrant: () => { throw grantError; }
    });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'grant-failed', user_id: 7 }, user: { id: 7 }, tool: { name: 'sample.write', idempotent: false },
        input: {}, context: { operationKey: 'grant-failed:write' },
        onFailure: async ({ error }) => { failures.push(['callback', error.code]); },
        execute: async () => { executed = true; }
    }), error => error === grantError);
    assert.deepEqual(failures, [['grant-failed:write', grantError.code], ['callback', grantError.code]]);
    assert.equal(executed, false);
    assert.ok(events.some(item => item.type === 'sandbox.denied' && item.payload.errorCode === grantError.code));
});

test('执行前失败无法落盘时记录检查点告警并保留原始错误', async () => {
    const events = [];
    const grantError = Object.assign(new Error('测试授权失败'), { code: 'AGENT_EXECUTION_GRANT_INVALID' });
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        failAgentToolCheckpoint: async () => { throw new Error('数据库不可用'); },
        recordAgentEvent: async event => events.push(event), issueToolExecutionGrant: () => { throw grantError; }
    });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'checkpoint-unavailable', user_id: 7 }, user: { id: 7 }, tool: { name: 'sample.write' }, input: {},
        context: { operationKey: 'checkpoint-unavailable:write' }, execute: async () => null
    }), error => error === grantError);
    assert.ok(events.some(item => item.type === 'checkpoint.failure_record_failed'));
});

test('工具执行后检查点写入失败时也记录告警并保留原始错误', async () => {
    const events = [];
    const executionError = Object.assign(new Error('请求结果未知'), { code: 'CONNECTION_LOST' });
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        failAgentToolCheckpoint: async (_key, _error, options) => {
            assert.equal(options.executionMayHaveOccurred, true);
            throw new Error('检查点数据库不可用');
        },
        recordAgentEvent: async event => events.push(event), issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => null
    });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'checkpoint-write-failed', user_id: 7 }, user: { id: 7 }, tool: { name: 'sample.write', idempotent: false }, input: {},
        context: { operationKey: 'checkpoint-write-failed:write' }, execute: async () => { throw executionError; }
    }), error => error === executionError);
    assert.ok(events.some(item => item.type === 'checkpoint.failure_record_failed'));
    assert.ok(events.some(item => item.type === 'tool.failed' && item.payload.outcomeMayBeUncertain === true));
});

function claims(overrides = {}) {
    return {
        runId: 'run-grant-test',
        userId: 7,
        tenantId: 3,
        tool: 'terminal.runtime',
        capability: 'code.execute',
        input: { action: 'exec', command: 'node', args: ['-v'] },
        policy: { decision: 'allow', approvalGranted: true },
        workspace: { scopeId: 'run:run-grant-test', mode: 'rw', target: '/workspace' },
        network: { mode: 'deny' },
        resources: { timeoutMs: 30000, memoryBytes: 128 * 1024 * 1024, pids: 32 },
        ...overrides
    };
}

function memoryLedger(nowRef) {
    const rows = new Map();
    const transaction = async callback => await callback({
        queryOne: async (sql, params) => {
            if (sql.includes('SELECT grant_id, token_digest')) {
                const row = rows.get(params[0]);
                return row ? { grant_id: row.grantId, token_digest: row.tokenDigest } : null;
            }
            if (sql.includes('UPDATE agent_execution_grants')) {
                const row = rows.get(params[3]);
                if (!row || row.tokenDigest !== params[4] || row.runId !== params[5] || row.userId !== params[6]
                    || row.tool !== params[7] || row.capability !== params[8] || row.inputDigest !== params[9]
                    || row.policySnapshot !== params[10] || row.workspaceScope !== params[11] || row.status !== 'issued'
                    || new Date(row.expiresAt).getTime() <= new Date(params[12]).getTime()) return null;
                row.status = 'consumed'; row.consumedAt = params[0]; row.consumer = params[1];
                return { grant_id: row.grantId, run_id: row.runId, user_id: row.userId, tool_name: row.tool, capability: row.capability, consumed_at: row.consumedAt, expires_at: row.expiresAt };
            }
            if (sql.includes('SELECT status, expires_at')) {
                const row = rows.get(params[0]);
                return row && row.tokenDigest === params[1] ? { status: row.status, expires_at: row.expiresAt } : null;
            }
            throw new Error(`未预期的查询：${sql}`);
        },
        execute: async (sql, params) => {
            if (sql.includes('INSERT INTO agent_execution_grants')) {
                rows.set(params[0], {
                    grantId: params[0], runId: params[1], userId: params[2], tool: params[4], capability: params[5],
                    inputDigest: params[6], policySnapshot: params[7], workspaceScope: params[8], tokenDigest: params[10],
                    status: 'issued', expiresAt: params[13]
                });
                return 1;
            }
            if (sql.includes("SET status = 'expired'")) {
                const row = rows.get(params[1]); if (row?.status === 'issued') { row.status = 'expired'; return 1; } return 0;
            }
            return 0;
        }
    });
    return { ledger: createExecutionGrantLedger({ transaction, now: () => nowRef.value }), rows };
}

test('execution grant is short-lived and bound to run, user, tool, input, and workspace', () => {
    const issued = issueExecutionGrant(claims(), { secret: SECRET, nowMs: NOW });
    assert.match(issued.token, /^peg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const verified = verifyExecutionGrant(issued.token, {
        runId: 'run-grant-test', userId: 7, tool: 'terminal.runtime', capability: 'code.execute',
        input: { args: ['-v'], command: 'node', action: 'exec' }, workspaceScopeId: 'run:run-grant-test'
    }, { secret: SECRET, nowMs: NOW + 1000 });
    assert.equal(verified.payload.tenantId, 3);
    assert.equal(verified.payload.network.mode, 'deny');
    assert.equal(verified.summary.workspace.scopeId, 'run:run-grant-test');
    assert.equal(verified.summary.inputDigest, executionInputDigest({ action: 'exec', command: 'node', args: ['-v'] }));
});

test('execution grant rejects tampering, expiry, and any binding expansion', async () => {
    const issued = issueExecutionGrant(claims({ ttlMs: 10_000 }), { secret: SECRET, nowMs: NOW });
    await assert.rejects(
        async () => verifyExecutionGrant(`${issued.token}x`, {}, { secret: SECRET, nowMs: NOW + 1000 }),
        error => error.code === 'AGENT_EXECUTION_GRANT_SIGNATURE_INVALID'
    );
    await assert.rejects(
        async () => verifyExecutionGrant(issued.token, { input: { action: 'exec', command: 'node', args: ['--inspect'] } }, { secret: SECRET, nowMs: NOW + 1000 }),
        error => error.code === 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH'
    );
    await assert.rejects(
        async () => verifyExecutionGrant(issued.token, { workspaceScopeId: 'run:other' }, { secret: SECRET, nowMs: NOW + 1000 }),
        error => error.code === 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH'
    );
    await assert.rejects(
        async () => verifyExecutionGrant(issued.token, {}, { secret: SECRET, nowMs: NOW + 10_001 }),
        error => error.code === 'AGENT_EXECUTION_GRANT_EXPIRED'
    );
});

test('execution grant refuses missing, short, or reused application secrets', () => {
    assert.throws(
        () => issueExecutionGrant(claims(), { secret: 'short', nowMs: NOW }),
        error => error.code === 'AGENT_EXECUTION_GRANT_SECRET_MISSING'
    );
    assert.throws(
        () => issueExecutionGrant(claims(), { env: { PIVOT_AGENT_EXECUTION_GRANT_SECRET: SECRET, JWT_SECRET: SECRET }, nowMs: NOW }),
        error => error.code === 'AGENT_EXECUTION_GRANT_SECRET_REUSED'
    );
});

test('tool grant only exists for a sandbox-required plan and freezes policy/input bindings', () => {
    const noGrant = issueToolExecutionGrant({
        run: { id: 'run-1', user_id: 7 }, user: { id: 7 }, tool: { name: 'rag.search' }, input: { query: 'x' }, executionPlan: { sandbox: { required: false } }
    }, { secret: SECRET, nowMs: NOW });
    assert.equal(noGrant, null);
    const issued = issueToolExecutionGrant({
        run: { id: 'run-1', user_id: 7, tenant_id: 3 }, user: { id: 7 },
        tool: { name: 'terminal.runtime', capabilities: ['code.execute'] },
        input: { action: 'list', path: '.' },
        executionPlan: { sandbox: { required: true }, policy: { decision: 'require_approval', reasonCodes: ['side_effect'] }, approval: { required: true } },
        context: { approvalGranted: true, approvalKey: 'approval-1' }
    }, { secret: SECRET, nowMs: NOW });
    const verified = verifyExecutionGrant(issued.token, { runId: 'run-1', userId: 7, tool: 'terminal.runtime', input: { action: 'list', path: '.' } }, { secret: SECRET, nowMs: NOW + 1000 });
    assert.equal(verified.payload.approvalKey, 'approval-1');
});

test('orchestrator injects only a signed execution grant into the high-risk tool context', async () => {
    const events = [];
    const issued = { token: 'grant-token-not-a-user-token', summary: { grantId: 'grant-1', tool: 'terminal.runtime' } };
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: value => ({ decision: 'allow', input: value.input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => true,
        failAgentToolCheckpoint: async () => true,
        recordAgentEvent: async event => events.push(event),
        registerExecutionGrant: async grant => {
            assert.equal(grant, issued);
            return { registered: true, grantId: 'grant-1' };
        },
        issueToolExecutionGrant: value => {
            assert.equal(value.run.id, 'run-orchestrator');
            assert.equal(value.tool.name, 'terminal.runtime');
            assert.deepEqual(value.input, { action: 'list', path: '.' });
            return issued;
        }
    });
    let received = null;
    await orchestrator.execute({
        run: { id: 'run-orchestrator', user_id: 7 },
        user: { id: 7 },
        tool: { name: 'terminal.runtime', idempotent: false, risk_level: 3 },
        input: { action: 'list', path: '.' },
        context: { runId: 'run-orchestrator', approvalGranted: true },
        executionPlan: { sandbox: { required: true }, policy: { decision: 'allow' }, approval: { required: true } },
        execute: async request => {
            received = request;
            return { ok: true };
        }
    });
    assert.equal(received.executionGrant.token, issued.token);
    assert.equal(received.context.executionGrant, issued.token);
    assert.deepEqual(received.context.executionGrantSummary, issued.summary);
    assert.ok(events.some(event => event.type === 'sandbox.granted' && event.payload.executionGrant.grantId === 'grant-1'));
    assert.equal(JSON.stringify(events).includes(issued.token), false, '审计事件不得持久化授权令牌');
});

test('orchestrator returns a staged effect instead of invoking a deferred external tool before verification', async () => {
    let invoked = false;
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: value => ({ decision: 'allow', input: value.input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => true,
        failAgentToolCheckpoint: async () => true,
        recordAgentEvent: async () => {},
        registerExecutionGrant: async () => ({ registered: true }),
        issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async request => {
            assert.equal(request.transactionId, 'tx-1');
            assert.equal(request.tool.name, 'workflow.notify');
            return { effect: { id: 'effect-1', effectType: 'workflow.notify', status: 'staged' } };
        }
    });
    const output = await orchestrator.execute({
        run: { id: 'run-deferred', user_id: 7 }, user: { id: 7 },
        tool: { name: 'workflow.notify', idempotent: false, side_effect: true },
        input: { bindingId: 'binding-1', body: 'later' },
        context: { taskTransactionId: 'tx-1' },
        executionPlan: { sandbox: { required: false }, policy: { decision: 'allow' } },
        execute: async () => { invoked = true; return { queued: true }; }
    });
    assert.equal(invoked, false);
    assert.equal(output.staged, true);
    assert.equal(output.effectId, 'effect-1');
});

test('orchestrator executes preview effects in a shadow workspace and records their staged evidence', async () => {
    const previewRecords = [];
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: value => ({ decision: 'allow', input: value.input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => true,
        failAgentToolCheckpoint: async () => true,
        recordAgentEvent: async () => {},
        registerExecutionGrant: async () => ({ registered: true }),
        issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => ({
            effect: { id: 'effect-preview', effectType: 'mcp.workspace.patch', status: 'staged' },
            plan: { commitMode: 'preview' }
        }),
        beginPreviewTaskEffect: async () => ({ status: 'executing' }),
        recordPreviewTaskEffect: async (...args) => { previewRecords.push(args); return { status: 'staged' }; }
    });
    let invoked = false;
    const output = await orchestrator.execute({
        run: { id: 'run-preview', user_id: 7 }, user: { id: 7 },
        tool: { name: 'mcp.0.workspace.patch', idempotent: false, side_effect: true },
        input: { worktreeName: 'shadow', changes: [{ path: 'src/a.js', content: 'x' }] },
        context: { taskTransactionId: 'tx-preview' },
        executionPlan: { sandbox: { required: false }, policy: { decision: 'allow' } },
        execute: async () => { invoked = true; return { changed: [{ path: 'src/a.js' }] }; }
    });
    assert.equal(invoked, true);
    assert.deepEqual(output, { changed: [{ path: 'src/a.js' }] });
    assert.deepEqual(previewRecords, [['effect-preview', { id: 7 }, { changed: [{ path: 'src/a.js' }] }]]);
});

test('enabled lifecycle preflight hook can deny a tool without expanding its input or permissions', async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: value => ({ decision: 'allow', input: value.input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => true,
        failAgentToolCheckpoint: async () => true,
        recordAgentEvent: async event => events.push(event),
        issueToolExecutionGrant: () => null,
        registerExecutionGrant: async () => ({ registered: true }),
        stageDeferredToolEffect: async () => null,
        invokeAgentLifecycleHooks: async request => {
            assert.equal(request.eventType, 'tool.preflight');
            assert.deepEqual(request.payload.authorization.scopes, ['agent.tools.execute']);
            return { decisions: [{ hookId: 'hook-1', hookName: 'org-block', decision: 'deny', reason: 'tool_blocked' }], additionalContext: [] };
        }
    });
    let invoked = false;
    await assert.rejects(
        () => orchestrator.execute({
            run: { id: 'run-hook', user_id: 7 }, user: { id: 7 }, tool: { name: 'agent.http', risk_level: 4 }, input: { url: 'https://example.invalid', method: 'GET' },
            context: { lifecycleHooksEnabled: true, authorizedScopes: ['agent.tools.execute'] }, executionPlan: { sandbox: { required: false }, policy: { decision: 'allow' } },
            execute: async () => { invoked = true; return { ok: true }; }
        }),
        error => error.code === 'AGENT_HOOK_DENIED'
    );
    assert.equal(invoked, false);
    assert.ok(events.some(event => event.type === 'hook.preflight'));
});

test('enabled lifecycle hooks receive audited post events for success and failure without changing tool outcome', async () => {
    const hookCalls = [];
    const events = [];
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: value => ({ decision: 'allow', input: value.input }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => true,
        failAgentToolCheckpoint: async () => true,
        recordAgentEvent: async event => events.push(event),
        issueToolExecutionGrant: () => null,
        registerExecutionGrant: async () => ({ registered: true }),
        stageDeferredToolEffect: async () => null,
        invokeAgentLifecycleHooks: async request => {
            hookCalls.push(request);
            return { decisions: [{ hookId: 'hook-observe', decision: 'observe' }], additionalContext: [] };
        }
    });
    const request = {
        run: { id: 'run-hook-post', user_id: 7 }, user: { id: 7 }, tool: { name: 'rag.search', risk_level: 1 }, input: { query: 'status' },
        context: { lifecycleHooksEnabled: true, authorizedScopes: ['agent.tools.execute'] }, executionPlan: { sandbox: { required: false }, policy: { decision: 'allow' } }
    };
    const output = await orchestrator.execute({ ...request, context: { ...request.context, stepId: 'success' }, execute: async () => ({ ok: true }) });
    assert.deepEqual(output, { ok: true });
    assert.deepEqual(hookCalls.map(call => `${call.eventType}:${call.phase}`), ['tool.preflight:pre', 'tool.succeeded:post']);
    assert.deepEqual(hookCalls.map(call => call.payload.authorization.scopes), [['agent.tools.execute'], ['agent.tools.execute']]);
    assert.ok(events.some(event => event.type === 'hook.post' && event.payload.hookEventType === 'tool.succeeded'));

    hookCalls.length = 0;
    await assert.rejects(
        () => orchestrator.execute({ ...request, context: { ...request.context, stepId: 'failure' }, execute: async () => { const error = new Error('预期失败'); error.code = 'TEST_FAILURE'; throw error; } }),
        error => error.code === 'TEST_FAILURE'
    );
    assert.deepEqual(hookCalls.map(call => `${call.eventType}:${call.phase}`), ['tool.preflight:pre', 'tool.failed:post']);
    assert.ok(events.some(event => event.type === 'hook.post' && event.payload.hookEventType === 'tool.failed'));
});

test('terminal runtime rejects a grant if the run, input, or workspace binding changes', () => {
    const input = { action: 'exec', command: 'node', script: 'process.stdout.write("ok")' };
    const issued = issueExecutionGrant(claims({ runId: 'run-terminal', tool: 'terminal.runtime', input, workspace: { scopeId: 'run:run-terminal', mode: 'rw', target: '/workspace' } }), { secret: SECRET });
    const context = {
        run: { id: 'run-terminal' },
        executionGrant: issued.token,
        env: { PIVOT_AGENT_EXECUTION_GRANT_SECRET: SECRET }
    };
    const verified = assertTerminalExecutionGrant(input, { id: 7 }, context);
    assert.equal(verified.payload.runId, 'run-terminal');
    assert.throws(
        () => assertTerminalExecutionGrant({ ...input, args: ['--inspect'] }, { id: 7 }, context),
        error => error.code === 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH'
    );
    assert.throws(
        () => assertTerminalExecutionGrant(input, { id: 8 }, context),
        error => error.code === 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH'
    );
});

test('execution-grant ledger atomically consumes an issued grant and rejects replay', async () => {
    const nowRef = { value: new Date().toISOString() };
    const { ledger } = memoryLedger(nowRef);
    const issued = issueExecutionGrant(claims(), { secret: SECRET });
    const registered = await ledger.registerExecutionGrant(issued);
    assert.equal(registered.registered, true);
    const consumed = await ledger.consumeExecutionGrant({ token: issued.token, payload: issued.payload, consumer: 'test-worker' });
    assert.equal(consumed.consumed, true);
    await assert.rejects(
        () => ledger.consumeExecutionGrant({ token: issued.token, payload: issued.payload, consumer: 'test-worker' }),
        error => error.code === 'AGENT_EXECUTION_GRANT_REPLAYED'
    );
});
