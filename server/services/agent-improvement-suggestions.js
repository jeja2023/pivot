const { query } = require('../db/client');
const { getPrimaryTenantId } = require('./enterprise-access');

async function getAgentImprovementSuggestions(user, options = {}) {
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const failures = await query(`SELECT tool_name, COUNT(*) AS count FROM agent_tool_calls WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?) AND status IN ('error', 'failed', 'denied') GROUP BY tool_name ORDER BY count DESC LIMIT 20`, [cutoff, tenantId]);
    const suggestions = failures.filter(row => Number(row.count || 0) >= 3).map(row => ({ type: 'tool_alternative', tool: row.tool_name, reason: `${row.count} 次失败，建议在只读任务中选择可靠性更高的同类工具或增加输入校验。`, requiresApproval: false }));
    const corrections = await query(`SELECT correction, COUNT(*) AS count FROM agent_feedback WHERE user_id = ? AND created_at >= ? AND correction <> '' GROUP BY correction ORDER BY count DESC LIMIT 10`, [user.id, cutoff]);
    const promptTemplates = corrections.filter(row => Number(row.count || 0) >= 2).map(row => ({ type: 'prompt_template', template: String(row.correction).slice(0, 1000), sampleCount: Number(row.count), status: 'draft', administratorApprovalRequired: true }));
    return { days, tenantId, suggestions, promptTemplates, generatedAt: new Date().toISOString() };
}

module.exports = { getAgentImprovementSuggestions };
