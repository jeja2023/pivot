'use strict';

const { normalizeMaxSteps } = require('./agent-validators');

const PROFILES = Object.freeze({
    knowledge_qa: { segmentSteps: 6, totalSteps: 6, totalRuntimeSeconds: 600, noProgressRounds: 4 },
    standard: { segmentSteps: 30, totalSteps: 60, totalRuntimeSeconds: 1800, noProgressRounds: 6 },
    complex: { segmentSteps: 50, totalSteps: 120, totalRuntimeSeconds: 3600, noProgressRounds: 8 }
});

function selectChatRoundProfile({ decision = {}, content = '', knowledgeOnly = false } = {}) {
    if (knowledgeOnly) return 'knowledge_qa';
    const capabilities = new Set((decision.requiredCapabilities || []).map(value => String(value).split('.')[0]));
    capabilities.delete('agent'); capabilities.delete('conversation');
    const deliverables = Array.isArray(decision.deliverables) ? decision.deliverables : [];
    // 仅依据已有的任务结构与明确长资料选择档位，单纯开启工具不会自动扩大预算。
    return deliverables.length >= 3 || (deliverables.length >= 2 && capabilities.size >= 2)
        || (String(content).length > 12000 && decision.acceptance?.artifactRequired === true) ? 'complex' : 'standard';
}

function profileRoundPolicy(profile, tokens) {
    const value = PROFILES[profile] || PROFILES.standard;
    return { version: 1, profile, ...value, reserveTokens: Math.min(8192, Math.floor(Math.max(0, tokens) * .1)),
        reserveRuntimeSeconds: 30, reserveToolCalls: profile === 'knowledge_qa' ? 1 : 2 };
}

function parseObject(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '{}') || {}; } catch (_) { return {}; }
}

function runRoundPolicy(run = {}) {
    const metadata = parseObject(run.metadata), budget = parseObject(run.budget_config);
    const stored = metadata.executionPolicy || {};
    const segmentSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
    const explicit = budget.max_steps ?? budget.maxSteps;
    const totalSteps = explicit == null ? segmentSteps : Math.max(0, Number(explicit) || 0);
    return { ...profileRoundPolicy(stored.profile || metadata.chatBridge?.executionProfile || 'standard', Number(budget.max_tokens_total ?? run.max_token_budget) || 0),
        segmentSteps, totalSteps, totalRuntimeSeconds: Number(budget.max_runtime_seconds ?? budget.maxRuntimeSeconds) || 600,
        noProgressRounds: stored.noProgressRounds === 8 ? 8 : metadata.chatBridge?.executionProfile === 'knowledge_qa' ? 4 : 6 };
}

module.exports = { profileRoundPolicy, runRoundPolicy, selectChatRoundProfile };
