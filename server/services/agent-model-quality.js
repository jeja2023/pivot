'use strict';

const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MIN_QUALITY_SAMPLES = 30;
const MAX_QUALITY_PROFILE_AGE_DAYS = 30;
const QUALITY_SLO = Object.freeze({
    verifiedRateLowerBound: 0.75,
    incompleteRate: 0.10
});

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

function wilsonLowerBound(successes, samples, z = 1.96) {
    const total = Number(samples || 0);
    if (total <= 0) return 0;
    const proportion = Math.min(Math.max(Number(successes || 0) / total, 0), 1);
    const zSquared = z * z;
    const denominator = 1 + zSquared / total;
    const center = proportion + zSquared / (2 * total);
    const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total);
    return Math.max(0, (center - margin) / denominator);
}

function profileAgeDays(updatedAt, now = new Date()) {
    const timestamp = new Date(updatedAt || '').getTime();
    if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (now.getTime() - timestamp) / (24 * 60 * 60 * 1000));
}

function assessModelQualityProfile(profile = {}, { now = new Date() } = {}) {
    const samples = Number(profile.samples ?? profile.sample_count ?? 0);
    const verified = Number(profile.verified ?? profile.verified_count ?? 0);
    const partial = Number(profile.partial ?? profile.partial_count ?? 0);
    const failed = Number(profile.failed ?? profile.failed_count ?? 0);
    const verifiedRate = samples ? verified / samples : 0;
    const incompleteRate = samples ? (partial + failed) / samples : 1;
    const verifiedRateLowerBound = wilsonLowerBound(verified, samples);
    const ageDays = profileAgeDays(profile.updatedAt ?? profile.updated_at, now);
    const blockers = [];
    if (samples < MIN_QUALITY_SAMPLES) blockers.push('sample_insufficient');
    if (ageDays > MAX_QUALITY_PROFILE_AGE_DAYS) blockers.push('profile_stale');
    if (verifiedRateLowerBound < QUALITY_SLO.verifiedRateLowerBound) blockers.push('verified_rate_lower_bound_low');
    if (incompleteRate > QUALITY_SLO.incompleteRate) blockers.push('incomplete_rate_high');
    return {
        samples, verified, partial, failed, verifiedRate, incompleteRate, verifiedRateLowerBound,
        ageDays, eligible: blockers.length === 0, status: blockers.length ? (samples < MIN_QUALITY_SAMPLES || ageDays > MAX_QUALITY_PROFILE_AGE_DAYS ? 'insufficient_data' : 'attention') : 'passing',
        blockers, thresholds: { minSamples: MIN_QUALITY_SAMPLES, maxAgeDays: MAX_QUALITY_PROFILE_AGE_DAYS, ...QUALITY_SLO }
    };
}

async function getModelQualityProfiles(user, taskType = 'general', options = {}) {
    if (!user?.id) return [];
    const rows = await query(`
        SELECT user_id, model_id, task_type, sample_count, verified_count, partial_count, failed_count, updated_at
        FROM agent_model_quality_profiles
        WHERE user_id = ? AND task_type IN (?, 'general')
        ORDER BY task_type = ? DESC, sample_count DESC, updated_at DESC
    `, [user.id, taskType, taskType]);
    const seen = new Set();
    const now = options.now instanceof Date ? options.now : new Date();
    return rows.filter(row => {
        const key = String(row.model_id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(row => {
        const assessed = assessModelQualityProfile({
            samples: Number(row.sample_count || 0), verified: Number(row.verified_count || 0),
            partial: Number(row.partial_count || 0), failed: Number(row.failed_count || 0), updatedAt: row.updated_at || null
        }, { now });
        return {
            modelId: Number(row.model_id), taskType: row.task_type, ...assessed, updatedAt: row.updated_at || null
        };
    });
}

module.exports = {

    assessModelQualityProfile,
    getModelQualityProfiles,
    inferTaskType,

    recordModelQualityOutcome,
    wilsonLowerBound
};
