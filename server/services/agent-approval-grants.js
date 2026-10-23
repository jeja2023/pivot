'use strict';

const crypto = require('crypto');

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    return value;
}

function approvalInputHash(input) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(input ?? {}))).digest('hex');
}

function approvalInputMatches(binding, input) {
    return binding?.inputHash === approvalInputHash(input)
        || (binding?.hashVersion !== 2 && binding?.inputHash === crypto.createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex'));
}

function approvalExpiryMs(value) {
    const text = String(value || '').trim();
    return text ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`) : Infinity;
}

function metadataOf(run) {
    if (run?.metadata && typeof run.metadata === 'object') return run.metadata;
    try { return JSON.parse(run?.metadata || '{}') || {}; } catch (_) { return {}; }
}

function findApprovalGrant(run, toolName, key, input) {
    const grants = metadataOf(run).approvalGrants || [];
    return Array.isArray(grants) ? grants.find(grant => grant && !grant.consumedAt && grant.tool === toolName
        && approvalExpiryMs(grant.expiresAt) > Date.now()
        && (grant.rememberForRun === true || (String(grant.key || '') === String(key || '') && approvalInputMatches(grant, input)))) || null : null;
}

function resolveApprovalKey(run, toolName, input, proposedKey = '') {
    const exact = findApprovalGrant(run, toolName, proposedKey, input);
    if (exact) return String(exact.key || proposedKey);
    const metadata = metadataOf(run);
    const resume = metadata.resumeContext || {};
    if (resume.approvedTool === toolName && approvalInputMatches({ inputHash: resume.approvedInputHash, hashVersion: resume.approvalHashVersion }, input)) {
        const grant = (Array.isArray(metadata.approvalGrants) ? metadata.approvalGrants : []).find(item => item && item.tool === toolName
            && (!resume.approvedApprovalKey || String(item.key || '') === String(resume.approvedApprovalKey))
            && findApprovalGrant(run, toolName, item.key, input) === item);
        if (grant) return String(grant.key || '');
    }
    const consumedKey = proposedKey && Array.isArray(metadata.approvalGrants) && metadata.approvalGrants.some(item => item?.consumedAt && String(item.key || '') === String(proposedKey));
    return (!consumedKey && proposedKey) || `${run?.id || 'run'}:approval:${crypto.randomUUID()}`;
}

function approvedOperationKey(run, toolName, key, input) {
    const grant = findApprovalGrant(run, toolName, key, input);
    if (!grant || grant.rememberForRun === true) return '';
    return `approved:${crypto.createHash('sha256').update(JSON.stringify([run.id, toolName, key, approvalInputHash(input)])).digest('hex')}`;
}

async function completeApprovalInvocation(run, user, toolName, key, input) {
    const grant = findApprovalGrant(run, toolName, key, input);
    if (!run?.id || !grant || grant.rememberForRun === true) return;
    const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
    const { getBeijingTimestamp } = require('../time');
    run.metadata = await updateAgentRunMetadataWithRetry(run.id, current => {
        const resume = { ...(current.resumeContext || {}) };
        if (resume.approvedTool === toolName && approvalInputMatches({ inputHash: resume.approvedInputHash, hashVersion: resume.approvalHashVersion }, input)) {
            delete resume.approvedTool; delete resume.approvedInputHash; delete resume.approvedApprovalKey; delete resume.approvalHashVersion;
        }
        return { ...current, resumeContext: resume, approvalGrants: (current.approvalGrants || []).map(item => item && item.tool === toolName
            && String(item.key || '') === String(key || '') && approvalInputMatches(item, input) && item.rememberForRun !== true
            ? { ...item, consumedAt: getBeijingTimestamp() } : item) };
    }, { userId: user.id });
}

module.exports = { approvalExpiryMs, approvalInputHash, approvalInputMatches, approvedOperationKey, completeApprovalInvocation, findApprovalGrant, resolveApprovalKey };
