const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('../server/db');
const { createAgentQueue } = require('../server/services/agent-queue');
const { getAgentQueue, recoverAgentRuns } = require('../server/services/agent-runtime');
const {
    canTransitionAgentRunStatus,
    transitionAgentRunStatus
} = require('../server/services/agent-runtime/state-machine');

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
