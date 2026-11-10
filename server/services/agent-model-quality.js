'use strict';

const { query } = require('../db/client');
const { createHash } = require('node:crypto');

function modelQualityIdentity(model = {}) {
    if (!model.url || !(model.model_name || model.name)) return '';
    return createHash('sha256').update(`${model.url}\n${model.model_name || model.name}`).digest('hex');
}

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

// 验收表以 run_id 唯一更新；读取权威结果，不再把重试累计成独立样本。
async function recordModelQualityOutcome({ run, user } = {}) {
    if (!run?.id || !user?.id) return null;
    const profiles = await getModelQualityProfiles(user, inferTaskType(run));
    return profiles.find(item => item.modelId === Number(run.chosen_model_id || run.model_id)) || null;
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
    const now = options.now instanceof Date ? options.now : new Date();
    const cutoff = new Date(now.getTime() - MAX_QUALITY_PROFILE_AGE_DAYS * 86400000).toISOString();
    const rows = await query(`
        WITH outcomes AS (
            SELECT COALESCE(r.chosen_model_id, r.model_id) AS model_id, v.outcome_status, v.created_at,
                CASE WHEN r.run_mode = 'dag' THEN 'workflow'
                    WHEN r.goal ~ '(检索|研究|来源|引用|知识库|政策|资料)' THEN 'research'
                    WHEN lower(r.goal) ~ '(数据|sql|数据库|表格|统计|分析)' THEN 'analysis'
                    WHEN lower(r.goal) ~ '(文档|报告|ppt|演示|word|pdf|写作)' THEN 'document'
                    WHEN r.goal ~ '(浏览器|网页|网站|点击|登录)' THEN 'browser'
                    ELSE 'general' END AS task_type
            FROM agent_verifications v JOIN agent_runs r ON r.id = v.run_id AND r.user_id = v.user_id
            JOIN models m ON m.id = COALESCE(r.chosen_model_id, r.model_id)
            WHERE v.user_id = ? AND v.created_at >= ?::timestamptz AND v.created_at <= ?::timestamptz
                AND COALESCE(v.report->>'executionModelIdentity', v.report->'semanticVerification'->>'modelIdentity') = encode(sha256(convert_to(m.url || chr(10) || COALESCE(NULLIF(m.model_name, ''), m.name, ''), 'UTF8')), 'hex')
                AND r.deleted_at IS NULL AND r.status IN ('completed', 'completed_with_errors', 'partial', 'needs_input', 'failed', 'error')
        )
        SELECT model_id, task_type, COUNT(*) AS sample_count,
            COUNT(*) FILTER (WHERE outcome_status = 'verified') AS verified_count,
            COUNT(*) FILTER (WHERE outcome_status = 'partial') AS partial_count,
            COUNT(*) FILTER (WHERE outcome_status NOT IN ('verified', 'partial')) AS failed_count,
            MAX(created_at) AS updated_at
        FROM outcomes WHERE model_id IS NOT NULL AND task_type IN (?, 'general')
        GROUP BY model_id, task_type ORDER BY task_type = ? DESC, sample_count DESC, updated_at DESC
    `, [user.id, cutoff, now.toISOString(), taskType, taskType]);
    const seen = new Set();
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
    modelQualityIdentity,

    recordModelQualityOutcome,
    wilsonLowerBound
};
