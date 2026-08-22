const { clampText, executeBuiltInTool } = require('./agent-tools');
const { executeMcpTool } = require('./mcp-client');
const { estimateTokens } = require('../llm');
const { getModelContextBudget } = require('./context-budget');
const { defaultToolOrchestrator } = require('./agent-tool-orchestrator');
const { buildToolExecutionPlan } = require('./agent-tool-execution-plan');

const MAX_TOOL_CONTEXT_TOKENS = Math.max(4000, Math.min(
    Number.parseInt(process.env.AGENT_TOOL_CONTEXT_MAX_TOKENS || '120000', 10) || 120000,
    500000
));

function truncateTextByTokens(value, maxTokens) {
    const source = String(value || '');
    if (estimateTokens(source) <= maxTokens) return source;
    const suffix = '\n...[内容过长，已按模型上下文预算截断]';
    let low = 0;
    let high = source.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(source.slice(0, mid) + suffix) <= maxTokens) low = mid;
        else high = mid - 1;
    }
    return source.slice(0, low).trimEnd() + suffix;
}

function compactToolOutputForModel(value, modelCfg = {}, options = {}) {
    const budget = getModelContextBudget(modelCfg, { maxOutputTokens: options.maxOutputTokens });
    const configured = Number.parseInt(options.maxTokens, 10);
    const targetTokens = Number.isFinite(configured) && configured > 0
        ? Math.min(configured, MAX_TOOL_CONTEXT_TOKENS)
        : Math.min(
            budget.unbounded ? 24000 : Math.max(2000, Math.floor(budget.inputBudget * 0.45)),
            24000
        );
    const structured = value?.structuredContent && typeof value.structuredContent === 'object'
        ? value.structuredContent
        : null;
    const rows = Array.isArray(structured?.rows)
        ? structured.rows
        : Array.isArray(structured?.data)
            ? structured.data
            : Array.isArray(structured?.items)
                ? structured.items
                : null;
    if (rows) {
        const keptRows = [];
        let usedTokens = 180;
        let oversizedRows = 0;
        for (const row of rows) {
            const rowTokens = estimateTokens(JSON.stringify(row));
            if (rowTokens + 180 > targetTokens) {
                oversizedRows += 1;
                continue;
            }
            if (usedTokens + rowTokens > targetTokens) break;
            keptRows.push(row);
            usedTokens += rowTokens;
        }
        const partial = keptRows.length < rows.length;
        const compactStructured = {
            ...structured,
            rows: keptRows,
            __partial: partial,
            originalRowCount: rows.length,
            modelRowCount: keptRows.length,
            oversizedRowCount: oversizedRows,
            contextTokenBudget: targetTokens
        };
        delete compactStructured.data;
        delete compactStructured.items;
        return {
            structuredContent: compactStructured,
            text: partial
                ? `查询返回 ${rows.length} 条记录，本次按模型上下文预算传入 ${keptRows.length} 条完整记录${oversizedRows ? `，其中 ${oversizedRows} 条单条内容超过预算` : ''}。`
                : `查询返回 ${rows.length} 条记录，已全部传入模型。`
        };
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text || estimateTokens(text) <= targetTokens) return value;
    return {
        __partial: true,
        originalChars: text.length,
        contextTokenBudget: targetTokens,
        text: truncateTextByTokens(text, targetTokens)
    };
}

function findDatabaseCompatTool(fullName, toolList = []) {
    const match = String(fullName || '').match(/^mcp\.(\d+)\.(db\..+)$/);
    if (!match) return null;
    const serverId = match[1];
    const shortName = match[2];
    return (toolList || []).find(tool => {
        if (!tool?.databaseTool || tool.name !== shortName) return false;
        const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
        return connections.some(connection => (
            String(connection.serverId ?? '') === serverId
            && String(connection.fullName || '') === String(fullName || '')
        ));
    }) || null;
}

function findAgentToolByName(name, toolList = []) {
    const safeName = String(name || '').trim();
    return (toolList || []).find(item => item.name === safeName) || findDatabaseCompatTool(safeName, toolList);
}

async function executeToolByName(name, input, user, toolList = [], context = {}) {
    const safeName = String(name || '').trim();
    const tool = findAgentToolByName(safeName, toolList);
    if (!tool) {
        const err = new Error(`工具不可用或无权访问：${safeName || '-'}`);
        err.status = 403;
        throw err;
    }
    const policyRun = {
        ...(context.run || { tool_policy: 'all', approval_policy: 'approve_all_mcp' })
    };
    if (context.modelCfg?.id) policyRun.chosen_model_id = context.modelCfg.id;
    const executionPlan = await buildToolExecutionPlan({ run: policyRun, tool, input, user, context });
    return defaultToolOrchestrator.execute({
        run: policyRun,
        tool,
        input,
        user,
        context,
        executionPlan,
        execute: async ({ input: effectiveInput }) => {
            if (context.autonomous === true && ['agent.code', 'workflow.foreach'].includes(safeName)) {
                const error = new Error('自主 Agent 禁止在服务端进程内执行动态代码；请使用桌面 Worker 沙箱。');
                error.code = 'AGENT_SANDBOX_REQUIRED';
                error.category = 'policy';
                throw error;
            }
            if (safeName.startsWith('mcp.')) {
                return await executeMcpTool(safeName, effectiveInput, user, { source: context.source || 'agent', signal: context.signal || null });
            }
            if (tool.databaseTool && safeName.startsWith('db.')) {
                const rawConnectionId = effectiveInput?.connectionId ?? effectiveInput?.connection_id ?? effectiveInput?.databaseConnectionId ?? effectiveInput?.database_connection_id ?? effectiveInput?.mcpServerId ?? effectiveInput?.mcp_server_id;
                const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
                const selectedConnectionId = String(rawConnectionId ?? '').trim()
                    || (connections.length === 1 ? String(connections[0].connectionId ?? connections[0].serverId ?? '') : '');
                const connection = connections.find(item => (
                    String(item.connectionId ?? item.serverId ?? '') === selectedConnectionId
                    || String(item.serverId ?? '') === selectedConnectionId
                ));
                if (!connection?.fullName) {
                    const err = new Error('请为这个数据库工具选择一个可用的数据连接。');
                    err.status = 400;
                    throw err;
                }
                const toolInput = effectiveInput && typeof effectiveInput === 'object' && !Array.isArray(effectiveInput) ? { ...effectiveInput } : {};
                delete toolInput.connectionId;
                delete toolInput.connection_id;
                delete toolInput.databaseConnectionId;
                delete toolInput.database_connection_id;
                delete toolInput.mcpServerId;
                delete toolInput.mcp_server_id;
                return await executeMcpTool(connection.fullName, toolInput, user, { source: context.source || 'agent', signal: context.signal || null });
            }
            return await executeBuiltInTool(safeName, effectiveInput, user, context);
        }
    });
}

module.exports = {
    clampText,
    compactToolOutputForModel,
    executeToolByName,
    findAgentToolByName,
    findDatabaseCompatTool
};
