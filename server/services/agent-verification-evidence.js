'use strict';

const { createHash } = require('node:crypto');
const { canonicalJson } = require('./canonical-json');
const { parseJsonObject } = require('./agent-validators');
const runs = require('../repositories/agent-runs');
const MAX_RECORDS = 2000;

function incomplete(message, code = 'VERIFICATION_EVIDENCE_INCOMPLETE') {
    return Object.assign(new Error(message), { code, category: 'policy' });
}

function observationKey(item) {
    if (item.messageId) return `control:${item.messageId}`;
    return createHash('sha256').update(canonicalJson({ tool: item.tool || '', input: item.input || {}, output: item.output ?? null, error: item.error || '' })).digest('hex');
}

// 规划窗口可以缩减；最终验收必须补回持久工具结果和已经应用的控制回执。
async function loadVerificationEvidence(runId, user, observations = [], deps = {}) {
    const visited = new Set(), ancestry = new Set();
    const persisted = [];
    async function loadRunEvidence(id) {
        if (ancestry.has(id)) throw incomplete('核验续跑记录存在循环。');
        if (visited.has(id)) return;
        if (visited.size >= 128) throw incomplete('核验续跑记录超过读取范围。');
        visited.add(id); ancestry.add(id);
        const run = await (deps.run || runs.getRunForUser)(id, user.id);
        if (!run || run.deleted_at) throw incomplete('核验任务不存在或无权访问。');
        await (deps.assertAccess || require('./knowledge-run-access').assertRunKnowledgeAccess)(id, user);
        const metadata = parseJsonObject(run.metadata) || {};
        const sourceRunIds = new Set();
        const resumedFrom = metadata.resumeContext?.sourceRunId;
        if (resumedFrom && resumedFrom !== id) sourceRunIds.add(resumedFrom);
        const continuation = metadata.goalContinuation;
        if (continuation) {
            if (metadata.goalKind !== 'goal' || continuation.goalId !== metadata.goalId || Number(continuation.goalVersion) !== Number(metadata.goalVersion)
                || !continuation.sourceRunId || continuation.sourceRunId === id) throw incomplete('持续目标的核验接续关系无效。');
            const previous = await (deps.goalRun || require('../repositories/agent-goal-context').readGoalContextRun)(continuation.sourceRunId, user.id, continuation.goalId, continuation.goalVersion);
            if (!previous) throw incomplete('持续目标前次核验证据不存在或版本不一致。');
            sourceRunIds.add(continuation.sourceRunId);
        }
        for (const sourceRunId of sourceRunIds) await loadRunEvidence(sourceRunId);
        const startIndex = persisted.length;
        const steps = await (deps.steps || runs.listSteps)(id);
        for (const step of steps) {
            if (step.type !== 'tool') continue;
            persisted.push({ evidenceId: `step:${step.id}`, sourceRunId: id, step: step.step_index, tool: step.tool_name,
                input: step.input, output: step.output, status: step.status, observedAt: step.created_at,
                ...(step.error_message ? { error: step.error_message } : {}),
                ...(step.knowledge_evidence ? { knowledgeEvidence: step.knowledge_evidence } : {}) });
        }
        if (run.run_mode === 'dag') {
            const nodes = await (deps.nodes || runs.listDagNodes)(id);
            for (const node of nodes) {
                if (!node.tool_name || ['pending', 'ready', 'running'].includes(node.status)) continue;
                persisted.push({ evidenceId: `node:${node.id}`, sourceRunId: id, node: node.node_key, tool: node.tool_name,
                    input: node.input, output: node.output, status: node.status, observedAt: node.completed_at || node.created_at,
                    ...(node.error_message ? { error: node.error_message } : {}),
                    ...(node.knowledge_evidence ? { knowledgeEvidence: node.knowledge_evidence } : {}) });
            }
        }
        const checkpoints = await (deps.checkpoints || require('../repositories/agent-verification-records').listVerificationCheckpoints)(id, user.id);
        if (checkpoints.length > MAX_RECORDS) throw incomplete('核验检查点超过本次读取容量。', 'VERIFICATION_CONTEXT_LIMIT');
        const stepKeys = new Map();
        for (const item of persisted.slice(startIndex)) { const key = observationKey(item); stepKeys.set(key, (stepKeys.get(key) || 0) + 1); }
        for (const checkpoint of checkpoints) {
            const state = await (deps.hydrate || require('./agent-checkpoints').hydrateCheckpointState)(parseJsonObject(checkpoint.state) || {}, user, { strict: true });
            if (['completed', 'success'].includes(checkpoint.status) && !Object.hasOwn(state, 'output')) throw incomplete('已完成检查点缺少完整输出，无法核验。');
            const record = { evidenceId: `checkpoint:${checkpoint.checkpoint_id}`, operationKey: checkpoint.operation_key,
                sourceRunId: id, step: checkpoint.step_index, tool: state.toolName || '', input: state.input || {},
                output: state.output, status: checkpoint.status, observedAt: checkpoint.created_at,
                ...(!['completed', 'success'].includes(checkpoint.status) ? { error: state.errorMessage || '该操作尚未确认完成，不能视为成功。' } : {}) };
            const key = observationKey(record), duplicateCount = stepKeys.get(key) || 0;
            if (duplicateCount) { stepKeys.set(key, duplicateCount - 1); continue; }
            // 检查点可能早于界面步骤落库；图像仍经统一校验，不把 Base64 文本当作视觉证据。
            record.output = await require('./agent-tool-vision').prepareToolVision(record.output, user, deps.vision);
            persisted.push(record);
        }
        const controls = await (deps.controls || require('../repositories/agent-verification-records').listVerificationControls)(id, user.id);
        for (const row of controls) persisted.push({ type: 'agent_control', sourceRunId: id, messageId: row.message_id,
            messageType: row.message_type, observedAt: row.applied_at, fromRunId: row.from_run_id || '', payload: parseJsonObject(row.payload) || {} });
        const current = persisted.splice(startIndex);
        current.sort((left, right) => new Date(left.observedAt || 0).getTime() - new Date(right.observedAt || 0).getTime());
        persisted.push(...current);
        if (persisted.length > MAX_RECORDS) throw incomplete('核验执行记录超过本次读取容量。', 'VERIFICATION_CONTEXT_LIMIT');
        ancestry.delete(id);
    }
    await loadRunEvidence(runId);
    // 按出现次数消除持久记录与内存窗口的重叠，同内容的两次真实操作仍保留两次。
    const counts = new Map();
    for (const item of persisted) { const key = observationKey(item); counts.set(key, (counts.get(key) || 0) + 1); }
    for (const item of observations) {
        const key = observationKey(item), count = counts.get(key) || 0;
        if (count) counts.set(key, count - 1);
        else persisted.push(item);
    }
    if (persisted.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(persisted), 'utf8') > 32 * 1024 * 1024) {
        throw incomplete('核验执行记录超过本次读取容量。', 'VERIFICATION_CONTEXT_LIMIT');
    }
    return persisted;
}

module.exports = { loadVerificationEvidence };
