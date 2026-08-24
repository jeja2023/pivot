const { getUserSettingValueAsync, setUserSettingAsync } = require('./user-settings');
const { hasSensitiveContent, normalizeMemoryType } = require('./long-term-memory/memory-utils');

const MEMORY_POLICY_KEY = 'agent_memory_policy';
const MEMORY_CATEGORIES = Object.freeze(['fact', 'preference', 'temporary', 'sensitive']);
const DEFAULT_MEMORY_POLICY = Object.freeze({
    autoCapture: true,
    blockedCategories: [],
    requireConfirmation: false,
    sensitiveHandling: 'never_persist'
});

function parsePolicy(value) {
    if (!value) return { ...DEFAULT_MEMORY_POLICY };
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch (_) { parsed = {}; }
    }
    const raw = parsed && typeof parsed === 'object' ? parsed : {};
    return {
        ...DEFAULT_MEMORY_POLICY,
        autoCapture: raw.autoCapture !== false,
        blockedCategories: [...new Set((Array.isArray(raw.blockedCategories) ? raw.blockedCategories : [])
            .map(String).filter(category => MEMORY_CATEGORIES.includes(category)))],
        requireConfirmation: raw.requireConfirmation === true,
        sensitiveHandling: 'never_persist'
    };
}

async function getMemoryPolicy(userId) {
    return parsePolicy(await getUserSettingValueAsync(userId, MEMORY_POLICY_KEY));
}

async function updateMemoryPolicy(userId, patch = {}) {
    const current = await getMemoryPolicy(userId);
    const policy = parsePolicy({ ...current, ...(patch || {}) });
    await setUserSettingAsync(userId, MEMORY_POLICY_KEY, JSON.stringify(policy));
    return policy;
}

function classifyMemory({ type = '', category = '', content = '' } = {}) {
    if (hasSensitiveContent(content) || String(category).toLowerCase() === 'sensitive') return 'sensitive';
    const requested = String(category || '').trim().toLowerCase();
    if (MEMORY_CATEGORIES.includes(requested) && requested !== 'sensitive') return requested;
    const normalizedType = normalizeMemoryType(type);
    if (normalizedType === 'preference') return 'preference';
    if (normalizedType === 'episode') return 'temporary';
    return 'fact';
}

function normalizeMemoryGovernance(input = {}) {
    const category = classifyMemory(input);
    return { category, retentionMode: String(input.retentionMode || (category === 'temporary' ? 'session' : 'persistent')).trim().slice(0, 24) };
}

async function evaluateMemoryCapture(userId, input = {}) {
    const category = classifyMemory(input);
    const policy = await getMemoryPolicy(userId);
    const blocked = category === 'sensitive' || !policy.autoCapture || policy.blockedCategories.includes(category);
    return {
        allowed: !blocked,
        category,
        requiresConfirmation: !blocked && policy.requireConfirmation,
        reason: category === 'sensitive' ? 'sensitive_never_persist'
            : !policy.autoCapture ? 'auto_capture_disabled'
                : policy.blockedCategories.includes(category) ? 'category_blocked' : ''
    };
}

async function resolveMemoryGovernance(userId, input = {}, options = {}) {
    const governance = normalizeMemoryGovernance(input);
    if (governance.category === 'sensitive') return { ...governance, allowed: false, reason: 'sensitive_never_persist' };
    try {
        const capture = await evaluateMemoryCapture(userId, { ...input, category: governance.category });
        if (!capture.allowed || (capture.requiresConfirmation && options.confirmed !== true)) return { ...governance, allowed: false, reason: capture.reason || 'confirmation_required' };
    } catch (_) {}
    return { ...governance, allowed: true, reason: '' };
}

async function filterMemoriesForRetrieval(userId, rows = []) {
    const policy = await getMemoryPolicy(userId);
    return (Array.isArray(rows) ? rows : []).filter(row => !policy.blockedCategories.includes(classifyMemory({ type: row.type, category: row.governance_class, content: row.content })) && !(row.sensitive === true || row.sensitive === 1));
}

function buildMemoryGovernanceContext(policyValue) {
    const policy = parsePolicy(policyValue);
    return `PIVOT_MEMORY_POLICY_BEGIN\n自动记忆：${policy.autoCapture ? '开启' : '关闭'}\n禁止类别：${policy.blockedCategories.length ? policy.blockedCategories.join('、') : '无'}\n敏感信息：永不持久化\nPIVOT_MEMORY_POLICY_END`;
}

module.exports = {
    DEFAULT_MEMORY_POLICY,
    MEMORY_CATEGORIES,
    MEMORY_POLICY_KEY,
    buildMemoryGovernanceContext,
    classifyMemory,
    evaluateMemoryCapture,
    getMemoryPolicy,
    parsePolicy,
    normalizeMemoryGovernance,
    resolveMemoryGovernance,
    filterMemoriesForRetrieval,
    updateMemoryPolicy
};
