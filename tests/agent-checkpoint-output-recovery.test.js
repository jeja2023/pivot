'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { execute, queryOne } = require('../server/db/client');
const {
    beginAgentToolCheckpoint,
    completeAgentToolCheckpoint
} = require('../server/services/agent-checkpoints');
const { parseCasRef } = require('../server/services/agent-artifact-cas');

test('oversized completed tool checkpoints replay the full CAS-backed output', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `checkpoint-output-${suffix}`;
    const operationKey = `checkpoint-output-operation-${suffix}`;
    const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-checkpoint-cas-'));
    const previousCasRoot = process.env.PIVOT_ARTIFACT_CAS_DIR;
    process.env.PIVOT_ARTIFACT_CAS_DIR = casRoot;
    const output = { text: 'x'.repeat(130000), count: 7 };
    try {
        await execute(`
            INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
            VALUES (?, ?, 'checkpoint output', 'checkpoint output', 'running', '{}', NOW(), NOW())
        `, [runId, user.id]);
        await beginAgentToolCheckpoint(runId, {
            operationKey,
            stepIndex: 1,
            toolName: 'sample.read',
            input: { query: 'large output' },
            inputHash: 'checkpoint-output-input',
            idempotent: true,
            user
        });
        assert.equal(await completeAgentToolCheckpoint(operationKey, output, { user }), true);

        const stored = await queryOne('SELECT state FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey]);
        const state = typeof stored.state === 'string' ? JSON.parse(stored.state) : stored.state;
        assert.match(String(state.outputRef || ''), /^artifact-cas:\/\/[0-9a-f]{64}$/);
        assert.equal(state.outputComplete, false);
        assert.equal(parseCasRef(state.outputRef)?.length, 64);

        const replay = await beginAgentToolCheckpoint(runId, {
            operationKey,
            toolName: 'sample.read',
            input: { query: 'large output' },
            inputHash: 'checkpoint-output-input',
            idempotent: true,
            user
        });
        assert.equal(replay.replay, true);
        assert.deepEqual(replay.output, output);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        if (previousCasRoot === undefined) delete process.env.PIVOT_ARTIFACT_CAS_DIR;
        else process.env.PIVOT_ARTIFACT_CAS_DIR = previousCasRoot;
        fs.rmSync(casRoot, { recursive: true, force: true });
    }
});

