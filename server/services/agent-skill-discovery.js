'use strict';

const { parseSkillManifest } = require('./agent-skills');

function stringList(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 100) : [];
}

function contractObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function skillCandidate(release) {
    let manifest;
    try { manifest = parseSkillManifest(release.manifest_json || release.manifest_yaml || '{}'); } catch (_) { return null; }
    if (!release.id || !release.name || !release.version || !release.digest || release.status !== 'published') return null;
    return {
        reference: { name: String(release.name), releaseId: String(release.id), version: String(release.version), digest: String(release.digest) },
        title: String(manifest.title || manifest.name || release.name).slice(0, 255),
        description: String(manifest.description || '').slice(0, 800),
        domains: stringList(manifest.tags),
        capabilities: stringList(manifest.capabilities || manifest.permissions),
        tools: stringList(manifest.tools),
        scope: String(release.rollout_scope || ''),
        inputs: contractObject(manifest.inputs),
        outputs: contractObject(manifest.outputs)
    };
}

async function currentCandidates(user, deps = {}) {
    const list = deps.listSkillCatalogForUser || require('./agent-releases').listSkillCatalogForUser;
    return (await list(user, { limit: 500, useOnly: true })).map(skillCandidate).filter(Boolean);
}

async function searchSkillsForUser(user, filters = {}, deps = {}) {
    const query = String(filters.query || '').trim().toLowerCase().slice(0, 200);
    const domain = String(filters.domain || '').trim().toLowerCase().slice(0, 100);
    const capability = String(filters.capability || '').trim();
    const limit = Math.max(1, Math.min(Number.parseInt(filters.limit, 10) || 20, 100));
    const candidates = (await currentCandidates(user, deps)).filter(item => {
        const haystack = [item.reference.name, item.title, item.description, ...item.domains].join(' ').toLowerCase();
        return (!query || haystack.includes(query))
            && (!domain || item.domains.some(tag => tag.toLowerCase() === domain))
            && (!capability || item.capabilities.includes(capability));
    });
    return { candidates: candidates.slice(0, limit).map(item => ({
        reference: item.reference, title: item.title, description: item.description,
        domains: item.domains, capabilities: item.capabilities, scope: item.scope
    })), total: candidates.length };
}

async function describeSkillForUser(user, reference = {}, deps = {}) {
    const name = String(reference.name || '').trim();
    const releaseId = String(reference.releaseId || '').trim();
    const version = String(reference.version || '').trim();
    const digest = String(reference.digest || '').trim();
    if (!name || !releaseId || !version || !digest) {
        const error = new Error('请提供搜索结果中的完整技能引用。'); error.status = 400; error.code = 'SKILL_REFERENCE_REQUIRED'; throw error;
    }
    const candidate = (await currentCandidates(user, deps)).find(item => item.reference.name === name);
    if (!candidate) {
        const error = new Error('技能不存在或当前用户无权访问。'); error.status = 404; error.code = 'SKILL_NOT_AVAILABLE'; throw error;
    }
    if (candidate.reference.releaseId !== releaseId || candidate.reference.version !== version || candidate.reference.digest !== digest) {
        const error = new Error('技能发布版本已变化，请重新搜索。'); error.status = 409; error.code = 'SKILL_REFERENCE_STALE'; throw error;
    }
    return candidate;
}

module.exports = { describeSkillForUser, searchSkillsForUser };
