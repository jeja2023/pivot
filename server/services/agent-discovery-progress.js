'use strict';

function recordDiscoverySearch(state, result, run = {}) {
    if (!state) return;
    const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata || {};
    const key = `${result.catalogVersion}:${metadata.capabilityConstraints?.sourceMessageId || ''}:${run.goal || ''}`;
    if (state.searchProgress?.key !== key) state.searchProgress = { key, empty: 0 };
    if (result.candidates.length) return;
    state.searchProgress.empty++;
    const limit = require('../config/env-registry').readTypedEnv('PIVOT_AGENT_EMPTY_SEARCH_LIMIT');
    if (state.searchProgress.empty < limit) return;
    const hasAuthorizedTools = result.totalAuthorizedTools > 0;
    const error = new Error(hasAuthorizedTools
        ? '当前任务已有授权工具，但多次检索未匹配，已停止重复搜索。本次未确认业务工具缺失，请核对关键词和模型选择的来源、风险及能力筛选后继续，无需仅因此重新授权。'
        : '当前任务的授权工具目录中多次未找到所需工具，已停止重复搜索。请检查工具是否已启用并加入本次任务范围，或重新选择工具后继续。');
    error.code = 'TOOL_DISCOVERY_NO_PROGRESS';
    error.category = 'capability';
    error.retryable = false;
    throw error;
}

async function pauseForMissingTool(deps, runId, userId, error) {
    const { getBeijingTimestamp } = require('../time');
    await deps.updateRun(runId, { status: 'needs_input', error_message: error.message, final_answer: error.message,
        updated_at: getBeijingTimestamp(), last_heartbeat_at: getBeijingTimestamp() });
    await deps.createAgentNotification(userId, runId, 'warning', '任务需要可用工具', error.message);
}

module.exports = { recordDiscoverySearch, pauseForMissingTool };
