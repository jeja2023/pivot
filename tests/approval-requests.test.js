const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    decideWorkflowApprovalRequest,
    handleImApprovalCallback,
    runApprovalTimeouts,
    waitForWorkflowApproval
} = require('../server/services/agent-approval-requests');
const { db } = require('../server/db');
const { encryptSecret } = require('../server/security');
const { getBeijingTimestamp } = require('../server/time');

function cleanup(runId, requestId, credentialSlug = '') {
    if (requestId) db.prepare('DELETE FROM agent_approval_requests WHERE id = ?').run(requestId);
    if (runId) db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
    if (credentialSlug) db.prepare('DELETE FROM workflow_credentials WHERE slug = ?').run(credentialSlug);
}

function signCallback(secret, token, requestId, decision, nonce = '') {
    const payload = nonce
        ? `${token}.${requestId}.${decision}.${nonce}`
        : `${token}.${requestId}.${decision}`;
    return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

test('workflow approval can be decided by designated approver', async () => {
    const runId = 'test-run-approval-1';
    const requestId = 'test-request-approval-1';
    const userId = 1;
    const now = getBeijingTimestamp();

    db.prepare(`
        INSERT OR REPLACE INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'awaiting_approval', '{}', ?, ?)
    `).run(runId, userId, '审批测试', '审批测试目标', now, now);
    db.prepare(`
        INSERT OR REPLACE INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            callback_token_hash, callback_token_hint, callback_signature_required,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', 'node_1', 'node_1', '审批节点', '', '', 'pending', 1, 1,
            '[{"approverUserIds":[1],"approverUnits":[]}]', '[]', '{}', ?, 'hint', 0, 'reject', NULL, ?, ?)
    `).run(requestId, runId, userId, 'tokenhash', now, now);

    try {
        const request = await decideWorkflowApprovalRequest(requestId, { id: userId, username: 'tester', unit: 'QA' }, { approve: true });
        assert.equal(request.status, 'approved');
        const row = db.prepare('SELECT status, decided_at FROM agent_approval_requests WHERE id = ?').get(requestId);
        assert.equal(row.status, 'approved');
        assert.ok(row.decided_at);
    } finally {
        cleanup(runId, requestId);
    }
});

test('workflow approval callback validates token and approves matching request', async () => {
    const runId = 'test-run-approval-2';
    const requestId = 'test-request-approval-2';
    const userId = 1;
    const token = `apr_${'a'.repeat(48)}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = getBeijingTimestamp();

    db.prepare(`
        INSERT OR REPLACE INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'awaiting_approval', '{}', ?, ?)
    `).run(runId, userId, '回调测试', '回调测试目标', now, now);
    db.prepare(`
        INSERT OR REPLACE INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            callback_token_hash, callback_token_hint, callback_signature_required,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', 'node_2', 'node_2', '回调审批', '', '', 'pending', 1, 1,
            '[{"approverUserIds":[1],"approverUnits":[]}]', '[]', '{}', ?, 'hint', 0, 'reject', NULL, ?, ?)
    `).run(requestId, runId, userId, tokenHash, now, now);

    try {
        const rejected = await handleImApprovalCallback(`apr_${'b'.repeat(48)}`, { decision: 'approve', requestId }, {});
        assert.equal(rejected, null);

        const approved = await handleImApprovalCallback(token, { decision: 'approve', requestId }, {});
        assert.equal(approved.status, 'approved');
        const row = db.prepare('SELECT status FROM agent_approval_requests WHERE id = ?').get(requestId);
        assert.equal(row.status, 'approved');
    } finally {
        cleanup(runId, requestId);
    }
});

test('workflow approval callback signature is bound to request nonce', async () => {
    const runId = 'test-run-approval-signed';
    const requestId = 'test-request-approval-signed';
    const userId = 1;
    const token = `apr_${'c'.repeat(48)}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const credentialSlug = 'APPROVAL_CALLBACK_SIG_TEST';
    const secret = 'pivot-approval-callback-secret';
    const nonce = '00112233445566778899aabbccddeeff';
    const now = getBeijingTimestamp();

    db.prepare('DELETE FROM workflow_credentials WHERE slug = ?').run(credentialSlug);
    db.prepare(`
        INSERT INTO workflow_credentials (
            user_id, name, slug, description, secret_value, scope, allowed_units,
            version, use_count, created_at, updated_at
        ) VALUES (?, ?, ?, '', ?, 'personal', '', 1, 0, ?, ?)
    `).run(userId, 'Approval callback signature test', credentialSlug, encryptSecret(secret), now, now);
    db.prepare(`
        INSERT OR REPLACE INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'awaiting_approval', '{}', ?, ?)
    `).run(runId, userId, 'Signed callback test', 'Signed callback test goal', now, now);
    db.prepare(`
        INSERT OR REPLACE INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            callback_token_hash, callback_token_hint, callback_nonce, callback_credential_slug,
            callback_signature_required, timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', 'node_signed', 'node_signed', 'Signed callback approval', '', '', 'pending', 1, 1,
            '[{"approverUserIds":[1],"approverUnits":[]}]', '[]', '{}', ?, 'hint', ?, ?, 1, 'reject', NULL, ?, ?)
    `).run(requestId, runId, userId, tokenHash, nonce, credentialSlug, now, now);

    try {
        await assert.rejects(
            () => handleImApprovalCallback(token, {
                decision: 'approve',
                requestId,
                signature: signCallback(secret, token, requestId, 'approve')
            }, {}),
            /signature is invalid/i
        );
        const pending = db.prepare('SELECT status FROM agent_approval_requests WHERE id = ?').get(requestId);
        assert.equal(pending.status, 'pending');

        const approved = await handleImApprovalCallback(token, {
            decision: 'approve',
            requestId,
            signature: signCallback(secret, token, requestId, 'approve', nonce)
        }, {});
        assert.equal(approved.status, 'approved');
        const row = db.prepare('SELECT status, callback_token_hash, callback_nonce FROM agent_approval_requests WHERE id = ?').get(requestId);
        assert.equal(row.status, 'approved');
        assert.equal(row.callback_token_hash, null);
        assert.equal(row.callback_nonce, '');
    } finally {
        cleanup(runId, requestId, credentialSlug);
    }
});

test('workflow approval creation rejects missing callback credential secret', async () => {
    const runId = 'test-run-approval-credential-missing';
    const userId = 1;
    const now = getBeijingTimestamp();
    const credentialSlug = 'MISSING_CALLBACK_CREDENTIAL_TEST';

    db.prepare('DELETE FROM workflow_credentials WHERE slug = ?').run(credentialSlug);
    db.prepare(`
        INSERT OR REPLACE INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)
    `).run(runId, userId, 'Missing credential test', 'Missing credential test goal', now, now);

    try {
        await assert.rejects(
            () => waitForWorkflowApproval({
                run: { id: runId, user_id: userId },
                user: { id: userId, username: 'tester', unit: 'QA' },
                node: { id: 'node_missing_secret', title: 'Missing secret node' },
                input: {
                    title: 'Missing secret approval',
                    instructions: 'Check missing secret handling',
                    callbackCredential: credentialSlug,
                    timeoutAction: 'reject'
                },
                key: 'node_missing_secret'
            }),
            /Callback credential is unavailable/i
        );
    } finally {
        cleanup(runId, null, credentialSlug);
    }
});

test('workflow approval timeouts expire pending requests', async () => {
    const runId = 'test-run-approval-3';
    const requestId = 'test-request-timeout';
    const userId = 1;
    const now = getBeijingTimestamp();

    db.prepare(`
        INSERT OR REPLACE INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'awaiting_approval', '{}', ?, ?)
    `).run(runId, userId, '超时测试', '超时测试目标', now, now);
    db.prepare(`
        INSERT OR REPLACE INTO agent_approval_requests (
            id, run_id, user_id, request_type, node_key, approval_key, title, summary, instructions,
            status, current_level, required_levels, levels_json, decisions_json, input_json,
            timeout_action, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval', 'node_3', 'node_3', '超时审批', '', '', 'pending', 1, 1,
            '[{"approverUserIds":[1],"approverUnits":[]}]', '[]', '{}', 'reject', datetime('now', '+8 hours', '-1 day'), ?, ?)
    `).run(requestId, runId, userId, now, now);

    try {
        const processed = await runApprovalTimeouts(10);
        assert.equal(processed >= 1, true);
        const row = db.prepare('SELECT status FROM agent_approval_requests WHERE id = ?').get(requestId);
        assert.equal(row.status, 'expired');
    } finally {
        cleanup(runId, requestId);
    }
});
