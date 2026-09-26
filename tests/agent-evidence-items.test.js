'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { extractEvidenceCandidates, listAgentEvidenceForUser, recordEvidenceFromToolOutput } = require('../server/services/agent-evidence-items');

test('evidence extraction keeps normalized source references and removes duplicates', () => {
    const extracted = extractEvidenceCandidates({ results: [
        { title: '政策', url: 'https://example.com/policy', snippet: '政策摘要' },
        { title: '政策', url: 'https://example.com/policy', snippet: '政策摘要' }
    ] });
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].url, 'https://example.com/policy');
});

test('evidence records are scoped to the owning Agent run', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `evidence-${suffix}`;
    try {
        await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'evidence', 'evidence', 'running', '{}', NOW(), NOW())`, [runId, user.id]);
        const recorded = await recordEvidenceFromToolOutput({
            run: { id: runId }, user, toolName: 'agent.web_search',
            output: { results: [{ title: '来源', url: 'https://example.com/source', snippet: '关键摘录' }] }
        });
        assert.equal(recorded.length, 1);
        const evidence = await listAgentEvidenceForUser(runId, user);
        assert.equal(evidence.length, 1);
        assert.equal(evidence[0].title, '来源');
        assert.equal(await listAgentEvidenceForUser(runId, { id: Number(user.id) + 999999 }), null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
