const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('../server/db');
const { createAgentQueue } = require('../server/services/agent-queue');
const {
    monitoring: { getAgentQueue },
    runs: { recoverAgentRuns, revokeApprovedAgentTool }
} = require('../server/services/agent-runtime');
const {
    canTransitionAgentRunStatus,
    transitionAgentRunStatus,
    TERMINAL_STATUSES
} = require('../server/services/agent-runtime/state-machine');
const { createRunState } = require('../server/services/agent-runtime/run-state');

function waitFor(promise, message, timeoutMs = 1000) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

test('awaiting approval is a legal non-terminal run status transition', () => {
    const paused = transitionAgentRunStatus('running', 'awaiting_approval');

    assert.equal(paused.allowed, true);
    assert.equal(paused.terminal, false);
    assert.equal(canTransitionAgentRunStatus('awaiting_approval', 'queued'), true);
    assert.equal(canTransitionAgentRunStatus('awaiting_approval', 'running'), true);
});

test('a pre run.started Hook denies the queued-to-planning transition before it is persisted', async () => {
    const writes = [];
    const state = createRunState({
        crypto: require('node:crypto'),
        queryOne: async sql => sql.includes('JOIN users')
            ? { id: 17, username: 'hook-owner' }
            : { status: 'queued', run_mode: 'standard' },
        execute: async (...args) => { writes.push(args); return 1; },
        logger: { warn() {}, error() {} },
        getBeijingTimestamp: () => '2026-10-18 09:00:00',
        getAgentRunTitle: () => '', getRunMetadata: () => ({}),
        assertAgentRunStatusTransition: () => {}, canTransitionAgentRunStatus: () => true,
        TERMINAL_STATUSES: new Set(), releaseChildRunReservation: async () => {}, persistAgentRunChatResult: async () => {},
        deliverChannelGatewayRunResult: async () => {}, deliverGoalRunResult: async () => {}, recordCollaboratorCompletion: async () => {},
        recordAgentRunOutcome: async () => {}, recordFirstTaskTerminal: async () => {}, recordAgentEvent: async () => {}, publishUserEvent: async () => {},
        parseJsonObject: value => value || {}, updateAgentRunMetadataWithRetry: async () => ({}),
        dispatchPreLifecycleHook: async request => {
            assert.equal(request.eventType, 'run.started');
            assert.equal(request.payload.run.run_mode, 'standard');
            return { denied: true, blocking: { hookId: 'h-start', hookName: 'hold-start' } };
        }
    });
    await assert.rejects(
        () => state.updateRun('run-pre-denied', { status: 'planning' }),
        error => error.code === 'AGENT_HOOK_DENIED'
    );
    assert.equal(writes.length, 0, '被拒绝的启动不得先改变运行状态');
});

test('queued approval grant can be revoked before an executor claims the run', async () => {
    const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    assert.ok(user?.id);
    const runId = `approval-revoke-${process.pid}-${Date.now()}`;
    const metadata = {
        approvalGrants: [{ tool: 'mcp.write', key: 'node:write', inputHash: 'a'.repeat(64), grantedAt: '2026-10-18 10:00:00', expiresAt: '2099-01-01 00:00:00' }]
    };
    db.prepare("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'revoke', 'revoke grant', 'queued', ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))")
        .run(runId, user.id, JSON.stringify(metadata));
    try {
        const revoked = await revokeApprovedAgentTool(runId, { id: user.id }, 'node:write');
        assert.equal(revoked.status, 'needs_input');
        const stored = db.prepare('SELECT status, metadata FROM agent_runs WHERE id = ?').get(runId);
        const next = typeof stored.metadata === 'object' ? stored.metadata : JSON.parse(stored.metadata);
        assert.equal(stored.status, 'needs_input');
        assert.equal(next.approvalGrants.length, 0);
        assert.equal(next.revokedApproval.key, 'node:write');
        await assert.rejects(() => revokeApprovedAgentTool(runId, { id: user.id }, 'node:write'), error => error.code === 'AGENT_APPROVAL_REVOCATION_TOO_LATE');
    } finally { db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId); }
});

test('verification states distinguish completed, partial, and needs-input outcomes', () => {
    assert.equal(canTransitionAgentRunStatus('planning', 'verifying'), true);
    assert.equal(canTransitionAgentRunStatus('verifying', 'completed'), true);
    assert.equal(canTransitionAgentRunStatus('verifying', 'partial'), true);
    assert.equal(canTransitionAgentRunStatus('verifying', 'needs_input'), true);
    assert.equal(canTransitionAgentRunStatus('needs_input', 'queued'), true);
    assert.equal(TERMINAL_STATUSES.has('partial'), true);
    assert.equal(TERMINAL_STATUSES.has('needs_input'), false);
});

test('awaiting commit is a non-terminal state that can only finish or require user intervention', () => {
    const pending = transitionAgentRunStatus('verifying', 'awaiting_commit');
    assert.equal(pending.allowed, true);
    assert.equal(pending.terminal, false);
    assert.equal(canTransitionAgentRunStatus('awaiting_commit', 'completed'), true);
    assert.equal(canTransitionAgentRunStatus('awaiting_commit', 'needs_input'), true);
    assert.equal(canTransitionAgentRunStatus('awaiting_commit', 'executing'), false);
});

test('runtime recovery leaves stale awaiting approval runs suspended', async () => {
    const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id;
    assert.ok(userId, 'test database should contain a seeded user');

    const suffix = process.pid + '-' + Date.now();
    const staleRunningId = 'test-stale-running-' + suffix;
    const awaitingApprovalId = 'test-stale-awaiting-approval-' + suffix;
    const staleAt = '2000-01-01 00:00:00';
    const insertRun = db.prepare([
        'INSERT INTO agent_runs (',
        '    id, user_id, title, goal, status, metadata,',
        '    last_heartbeat_at, created_at, updated_at',
        ") VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)"
    ].join('\n'));

    insertRun.run(
        staleRunningId,
        userId,
        'Stale running recovery control',
        'Verify stale running recovery',
        'running',
        staleAt,
        staleAt,
        staleAt
    );
    insertRun.run(
        awaitingApprovalId,
        userId,
        'Stale awaiting approval run',
        'Verify approval suspension survives recovery',
        'awaiting_approval',
        staleAt,
        staleAt,
        staleAt
    );

    try {
        await recoverAgentRuns();

        const staleRunning = db.prepare('SELECT status, error_message FROM agent_runs WHERE id = ?').get(staleRunningId);
        const awaitingApproval = db.prepare('SELECT status, error_message FROM agent_runs WHERE id = ?').get(awaitingApprovalId);
        const awaitingRecoverySteps = db.prepare([
            'SELECT COUNT(*) AS count',
            'FROM agent_steps',
            "WHERE run_id = ? AND type = 'control'"
        ].join('\n')).get(awaitingApprovalId).count;

        assert.equal(staleRunning.status, 'error');
        assert.ok(staleRunning.error_message);
        assert.equal(awaitingApproval.status, 'awaiting_approval');
        assert.equal(awaitingApproval.error_message, null);
        assert.equal(awaitingRecoverySteps, 0);
    } finally {
        db.prepare('DELETE FROM agent_steps WHERE run_id IN (?, ?)').run(staleRunningId, awaitingApprovalId);
        db.prepare('DELETE FROM agent_runs WHERE id IN (?, ?)').run(staleRunningId, awaitingApprovalId);
    }
});

test('runtime recovery requeues stale idempotent checkpoints and suspends side effects for approval', async () => {
    const globalQueue = getAgentQueue();
    const previousMax = globalQueue.getStatus().maxConcurrent;
    globalQueue.updateMaxConcurrent(0);
    const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id;
    assert.ok(userId);
    const suffix = process.pid + '-' + Date.now();
    const safeId = `stale-idempotent-${suffix}`;
    const unsafeId = `stale-side-effect-${suffix}`;
    const staleAt = '2000-01-01 00:00:00';
    db.prepare("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,last_heartbeat_at,created_at,updated_at) VALUES (?,?,?,?, 'running','{}',?,?,?)")
        .run(safeId, userId, 'safe', 'safe', staleAt, staleAt, staleAt);
    db.prepare("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,last_heartbeat_at,created_at,updated_at) VALUES (?,?,?,?, 'running','{}',?,?,?)")
        .run(unsafeId, userId, 'unsafe', 'unsafe', staleAt, staleAt, staleAt);
    // 恢复器会异步提示全局队列。给幂等夹具设置未来 retry_after，使断言只覆盖
    // 持久化恢复语义，不与同进程队列的领取时序耦合。
    db.prepare("UPDATE agent_runs SET retry_after = '2099-01-01 00:00:00' WHERE id = ?").run(safeId);
    try {
        db.prepare("INSERT INTO agent_run_checkpoints (checkpoint_id,run_id,step_index,checkpoint_type,status,state,operation_key,tool_name,input_hash,idempotent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(`cp-safe-${suffix}`, safeId, 1, 'tool', 'pending', '{}', `op-safe-${suffix}`, 'filesystem.read', 'h', 1, staleAt);
        db.prepare("INSERT INTO agent_run_checkpoints (checkpoint_id,run_id,step_index,checkpoint_type,status,state,operation_key,tool_name,input_hash,idempotent,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(`cp-unsafe-${suffix}`, unsafeId, 1, 'tool', 'pending', '{}', `op-unsafe-${suffix}`, 'database.insert', 'h', 0, staleAt);
        await recoverAgentRuns();
        assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(safeId).status, 'queued');
        assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(unsafeId).status, 'approval_required');
    } finally {
        globalQueue.updateMaxConcurrent(previousMax);
        db.prepare('DELETE FROM agent_run_checkpoints WHERE run_id IN (?,?)').run(safeId, unsafeId);
        db.prepare('DELETE FROM agent_runs WHERE id IN (?,?)').run(safeId, unsafeId);
    }
});

test('an awaiting approval run releases its queue slot to the next run', async () => {
    const globalQueue = getAgentQueue();
    const previousMax = globalQueue.getStatus().maxConcurrent;
    globalQueue.updateMaxConcurrent(0);

    const suffix = `${process.pid}-${Date.now()}`;
    const insertUser = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `);
    const users = [
        { id: Number(insertUser.run(`queue_owner_${suffix}`, 'Queue owner').lastInsertRowid) },
        { id: Number(insertUser.run(`queue_next_${suffix}`, 'Queue next').lastInsertRowid) }
    ];
    const approvalRunId = `approval-run-${suffix}`;
    const nextRunId = `next-run-${suffix}`;
    const insertQueued = db.prepare([
        'INSERT INTO agent_runs (id, user_id, title, goal, status, priority, created_at)',
        "VALUES (?, ?, ?, ?, 'queued', ?, ?)"
    ].join('\n'));
    insertQueued.run(approvalRunId, users[0].id, 'Approval run', 'Wait for approval', 10, '2026-08-06 10:00:00');
    insertQueued.run(nextRunId, users[1].id, 'Next run', 'Acquire released slot', 0, '2026-08-06 10:00:01');

    let releaseNextRun;
    let notifyNextStarted;
    const nextStarted = new Promise(resolve => {
        notifyNextStarted = resolve;
    });
    const holdNextRun = new Promise(resolve => {
        releaseNextRun = resolve;
    });
    const started = [];
    const queue = createAgentQueue({
        logger: { info() {}, warn() {}, error() {} },
        instanceId: `queue-slot-test-${suffix}`,
        maxConcurrent: 1,
        maxConcurrentPerUser: 1,
        getRunUser: runId => ({
            id: runId === approvalRunId ? users[0].id : users[1].id,
            username: runId
        }),
        runAgent: async runId => {
            started.push(runId);
            if (runId === approvalRunId) {
                db.prepare([
                    "UPDATE agent_runs SET status = 'awaiting_approval',",
                    'locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
                ].join('\n')).run(runId);
                return;
            }

            notifyNextStarted();
            await holdNextRun;
            db.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(runId);
        },
        markRunError: runId => {
            db.prepare("UPDATE agent_runs SET status = 'error' WHERE id = ?").run(runId);
        },
        getTimestamp: () => '2026-08-06 10:00:02'
    });

    try {
        await queue.processQueue();
        await waitFor(nextStarted, 'next queued run did not acquire the released slot', 10000);

        assert.deepEqual(started, [approvalRunId, nextRunId]);
        assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(approvalRunId).status, 'awaiting_approval');
        assert.equal(db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(nextRunId).status, 'running');
        assert.equal(queue.getStatus().active, 1);
        assert.equal(queue.getStatus().queued, 0);
    } finally {
        releaseNextRun();
        const drained = new Promise(resolve => {
            const poll = () => {
                if (queue.getStatus().active === 0) resolve();
                else setImmediate(poll);
            };
            poll();
        });
        await waitFor(drained, 'agent queue did not drain after the test');
        await new Promise(resolve => setImmediate(resolve));
        globalQueue.updateMaxConcurrent(previousMax);
        db.prepare('DELETE FROM agent_runs WHERE id IN (?, ?)').run(approvalRunId, nextRunId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(users[0].id, users[1].id);
    }
});

test('任务认领后读取用户遇到瞬时数据库异常时会延迟回队而非遗留 running 孤儿', async () => {
    const warnings = [];
    const updates = [];
    const queue = createAgentQueue({
        logger: { info() {}, error() {}, warn: entry => warnings.push(entry) },
        instanceId: 'queue-user-lookup-retry',
        maxConcurrent: 1,
        getRunUser: async () => { throw new Error('读取任务用户时发生临时数据库故障'); },
        runAgent: async () => { throw new Error('不应执行'); },
        markRunError: async () => { throw new Error('不应标记为永久失败'); },
        getTimestamp: value => require('../server/time').getBeijingTimestamp(value),
        dbRunner: {
            async query(sql) {
                if (sql.includes("WHERE status = 'queued'")) return [{ id: 'retry-run', user_id: 7 }];
                return [];
            },
            async queryOne() { return null; },
            async execute(sql, params) {
                updates.push({ sql, params });
                return 1;
            }
        }
    });
    await queue.processQueue();
    const requeueUpdate = updates.find(item => item.sql.includes("SET status = 'queued'"));
    assert.ok(requeueUpdate, '用户读取失败后必须以持锁 CAS 回到 queued');
    assert.equal(requeueUpdate.params[2], 'retry-run');
    assert.ok(requeueUpdate.params[0], '回队必须设置 retry_after，避免热循环');
    assert.equal(warnings.length, 1);
});
