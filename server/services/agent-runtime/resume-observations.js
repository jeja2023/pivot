'use strict';

async function resolveResumeObservations(run, metadata, buildResumeContext) {
    const stored = metadata.resumeContext && typeof metadata.resumeContext === 'object' ? metadata.resumeContext : {};
    if (!run.started_at || run.run_mode === 'dag') return stored;
    // 崩溃后的安全回队没有经过错误重试处理器，同一Run仍须读取已持久化的真实工具观察。
    const current = await buildResumeContext(run.id);
    if (!current?.checkpointCount || Number(current.latestStepIndex || 0) < Number(stored.latestStepIndex || 0)) return stored;
    return { ...stored, ...current };
}

module.exports = { resolveResumeObservations };
