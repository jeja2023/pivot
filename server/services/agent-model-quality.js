'use strict';

const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MIN_QUALITY_SAMPLES = 5;

function inferTaskType(run = {}) {
    if (String(run.run_mode || run.runMode || '') === 'dag') return 'workflow';
    const goal = String(run.goal || '').toLowerCase();
    if (/(?:检索|研究|来源|引用|知识库|政策|资料)/.test(goal)) return 'research';
    if (/(?:数据|sql|数据库|表格|统计|分析)/.test(goal)) return 'analysis';
    if (/(?:文档|报告|ppt|演示|word|pdf|写作)/.test(goal)) return 'document';
    if (/(?:浏览器|网页|网站|点击|登录)/.test(goal)) return 'browser';
    return 'general';
}

async function recordModelQualityOutcome({ run, user, verification } = {}) {
    const modelId = Number(run?.chosen_model_id || run?.model_id || 0);
    const userId = Number(user?.id || run?.user_id || 0);
    if (!modelId || !userId || !verification?.outcomeStatus) return null;
    const taskType = inferTaskType(run);
    const verified = verification.outcomeStatus === 'verified';
    const partial = verification.outcomeStatus === 'partial';
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO agent_model_quality_profiles (
            user_id, model_id, task_type, sample_count, verified_count, partial_count, failed_count, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT (user_id, model_id, task_type) DO UPDATE SET
            sample_count = agent_model_quality_profiles.sample_count + 1,
            verified_count = agent_model_quality_profiles.verified_count + EXCLUDED.verified_count,
            partial_count = agent_model_quality_profiles.partial_count + EXCLUDED.partial_count,
            failed_count = agent_model_quality_profiles.failed_count + EXCLUDED.failed_count,
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [userId, modelId, taskType, verified ? 1 : 0, partial ? 1 : 0, !verified && !partial ? 1 : 0, now]);
}

async function getModelQualityProfiles(user, taskType = 'general') {
    if (!user?.id) return [];
    const rows = await query(`
        SELECT user_id, model_id, task_type, sample_count, verified_count, partial_count, failed_count, updated_at
        FROM agent_model_quality_profiles
        WHERE user_id = ? AND task_type IN (?, 'general')
        ORDER BY task_type = ? DESC, sample_count DESC, updated_at DESC
    `, [user.id, taskType, taskType]);
    const seen = new Set();
    return rows.filter(row => {
        const key = String(row.model_id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(row => {
        const samples = Number(row.sample_count || 0);
        const verified = Number(row.verified_count || 0);
        const partial = Number(row.partial_count || 0);
        const failed = Number(row.failed_count || 0);
        return {
            modelId: Number(row.model_id), taskType: row.task_type, samples, verified, partial, failed,
            verifiedRate: samples ? verified / samples : 0,
            incompleteRate: samples ? (partial + failed) / samples : 1,
            eligible: samples >= MIN_QUALITY_SAMPLES,
            updatedAt: row.updated_at || null
        };
    });
}

module.exports = { getModelQualityProfiles, inferTaskType, recordModelQualityOutcome };
