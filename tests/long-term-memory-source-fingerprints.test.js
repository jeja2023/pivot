'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    attachMemorySourceEvidence,
    attachWorkspaceSource,
    approveMemorySourceReview,
    markMemoriesForChangedSource,
    revokeMemoriesForSourceMessages,
    sourceFingerprint,
    updateMemory,
    updateMemoryStatus,
    updateMemoryStatuses
} = require('../server/services/long-term-memory');

const FINGERPRINT_SECRET = 'pivot-memory-source-fingerprint-test-secret-0123456789';

test('长期记忆来源摘要使用独立 HMAC，缺少密钥时不退化为可猜测摘要', () => {
    const input = { sourceKind: 'message', sourceRef: 'message:42', content: '短且可猜测的来源正文' };
    const digest = sourceFingerprint(input, { PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: FINGERPRINT_SECRET });
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, sourceFingerprint(input, { PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: `${FINGERPRINT_SECRET}-other` }));
    assert.equal(sourceFingerprint(input, {}), '');
    assert.equal(sourceFingerprint(input, { PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: FINGERPRINT_SECRET, JWT_SECRET: FINGERPRINT_SECRET }), '');
});

test('外部来源关联只存服务器内计算的 HMAC，不接受客户端提交的裸摘要', async () => {
    const calls = [];
    const result = await attachMemorySourceEvidence(7, 12, {
        sourceKind: 'knowledge_document', sourceRef: 'knowledge_document:19',
        sourceContent: 'document-version-hash', sourceVersion: '3', evidenceExcerpt: '制度正文'
    }, {
        env: { PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: FINGERPRINT_SECRET },
        executor: {
            queryOne: async (sql, params) => {
                calls.push(['queryOne', sql, params]);
                return { id: 12 };
            },
            execute: async (sql, params) => { calls.push(['execute', sql, params]); return 1; }
        }
    });
    assert.deepEqual(result, { memoryId: 12, sourceKind: 'knowledge_document', sourceRef: 'knowledge_document:19' });
    const write = calls.find(item => item[0] === 'execute');
    assert.match(write[1], /ON CONFLICT \(memory_id, source_kind, source_ref\) WHERE source_ref <> ''/);
    assert.match(write[2][4], /^[a-f0-9]{64}$/);
    assert.notEqual(write[2][4], 'document-version-hash');
});

test('代码工作区来源只能使用受控设备快照的版本摘要关联', async () => {
    const calls = [];
    const result = await attachWorkspaceSource({ id: 7 }, 12, { deviceId: 'device-7', worktreeName: 'review-tree' }, {
        env: { PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET: FINGERPRINT_SECRET },
        resolveConnectorDeviceForTool: async () => 'device-7',
        executeConnectorTool: async () => ({ action: 'workspace.inspect', revision: 'a'.repeat(64) }),
        workspaceLifecycle: {
            workspaceResultRevision: value => value.revision,
            workspaceMemorySourceReference: (deviceId, worktreeName) => `workspace:${deviceId}:${worktreeName}`
        },
        executor: {
            queryOne: async () => ({ id: 12 }),
            execute: async (sql, params) => { calls.push({ sql, params }); return 1; }
        }
    });
    assert.deepEqual(result, { memoryId: 12, sourceKind: 'workspace', sourceRef: 'workspace:device-7:review-tree' });
    assert.equal(calls[0].params[2], 'workspace');
    assert.equal(calls[0].params[3], 'workspace:device-7:review-tree');
    assert.match(calls[0].params[4], /^[a-f0-9]{64}$/);
});

test('删除部分来源会将剩余来源加入复核队列，而非留下不可恢复状态', async () => {
    const originalSecret = process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
    process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = FINGERPRINT_SECRET;
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const sessionId = `memory-source-loss-${suffix}`;
    let memoryId;
    let firstMessageId;
    let secondMessageId;
    try {
        await execute('INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())', [sessionId, user.id, 'partial source loss test']);
        firstMessageId = Number((await queryOne("INSERT INTO messages (session_id, user_id, role, content, created_at) VALUES (?, ?, 'user', '第一份来源', NOW()) RETURNING id", [sessionId, user.id])).id);
        secondMessageId = Number((await queryOne("INSERT INTO messages (session_id, user_id, role, content, created_at) VALUES (?, ?, 'user', '第二份来源', NOW()) RETURNING id", [sessionId, user.id])).id);
        memoryId = Number((await queryOne(`
            INSERT INTO memories (user_id, type, content, origin, status, source_session_id, source_message_ids, created_at, updated_at)
            VALUES (?, 'fact', ?, 'automatic', 'active', ?, ?::jsonb, NOW(), NOW()) RETURNING id
        `, [user.id, '该事实必须同时有两个来源', sessionId, JSON.stringify([firstMessageId, secondMessageId])])).id);
        for (const [messageId, content] of [[firstMessageId, '第一份来源'], [secondMessageId, '第二份来源']]) {
            const ref = `message:${messageId}`;
            await execute(`
                INSERT INTO memory_source_evidence (memory_id, user_id, session_id, message_id, source_kind, source_ref, source_fingerprint, asserted_by, created_at)
                VALUES (?, ?, ?, ?, 'message', ?, ?, 'user', NOW())
            `, [memoryId, user.id, sessionId, messageId, ref, sourceFingerprint({ sourceKind: 'message', sourceRef: ref, content })]);
        }

        const revoked = await revokeMemoriesForSourceMessages(user.id, [firstMessageId]);
        assert.equal(revoked.revoked, 0);
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'review_required');
        const remaining = await queryOne('SELECT source_ref, review_required_at IS NOT NULL AS pending FROM memory_source_evidence WHERE memory_id = ?', [memoryId]);
        assert.equal(remaining.source_ref, `message:${secondMessageId}`);
        assert.equal(remaining.pending, true);

        const approved = await approveMemorySourceReview(user.id, memoryId, { sourceKind: 'message', sourceRef: remaining.source_ref });
        assert.equal(approved.activated, true);
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'active');
    } finally {
        if (memoryId) await execute('DELETE FROM memories WHERE id = ?', [memoryId]);
        if (firstMessageId) await execute('DELETE FROM messages WHERE id = ?', [firstMessageId]);
        if (secondMessageId) await execute('DELETE FROM messages WHERE id = ?', [secondMessageId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        if (originalSecret === undefined) delete process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
        else process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = originalSecret;
    }
});

test('来源变更会隔离记忆，且只能经当前来源复核后恢复活跃', async () => {
    const originalSecret = process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
    process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = FINGERPRINT_SECRET;
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const sessionId = `memory-fingerprint-${suffix}`;
    let messageId;
    let memoryId;
    try {
        await execute('INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())', [sessionId, user.id, 'source fingerprint test']);
        const message = await queryOne(`
            INSERT INTO messages (session_id, user_id, role, content, created_at)
            VALUES (?, ?, 'user', ?, NOW()) RETURNING id
        `, [sessionId, user.id, '原始来源正文']);
        messageId = Number(message.id);
        const memory = await queryOne(`
            INSERT INTO memories (user_id, type, content, origin, status, source_session_id, source_message_ids, created_at, updated_at)
            VALUES (?, 'fact', ?, 'automatic', 'active', ?, ?::jsonb, NOW(), NOW()) RETURNING id
        `, [user.id, '来源必须能够复核', sessionId, JSON.stringify([messageId])]);
        memoryId = Number(memory.id);
        const ref = `message:${messageId}`;
        const before = sourceFingerprint({ sourceKind: 'message', sourceRef: ref, content: '原始来源正文' });
        await execute(`
            INSERT INTO memory_source_evidence (memory_id, user_id, session_id, message_id, source_kind, source_ref, source_fingerprint, asserted_by, created_at)
            VALUES (?, ?, ?, ?, 'message', ?, ?, 'user', NOW())
        `, [memoryId, user.id, sessionId, messageId, ref, before]);

        await execute('UPDATE messages SET content = ? WHERE id = ? AND user_id = ?', ['已变化的来源正文', messageId, user.id]);
        const changed = await markMemoriesForChangedSource(user.id, {
            sourceKind: 'message', sourceRef: ref,
            sourceFingerprint: sourceFingerprint({ sourceKind: 'message', sourceRef: ref, content: '已变化的来源正文' }),
            reason: 'test_source_changed'
        });
        assert.deepEqual(changed.memoryIds, [memoryId]);
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'review_required');
        assert.equal((await queryOne('SELECT review_required_at IS NOT NULL AS pending FROM memory_source_evidence WHERE memory_id = ?', [memoryId])).pending, true);
        await assert.rejects(
            () => updateMemoryStatus(user.id, memoryId, 'active'),
            error => error.code === 'MEMORY_SOURCE_REVIEW_REQUIRED'
        );
        const bulkRestore = await updateMemoryStatuses(user.id, [memoryId], 'active');
        assert.equal(bulkRestore.updated, 0);
        assert.deepEqual(bulkRestore.reviewRequiredIds, [memoryId]);
        await assert.rejects(
            () => updateMemory(user.id, memoryId, { status: 'active' }),
            error => error.code === 'MEMORY_SOURCE_REVIEW_REQUIRED'
        );

        const approved = await approveMemorySourceReview(user.id, memoryId, { sourceKind: 'message', sourceRef: ref });
        assert.equal(approved.reviewed, 1);
        assert.equal(approved.reviewRemaining, 0);
        assert.equal(approved.activated, true);
        const evidence = await queryOne('SELECT source_fingerprint, review_required_at, reviewed_at, reviewed_by_user_id FROM memory_source_evidence WHERE memory_id = ?', [memoryId]);
        assert.equal(evidence.source_fingerprint, sourceFingerprint({ sourceKind: 'message', sourceRef: ref, content: '已变化的来源正文' }));
        assert.equal(evidence.review_required_at, null);
        assert.ok(evidence.reviewed_at);
        assert.equal(Number(evidence.reviewed_by_user_id), Number(user.id));
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'active');
    } finally {
        if (memoryId) await execute('DELETE FROM memories WHERE id = ?', [memoryId]);
        if (messageId) await execute('DELETE FROM messages WHERE id = ?', [messageId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        if (originalSecret === undefined) delete process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
        else process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = originalSecret;
    }
});
