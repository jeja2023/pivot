'use strict';

const { parseJsonObject } = require('./agent-validators');

function leanRun(run) {
    const metadata = parseJsonObject(run.metadata) || {};
    const { chatHistory: _history, parentHistory: _parent, ragContext: _rag, ...light } = metadata;
    if (light.chatBridge) light.chatBridge = { source: light.chatBridge.source, executionProfile: light.chatBridge.executionProfile,
        memoryUsageReasons: light.chatBridge.memoryUsageReasons, sessionId: light.chatBridge.sessionId, messageId: light.chatBridge.messageId };
    if (light.projectContextPack) light.projectContextPack = { collections: light.projectContextPack.collections, projectId: light.projectContextPack.projectId, ...(light.projectContextPack.project?{project:{id:light.projectContextPack.project.id,title:light.projectContextPack.project.title,version:light.projectContextPack.project.version}}:{}) };
    return { ...run, metadata: light };
}

async function getRunOverview(run, user, deps = {}) {
    const result = await require('./agent-run-detail-parts').withDetailDeadline(() => (deps.read || require('../repositories/agent-run-overview').readRunOverviewRows)(run.id), 6000);
    const metadata = parseJsonObject(run.metadata) || {};
    const transactions = run.status === 'awaiting_commit' ? await require('./agent-run-detail-parts').withDetailDeadline(() =>
        (deps.transactions || require('./agent-task-transactions').listTaskTransactionsForRun)(run.id, user, { limit: 1 }), 6000) : [];
    return { run: leanRun(run), ...result, invocations: [], iterationItems: [], trace: null, checkpoints: null, verification: metadata.taskVerification || null,
        evidence: [], transactions, workingMemoryRevisions: [], promptInvocations: [], browserActionEvidence: [], browserSessions: [],
        progress: require('./agent-round-progress').buildRunProgress(run, result.steps),
        detailLevel: 'overview', diagnosticsDeferred: true,
        taskContract: metadata.taskContract || null,
        warnings: [{ code: 'DIAGNOSTICS_DEFERRED', message: '已加载任务与最近执行记录；完整日志及诊断可按需加载。' }] };
}

module.exports = { getRunOverview };
