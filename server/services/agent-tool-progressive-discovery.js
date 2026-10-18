'use strict';

/* 规划器仅接收渐进式发现元工具。经过权限过滤的完整工具目录在 tools.execute
 * 成功解析此前已检视契约的 toolRef 后，继续向底层执行运行时开放。 */
const META_TOOL_NAMES = Object.freeze(new Set(['tools.search', 'tools.describe', 'tools.execute', 'tools.batch_read']));
const DISCOVERY_CACHE_TTL_MS = 30 * 1000;

function buildProgressivePlannerToolList(toolList = []) {
    return (toolList || [])
        .filter(tool => META_TOOL_NAMES.has(String(tool?.name || '')))
        .map(tool => ({
            ...tool,
            description: `${String(tool.description || '').trim()} 必须遵循 search → describe → execute 顺序。`
        }));
}

function plannerToolNames(toolList = []) {
    return new Set(buildProgressivePlannerToolList(toolList).map(tool => String(tool.name)));
}

function createToolDiscoveryState(options = {}) {
    const ttlMs = Math.min(Math.max(Number(options.ttlMs) || DISCOVERY_CACHE_TTL_MS, 1_000), 5 * 60 * 1000);
    return {
        searched: new Set(),
        described: new Set(),
        descriptions: new Map(),
        searchExpiry: new Map(),
        descriptionExpiry: new Map(),
        searchCache: new Map(),
        catalogVersion: '',
        ttlMs,
        now: typeof options.now === 'function' ? options.now : () => Date.now()
    };
}

function referenceKey(reference = {}) {
    const name = String(reference.toolName || reference.tool_name || reference.name || '').trim();
    const release = reference.releaseId ?? reference.release_id ?? '';
    const digest = String(reference.definitionDigest || reference.definition_digest || '').trim();
    return `${name}|${release}|${digest}`;
}

function discoveryError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    error.statusCode = 409;
    return error;
}

function stateNow(state) {
    const value = Number(state?.now?.() ?? Date.now());
    return Number.isFinite(value) ? value : Date.now();
}

function clearDiscoveryState(state) {
    if (!state) return;
    state.searched?.clear?.();
    state.described?.clear?.();
    state.descriptions?.clear?.();
    state.searchExpiry?.clear?.();
    state.descriptionExpiry?.clear?.();
    state.searchCache?.clear?.();
}

function invalidateOnCatalogChange(state, catalogVersion = '') {
    if (!state || !catalogVersion) return;
    if (state.catalogVersion && state.catalogVersion !== catalogVersion) clearDiscoveryState(state);
    state.catalogVersion = catalogVersion;
}

function throwExpiredDiscovery(reference = {}) {
    throw discoveryError(`工具目录发现已过期，请重新搜索并确认 ${String(reference.toolName || reference.tool_name || reference.name || '该工具')}。`, 'TOOL_DISCOVERY_SEARCH_EXPIRED');
}

function rememberSearch(state, result = {}) {
    if (!state?.searched) return;
    invalidateOnCatalogChange(state, String(result.catalogVersion || ''));
    const expiresAt = stateNow(state) + (Number(state.ttlMs) || DISCOVERY_CACHE_TTL_MS);
    (result.candidates || []).forEach(candidate => {
        const key = referenceKey(candidate?.toolRef || {});
        if (key !== '||') {
            state.searched.add(key);
            state.searchExpiry?.set?.(key, expiresAt);
        }
    });
}

function rememberDescription(state, reference = {}, description = null) {
    if (!state?.described) return;
    const key = referenceKey(reference);
    if (key === '||') return;
    state.described.add(key);
    if (description && state.descriptions?.set) state.descriptions.set(key, description);
    const searchExpiry = state.searchExpiry?.get?.(key);
    state.descriptionExpiry?.set?.(key, searchExpiry || (stateNow(state) + (Number(state.ttlMs) || DISCOVERY_CACHE_TTL_MS)));
}

function getRememberedDescription(state, reference = {}) {
    const key = referenceKey(reference);
    if (key === '||' || !state?.descriptions?.get) return null;
    return state.descriptions.get(key) || null;
}

function assertSearched(state, reference = {}) {
    if (!state?.searched) return;
    const key = referenceKey(reference);
    if (!state.searched.has(key)) {
        throw discoveryError('请先使用 tools.search 获取当前已授权工具的 toolRef，再读取其契约。', 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    }
    const expiresAt = Number(state.searchExpiry?.get?.(key) || 0);
    if (expiresAt && stateNow(state) >= expiresAt) {
        state.searched.delete(key);
        state.described?.delete?.(key);
        state.descriptions?.delete?.(key);
        state.searchExpiry?.delete?.(key);
        state.descriptionExpiry?.delete?.(key);
        throwExpiredDiscovery(reference);
    }
}

function assertDescribed(state, reference = {}) {
    if (!state?.described) return;
    assertSearched(state, reference);
    const key = referenceKey(reference);
    if (!state.described.has(key)) {
        throw discoveryError('请先使用 tools.describe 确认该工具的输入、风险和权限要求，再执行。', 'TOOL_DISCOVERY_DESCRIBE_REQUIRED');
    }
    const expiresAt = Number(state.descriptionExpiry?.get?.(key) || 0);
    if (expiresAt && stateNow(state) >= expiresAt) {
        state.described.delete(key);
        state.descriptions?.delete?.(key);
        state.descriptionExpiry?.delete?.(key);
        throwExpiredDiscovery(reference);
    }
}

module.exports = {
    assertDescribed,
    assertSearched,
    buildProgressivePlannerToolList,
    createToolDiscoveryState,
    getRememberedDescription,
    plannerToolNames,
    referenceKey,
    rememberDescription,
    rememberSearch
};
