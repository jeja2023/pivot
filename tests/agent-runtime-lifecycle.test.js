const assert = require('node:assert/strict');
const test = require('node:test');
const Sqlite = require('better-sqlite3');

const { db } = require('../server/db');
const { createAgentQueue } = require('../server/services/agent-queue');
const { recoverAgentRuns } = require('../server/services/agent-runtime');
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

test('runtime recovery leaves stale awaiting approval runs suspended', () => {
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
        recoverAgentRuns();

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

test('an awaiting approval run releases its queue slot to the next run', async () => {
    const queueDb = new Sqlite(':memory:');
    queueDb.exec([
        'CREATE TABLE agent_runs (',
        '    id TEXT PRIMARY KEY,',
        '    user_id INTEGER NOT NULL,',
        '    status TEXT NOT NULL,',
        '    priority INTEGER DEFAULT 0,',
        '    created_at TEXT NOT NULL,',
        '    updated_at TEXT,',
        '    started_at TEXT,',
        '    last_heartbeat_at TEXT,',
        '    locked_by TEXT,',
        '    lock_expires_at TEXT,',
        '    deleted_at TEXT',
        ')'
    ].join('\n'));
    const insertQueued = queueDb.prepare([
        'INSERT INTO agent_runs (id, user_id, status, priority, created_at)',
        "VALUES (?, ?, 'queued', ?, ?)"
    ].join('\n'));
    insertQueued.run('approval-run', 1, 10, '2026-08-06 10:00:00');
    insertQueued.run('next-run', 2, 0, '2026-08-06 10:00:01');

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
        db: queueDb,
        logger: { info() {}, warn() {}, error() {} },
        instanceId: 'queue-slot-test',
        maxConcurrent: 1,
        maxConcurrentPerUser: 1,
        getRunUser: runId => ({ id: runId === 'approval-run' ? 1 : 2, username: runId }),
        runAgent: async runId => {
            started.push(runId);
            if (runId === 'approval-run') {
                queueDb.prepare([
                    "UPDATE agent_runs SET status = 'awaiting_approval',",
                    'locked_by = NULL, lock_expires_at = NULL WHERE id = ?'
                ].join('\n')).run(runId);
                return;
            }

            notifyNextStarted();
            await holdNextRun;
            queueDb.prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(runId);
        },
        markRunError: runId => {
            queueDb.prepare("UPDATE agent_runs SET status = 'error' WHERE id = ?").run(runId);
        },
        getTimestamp: () => '2026-08-06 10:00:02'
    });

    try {
        queue.processQueue();
        await waitFor(nextStarted, 'next queued run did not acquire the released slot');

        assert.deepEqual(started, ['approval-run', 'next-run']);
        assert.equal(queueDb.prepare('SELECT status FROM agent_runs WHERE id = ?').get('approval-run').status, 'awaiting_approval');
        assert.equal(queueDb.prepare('SELECT status FROM agent_runs WHERE id = ?').get('next-run').status, 'running');
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
        queueDb.close();
    }
});
