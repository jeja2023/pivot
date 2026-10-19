'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');

async function readLearningSettings(userId) {
    return queryOne("SELECT value FROM user_settings WHERE user_id = ? AND key = 'agent_learning_settings'", [userId]);
}

async function saveLearningSettings(userId, settings) {
    return transaction(async trx => {
        const { bumpMemoryRevision, lockMemoryGateState } = require('../services/long-term-memory/memory-gate');
        await trx.execute("INSERT INTO user_settings (user_id,key,value,updated_at) VALUES (?,'agent_learning_settings',?,NOW()) ON CONFLICT(user_id,key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [userId, JSON.stringify(settings)]);
        if (!settings.autoLearning) await bumpMemoryRevision(userId, trx);
        else await lockMemoryGateState(userId, trx);
    });
}

async function withLearningPublication(userId, publish) {
    return transaction(async trx => {
        await trx.execute("INSERT INTO user_settings (user_id,key,value,updated_at) VALUES (?,'agent_learning_settings','{}',NOW()) ON CONFLICT(user_id,key) DO NOTHING", [userId]);
        const row = await trx.queryOne("SELECT value FROM user_settings WHERE user_id = ? AND key = 'agent_learning_settings' FOR UPDATE", [userId]);
        const settings = row ? JSON.parse(row.value) : {};
        if (settings.autoLearning === false || settings.autoActivate === false) return null;
        return publish();
    });
}

async function sourceIsActive(versionId) {
    const row = await queryOne(`SELECT v.source_run_id, r.deleted_at, r.user_id, r.session_id, s.deleted_at AS session_deleted,
        CASE WHEN r.metadata->'chatBridge'->>'userMessageId' IS NULL THEN TRUE ELSE EXISTS (
            SELECT 1 FROM messages m WHERE m.id::text = r.metadata->'chatBridge'->>'userMessageId' AND m.user_id = r.user_id AND m.deleted_at IS NULL
        ) END AS message_active
        FROM agent_skill_versions v LEFT JOIN agent_runs r ON r.id = v.source_run_id LEFT JOIN sessions s ON s.id = r.session_id
        WHERE v.id = ?`, [versionId]);
    return Boolean(row && (!row.source_run_id || row.user_id && !row.deleted_at && !row.session_deleted && row.message_active));
}

async function humanVerifiedExamples(userId) {
    return query(`SELECT r.id,r.goal,r.final_answer,r.metadata,f.modified_answer,
        (SELECT jsonb_agg(DISTINCT c.tool_name) FROM agent_tool_calls c WHERE c.run_id = r.id AND c.status IN ('success','completed')) AS tools
        FROM agent_runs r JOIN agent_feedback f ON f.run_id = r.id AND f.user_id = r.user_id
        JOIN sessions s ON s.id = r.session_id AND s.deleted_at IS NULL
        WHERE r.user_id = ? AND r.deleted_at IS NULL AND f.source = 'user' AND f.rating >= 4
          AND r.metadata->'taskVerification'->>'outcomeStatus' = 'verified'
        ORDER BY f.updated_at DESC LIMIT 100`, [userId]);
}

async function evaluationBinding(evaluationRunId, versionId, userId) {
    return queryOne(`SELECT COUNT(*)::integer AS total, COUNT(*) FILTER (
        WHERE r.metadata->'evaluationCandidate'->>'versionId' = ?
          AND r.metadata->'evaluationCandidate'->>'digest' = v.content_digest
    )::integer AS matched FROM agent_eval_results e JOIN agent_runs r ON r.id = e.agent_run_id
        JOIN agent_skill_versions v ON v.id = ? WHERE e.eval_run_id = ? AND r.user_id = ?`, [String(versionId), versionId, evaluationRunId, userId]);
}

async function pendingEvaluations() {
    return query("SELECT id,user_id,result_summary FROM agent_learning_jobs WHERE status = 'validating' ORDER BY updated_at LIMIT 20");
}

async function resumeLearningJob(id, userId) {
    return execute("UPDATE agent_learning_jobs SET status = 'queued', attempts = 0, next_run_at = NOW(), updated_at = NOW() WHERE id = ? AND user_id = ? AND status = 'validating'", [id, userId]);
}

async function personalExperienceRollout(releaseId, userId) {
    const learned = await queryOne("SELECT id FROM agent_evolution_proposals WHERE user_id = ? AND release_id = ? AND activation_mode = 'auto' AND scope = 'personal' LIMIT 1", [userId, String(releaseId)]);
    if (!learned) return { percent: 100, reason: 'explicit_or_existing_release' };
    const metrics = await queryOne(`SELECT COUNT(*)::integer AS samples,
        COUNT(*) FILTER (WHERE r.metadata->'taskVerification'->>'outcomeStatus' = 'verified')::integer AS verified,
        COUNT(*) FILTER (WHERE f.source = 'user' AND f.rating >= 4)::integer AS adopted
        FROM agent_runs r LEFT JOIN agent_feedback f ON f.run_id = r.id AND f.user_id = r.user_id
        WHERE r.user_id = ? AND r.metadata->>'skillReleaseId' = ? AND r.status IN ('completed','partial','error','failed') AND r.deleted_at IS NULL`, [userId, String(releaseId)]);
    const expanded = Number(metrics.samples) >= 10 && Number(metrics.adopted) >= 5 && Number(metrics.verified) / Number(metrics.samples) >= 0.9;
    return { percent: expanded ? 100 : 20, reason: expanded ? 'verified_personal_expansion' : 'personal_canary', ...metrics };
}

module.exports = { sourceIsActive, humanVerifiedExamples, evaluationBinding, pendingEvaluations, resumeLearningJob, personalExperienceRollout, readLearningSettings, saveLearningSettings, withLearningPublication };
