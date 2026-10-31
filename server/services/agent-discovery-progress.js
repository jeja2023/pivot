'use strict';

function recordDiscoverySearch(state, result, run = {}) {
    if (!state) return;
    const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata || {};
    const key = `${result.catalogVersion}:${metadata.capabilityConstraints?.sourceMessageId || ''}:${run.goal || ''}`;
    if (state.searchProgress?.key !== key) state.searchProgress = { key, empty: 0 };
    if (result.candidates.length) return;
    state.searchProgress.empty++;
    if (state.searchProgress.empty < 4) return;
    const error = new Error('当前任务的授权工具目录中多次未找到所需工具，已停止重复搜索。请检查工具是否已启用并加入本次任务范围，或重新选择工具后继续。');
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
