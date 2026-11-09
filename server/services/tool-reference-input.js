'use strict';

function referenceError() {
    return Object.assign(new Error('工具引用中的名称、版本或摘要不一致或格式无效，请使用工具目录返回的同一份 toolRef。'),
        { code: 'TOOL_DISCOVERY_REFERENCE_CONFLICT', status: 409, category: 'validation' });
}

function canonicalReference(input = {}) {
    const result = {};
    const assign = (key, value) => {
        if (result[key] !== undefined && result[key] !== value) throw referenceError();
        result[key] = value;
    };
    const collectReferenceFields = (value, depth = 0) => {
        if (!value) return;
        if (depth > 3) throw referenceError();
        if (typeof value === 'string') {
            if (value.trim()) {
                if (value.length > 320) throw referenceError();
                assign('toolName', value.trim());
            }
            return;
        }
        if (typeof value !== 'object' || Array.isArray(value)) throw referenceError();
        for (const key of ['toolName', 'tool_name', 'name', 'fullName']) {
            if (value[key] == null || value[key] === '') continue;
            if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 320) throw referenceError();
            assign('toolName', value[key].trim());
        }
        for (const key of ['releaseId', 'release_id']) {
            const release = value[key];
            if (release == null || release === '') continue;
            if (!['string', 'number'].includes(typeof release) || !/^\d+$/.test(String(release)) || !Number.isSafeInteger(Number(release))) throw referenceError();
            assign('releaseId', Number(release));
        }
        for (const key of ['definitionDigest', 'definition_digest']) {
            if (value[key] == null || value[key] === '') continue;
            if (typeof value[key] !== 'string' || value[key].length > 320) throw referenceError();
            if (value[key].trim()) assign('definitionDigest', value[key].trim());
        }
        for (const key of ['toolRef', 'tool_ref', 'reference']) if (value[key]) collectReferenceFields(value[key], depth + 1);
    };
    collectReferenceFields(input);
    return result;
}

function normalizeDiscoveryInput(name, input = {}) {
    if (!['tools.execute', 'tools.describe'].includes(name) || !input || typeof input !== 'object' || Array.isArray(input)) return input;
    if (name === 'tools.describe' && Object.hasOwn(input, 'toolRefs')) {
        const toolRefs = require('./agent-tool-descriptions').normalizeDescriptionReferences(input);
        const normalized = { ...input, toolRefs };
        for (const key of ['toolRef', 'toolName', 'tool_ref', 'reference', 'tool_name', 'name', 'fullName', 'releaseId', 'release_id', 'definitionDigest', 'definition_digest']) delete normalized[key];
        return normalized;
    }
    const reference = canonicalReference(input);
    const normalized = { ...input };
    for (const key of ['toolRef', 'tool_ref', 'reference', 'tool_name', 'name', 'fullName', 'releaseId', 'release_id', 'definitionDigest', 'definition_digest']) delete normalized[key];
    if (reference.toolName) normalized.toolRef = reference;
    if (normalized.toolName && !reference.toolName) delete normalized.toolName;
    return normalized;
}

function missingReferenceResult(state) {
    const candidates = [...(state?.candidatesByName?.values?.() || [])].slice(0, 8).map(candidate => candidate.toolRef).filter(ref => ref?.toolName);
    return { type: 'tool_reference_required', executed: false, reason: 'TOOL_DISCOVERY_REFERENCE_REQUIRED', candidates,
        message: '本次尚未执行业务操作。请先 tools.search；从候选复制完整 toolRef（必须含 toolName），调用 tools.describe 核对契约，再以 {toolRef,input} 调用 tools.execute。不要重复提交空 toolRef，也不要让用户补充内部工具引用。' };
}

module.exports = { canonicalReference, missingReferenceResult, normalizeDiscoveryInput };
