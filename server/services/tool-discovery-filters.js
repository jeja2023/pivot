'use strict';

const { normalizeRisk } = require('./agent-contracts');
const DISCOVERY_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

function discoveryRisk(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!DISCOVERY_RISK_LEVELS.includes(text) && !/^[0-5]$/.test(text)) return null;
    return normalizeRisk(text);
}

function matchesDiscoveryFilters(tool, filters = {}) {
    const risk = String(filters.riskLevel ?? filters.risk_level ?? '').trim();
    if (risk) {
        const expected = discoveryRisk(risk);
        if (expected === null || discoveryRisk(tool.risk_level ?? tool.risk ?? 'low') !== expected) return false;
    }
    const source = String(filters.source || '').trim();
    if (source && String(tool.source || '') !== source) return false;
    const capability = String(filters.capability || '').trim();
    if (capability && !(tool.capabilities || []).some(item => String(item) === capability)) return false;
    const requireApproval = filters.requireApproval ?? filters.require_approval;
    if (requireApproval === true && !Boolean(tool.approval_required || tool.requiresApproval)) return false;
    return true;
}

function emptySearchFeedback(tools, filters) {
    // 只描述调用方已完成实时授权和任务范围过滤的目录，不放宽本次筛选或自动执行工具。
    if (!tools.length) return { reason: 'no_authorized_tools', message: '当前任务没有可用的授权工具，请检查工具是否启用并加入任务范围。' };
    const matchingFilterCount = tools.filter(tool => matchesDiscoveryFilters(tool, filters)).length;
    return {
        reason: matchingFilterCount ? 'query_no_match' : 'filters_no_match',
        matchingFilterCount,
        availableFilters: {
            sources: [...new Set(tools.map(tool => tool.source || 'builtin'))].sort(),
            capabilities: [...new Set(tools.flatMap(tool => tool.capabilities || []))].sort(),
            riskLevels: DISCOVERY_RISK_LEVELS.filter(risk => tools.some(tool => discoveryRisk(tool.risk_level ?? tool.risk ?? 'low') === discoveryRisk(risk)))
        },
        message: matchingFilterCount
            ? '当前授权目录中有符合筛选条件的工具，但关键词未命中。请改用工具操作词（如读取、列出、保存）检索；不要只用尚未读取的业务资料名称。'
            : '当前任务有授权工具，但本次筛选条件未匹配。capability 必须是目录中的精确能力标识，不能填写自然语言。请核对下列可用条件；不确定时省略模型自行猜测的筛选，保留用户明确限制。不会自动放宽本次筛选。'
    };
}

module.exports = { DISCOVERY_RISK_LEVELS, emptySearchFeedback, matchesDiscoveryFilters };
