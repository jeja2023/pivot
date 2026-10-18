'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, query, queryOne } = require('../server/db/client');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');
const {
    createPromptSection,
    manifestForSections,
    plannerCoreSection,
    renderPromptSections
} = require('../server/services/agent-prompt-registry');
const { approveStablePromptSectionDraft, resolveActivePromptSection, saveStablePromptSectionDraft } = require('../server/services/agent-prompt-registry');

test('Prompt Section manifest separates stable policy from dynamic task data without retaining dynamic contents', () => {
    const stable = plannerCoreSection();
    const dynamic = createPromptSection({ key: 'runtime', version: 'v1', owner: 'test', stability: 'dynamic', content: '用户令牌 abc-secret' });
    const manifest = manifestForSections([stable, dynamic]);
    assert.equal(manifest.stableSectionCount, 1);
    assert.equal(manifest.dynamicSectionCount, 1);
    assert.equal(JSON.stringify(manifest).includes('abc-secret'), false);
    const rendered = renderPromptSections([stable, dynamic]);
    assert.match(rendered, /PIVOT_PROMPT_SECTION_BEGIN key=agent_planner_core/);
    assert.match(rendered, /PIVOT_PROMPT_SECTION_BEGIN key=runtime/);
});

test('planner marks global policy as stable and chat/tool/world state as dynamic provenance', () => {
    const messages = buildPlannerMessages('核验交付', [{ name: 'rag.search' }], [], 'audit', {
        chatAgent: { systemPrompt: '只关注本周风险', mcpEnabled: false, ragEnabled: true },
        taskWorkingState: { goal: '核验交付', constraints: [{ id: 'c1', text: '必须提供证据', status: 'active' }], pendingWork: [], decisions: [], evidence: [] }
    }, null, { task: { id: 'task-1' } }, { mode: 'full' });
    const manifest = messages.promptManifest;
    assert.ok(manifest);
    assert.equal(manifest.sections.find(item => item.key === 'agent_planner_core').stability, 'stable');
    assert.equal(manifest.sections.find(item => item.key === 'agent_planner_tools').stability, 'dynamic');
    assert.equal(JSON.stringify(manifest).includes('只关注本周风险'), false);
    assert.match(messages[0].content, /PIVOT_PROMPT_SECTION_BEGIN key=agent_planner_tools/);
});

test('stable Prompt draft requires completed impact evaluation and independent admin approval before resolution', async () => {
    const owner = await queryOne("SELECT * FROM users WHERE username = 'admin' LIMIT 1");
    assert.ok(owner?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const reviewerName = `prompt-reviewer-${suffix}`;
    const suiteName = `prompt-impact-${suffix}`;
    const foreignTenantId = 900000000 + (process.pid % 100000000);
    let reviewer = null;
    let suiteId = null;
    let foreignSectionId = null;
    let activeBefore = [];
    const evaluationRunId = `prompt-eval-${suffix}`;
    try {
        reviewer = await queryOne(`
            INSERT INTO users (username, password_hash, nickname, role, status, created_at)
            VALUES (?, 'hash', 'Prompt 审阅员', 'admin', 'active', NOW()) RETURNING *
        `, [reviewerName]);
        activeBefore = await query(`
            SELECT id FROM agent_prompt_section_versions
            WHERE tenant_id = 0 AND section_key = 'agent_planner_core' AND stability = 'stable' AND status = 'active'
        `);
        const suite = await queryOne(`
            INSERT INTO agent_eval_suites (user_id, name, target_type, run_config, status, created_at, updated_at)
            VALUES (?, ?, 'agent', '{}', 'active', NOW(), NOW()) RETURNING id
        `, [owner.id, suiteName]);
        suiteId = suite.id;
        await execute(`
            INSERT INTO agent_eval_runs (id, suite_id, user_id, status, target_snapshot, summary, started_at, completed_at, created_at)
            VALUES (?, ?, ?, 'completed', '{}', '{"passRate":100}', NOW(), NOW(), NOW())
        `, [evaluationRunId, suiteId, owner.id]);
        const draft = await saveStablePromptSectionDraft(owner, {
            key: 'agent_planner_core', version: `planner-governed-${suffix}`,
            content: '你是受管 Pivot Agent。必须根据证据完成任务。', evaluationRunId, changeReason: '回归影响评测通过'
        });
        await assert.rejects(
            () => approveStablePromptSectionDraft(owner, draft.id),
            error => error.code === 'AGENT_PROMPT_INDEPENDENT_APPROVAL_REQUIRED'
        );
        const approved = await approveStablePromptSectionDraft(reviewer, draft.id);
        assert.equal(approved.status, 'active');
        assert.equal(approved.approvalStatus, 'approved');
        const resolved = await resolveActivePromptSection('agent_planner_core', plannerCoreSection(), owner);
        assert.equal(resolved.version, `planner-governed-${suffix}`);
        assert.match(resolved.content, /受管 Pivot Agent/);
        const foreign = await queryOne(`
            INSERT INTO agent_prompt_section_versions (
                owner_user_id, tenant_id, section_key, version, owner, stability, content_hash, content,
                status, approval_status, impact_report, created_at, updated_at, approved_at
            ) VALUES (?, ?, 'agent_planner_core', ?, 'platform.runtime', 'stable', ?, '租户隔离策略', 'active', 'approved', '{}', NOW(), NOW(), NOW())
            RETURNING id
        `, [owner.id, foreignTenantId, `foreign-${suffix}`, 'f'.repeat(64)]);
        foreignSectionId = foreign.id;
        const foreignResolved = await resolveActivePromptSection('agent_planner_core', plannerCoreSection(), { ...owner, tenant_id: foreignTenantId });
        assert.equal(foreignResolved.version, `foreign-${suffix}`);
        assert.equal((await resolveActivePromptSection('agent_planner_core', plannerCoreSection(), owner)).version, `planner-governed-${suffix}`);
    } finally {
        await execute('DELETE FROM agent_prompt_section_versions WHERE owner_user_id = ? AND section_key = ? AND version = ?', [owner.id, 'agent_planner_core', `planner-governed-${suffix}`]);
        if (foreignSectionId) await execute('DELETE FROM agent_prompt_section_versions WHERE id = ?', [foreignSectionId]);
        for (const row of activeBefore) {
            await execute(`
                UPDATE agent_prompt_section_versions SET status = 'active', updated_at = NOW()
                WHERE id = ? AND approval_status = 'approved'
            `, [row.id]);
        }
        await execute('DELETE FROM agent_eval_runs WHERE id = ?', [evaluationRunId]);
        if (suiteId) await execute('DELETE FROM agent_eval_suites WHERE id = ?', [suiteId]);
        if (reviewer?.id) await execute('DELETE FROM users WHERE id = ?', [reviewer.id]);
    }
});
