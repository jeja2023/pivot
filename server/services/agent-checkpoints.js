const { randomUUID, createHash } = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MAX_CHECKPOINT_STATE_LENGTH = 120000;
const CHECKPOINT_TYPES = new Set(['plan', 'tool', 'dag', 'approval', 'control']);

function checkpointInputHash(input) {
    return createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex');
}

function parseCheckpointState(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (e) { return {}; }
}

function serializeCheckpointState(value) {
    try {
        const text = JSON.stringify(value ?? {});
        if (text.length <= MAX_CHECKPOINT_STATE_LENGTH) return text;
        return JSON.stringify({
            truncated: true,
            outputUnavailable: true,
            summary: text.slice(0, Math.min(MAX_CHECKPOINT_STATE_LENGTH, 12000)),
            originalLength: text.length
        });
    } catch (e) {
        return JSON.stringify({ serializationError: true });
    }
}

function recoveryOutputError(message = '检查点完整输出不可用，已拒绝自动重放。') {
    const error = new Error(message);
    error.code = 'AGENT_RECOVERY_OUTPUT_UNAVAILABLE';
    error.category = 'recovery';
    error.status = 409;
    return error;
}

async function resolveCheckpointUser(runId, user = null) {
    if (user?.id) return user;
    const run = await queryOne('SELECT user_id, tenant_id FROM agent_runs WHERE id = ?', [runId]);
    if (!run?.user_id) throw recoveryOutputError('检查点所属任务或用户不存在，已拒绝读取完整输出。');
    return { id: Number(run.user_id), tenant_id: run.tenant_id || null };
}

async function persistCheckpointState(runId, state = {}, user = null) {
    const source = state && typeof state === 'object' ? { ...state } : {};
    if (!Object.hasOwn(source, 'output')) {
        return { state: source, serialized: serializeCheckpointState(source), outputRef: '' };
    }
    const output = source.output === undefined ? null : source.output;
    const serializedOutput = JSON.stringify(output);
    if (serializedOutput.length <= MAX_CHECKPOINT_STATE_LENGTH) {
        return { state: { ...source, output }, serialized: serializeCheckpointState({ ...source, output }), outputRef: '' };
    }
    const owner = await resolveCheckpointUser(runId, user);
    const { persistDagOutput } = require('./agent-dag-output');
    const persisted = await persistDagOutput(output, { user: owner, retentionDays: 30, maxChars: MAX_CHECKPOINT_STATE_LENGTH });
    if (persisted.complete || !persisted.outputRef) {
        throw recoveryOutputError('检查点完整输出无法写入受控产物存储，已拒绝标记本次工具调用完成。');
    }
    const next = {
        ...source,
        output: persisted.value,
        outputRef: persisted.outputRef,
        outputDigest: persisted.outputDigest || '',
        outputBytes: Number(persisted.outputBytes || 0),
        outputComplete: false
    };
    return { state: next, serialized: JSON.stringify(next), outputRef: persisted.outputRef };
}

async function hydrateCheckpointState(state, user = null, { strict = false } = {}) {
    const source = state && typeof state === 'object' ? { ...state } : {};
    const ref = String(source.outputRef || source.output?.outputRef || '').trim();
    const incomplete = source.outputUnavailable === true || (source.truncated === true && !Object.hasOwn(source, 'output'));
    if (!ref) {
        if (incomplete && strict) throw recoveryOutputError();
        return incomplete ? { ...source, outputUnavailable: true } : source;
    }
    try {
        const { resolvePersistedDagOutput } = require('./agent-dag-output');
        const resolved = await resolvePersistedDagOutput(source.output, { user });
        if (!resolved.complete) throw recoveryOutputError();
        return { ...source, output: resolved.value, outputComplete: true };
    } catch (error) {
        if (strict) throw recoveryOutputError(error?.message || undefined);
        return { ...source, outputUnavailable: true, outputRecoveryError: String(error?.message || '').slice(0, 300) };
    }
}

async function retainCheckpointOutput(ref) {
    if (!ref) return;
    const { incrementRefCount } = require('./agent-artifact-cas');
    await incrementRefCount(ref, 1);
}

async function recordAgentCheckpoint(runId, data = {}) {
    if (!runId) return null;
    const type = CHECKPOINT_TYPES.has(String(data.type || '')) ? String(data.type) : 'control';
    try {
        const checkpointId = randomUUID();
        const persisted = await persistCheckpointState(runId, data.state || {}, data.user || null);
        const changes = await execute(`
            INSERT INTO agent_run_checkpoints (
                checkpoint_id, run_id, step_index, checkpoint_type, status, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            checkpointId,
            runId,
            Math.max(Number(data.stepIndex) || 0, 0),
            type,
            String(data.status || 'completed').slice(0, 30),
            persisted.serialized,
            data.createdAt || getBeijingTimestamp()
        ]);
        if (changes > 0 && persisted.outputRef) await retainCheckpointOutput(persisted.outputRef);
        return changes ? checkpointId : null;
    } catch (e) {
        return null;
    }
}

async function beginAgentToolCheckpoint(runId, data = {}) {
    if (!runId || !data.operationKey || !data.toolName) return { created: false, replay: false };
    const operationKey = String(data.operationKey).slice(0, 255);
    const existing = await queryOne('SELECT * FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey]);
    if (existing) {
        const state = parseCheckpointState(existing.state);
        if (existing.input_hash && data.inputHash && String(existing.input_hash) !== String(data.inputHash)) {
            const error = new Error('工具操作键与输入摘要不匹配，已拒绝潜在重放混淆。');
            error.code = 'AGENT_OPERATION_INPUT_MISMATCH';
            error.category = 'policy';
            throw error;
        }
        if (String(existing.status) === 'completed') {
            const owner = await resolveCheckpointUser(existing.run_id || runId, data.user || null);
            const hydrated = await hydrateCheckpointState(state, owner, { strict: true });
            if (!Object.hasOwn(hydrated, 'output')) throw recoveryOutputError();
            return { created: false, replay: true, output: hydrated.output, checkpointId: existing.checkpoint_id };
        }
        if (String(existing.status) === 'uncertain') {
            throw recoveryOutputError('工具调用是否已提交但完整结果不可用，必须人工核对后才能继续。');
        }
        if (String(existing.status) === 'pending' && !data.idempotent && data.approvalGranted !== true) {
            const error = new Error('检测到未完成的非幂等工具调用，必须重新审批后才能继续。');
            error.code = 'AGENT_RECOVERY_REQUIRES_APPROVAL';
            error.category = 'policy';
            error.operationKey = operationKey;
            throw error;
        }
        await execute(`UPDATE agent_run_checkpoints SET status = 'pending', attempt = COALESCE(attempt, 1) + 1, state = ? WHERE operation_key = ?`, [
            serializeCheckpointState({ toolName: data.toolName, input: data.input || {}, inputHash: data.inputHash || checkpointInputHash(data.input), recovery: true, approvalGranted: data.approvalGranted === true }), operationKey
        ]);
        return { created: false, replay: false, checkpointId: existing.checkpoint_id, recovered: true };
    }
    const checkpointId = randomUUID();
    await execute(`
        INSERT INTO agent_run_checkpoints (
            checkpoint_id, run_id, step_index, checkpoint_type, status, state, created_at,
            operation_key, tool_name, input_hash, idempotent, attempt
        ) VALUES (?, ?, ?, 'tool', 'pending', ?, ?, ?, ?, ?, ?, 1)
    `, [
        checkpointId, runId, Math.max(Number(data.stepIndex) || 0, 0),
        serializeCheckpointState({ toolName: data.toolName, input: data.input || {}, inputHash: data.inputHash || checkpointInputHash(data.input) }),
        data.createdAt || getBeijingTimestamp(), operationKey, String(data.toolName).slice(0, 128), data.inputHash || checkpointInputHash(data.input), Boolean(data.idempotent)
    ]);
    return { created: true, replay: false, checkpointId };
}

async function completeAgentToolCheckpoint(operationKey, output, options = {}) {
    if (!operationKey) return false;
    const row = await queryOne('SELECT run_id, state FROM agent_run_checkpoints WHERE operation_key = ?', [String(operationKey)]);
    const current = parseCheckpointState(row?.state);
    let persisted;
    try {
        persisted = await persistCheckpointState(row?.run_id || '', {
            ...current,
            output: output === undefined ? null : output,
            committed: true,
            committedAt: getBeijingTimestamp()
        }, options.user || null);
    } catch (error) {
        const uncertain = {
            ...current,
            committed: true,
            outputUnavailable: true,
            outputStorageError: String(error?.message || '完整输出持久化失败').slice(0, 300),
            committedAt: getBeijingTimestamp()
        };
        await execute(`
            UPDATE agent_run_checkpoints
            SET status = 'uncertain', state = ?, committed_at = ?, created_at = COALESCE(created_at, ?)
            WHERE operation_key = ? AND status = 'pending'
        `, [serializeCheckpointState(uncertain), options.committedAt || getBeijingTimestamp(), options.createdAt || getBeijingTimestamp(), String(operationKey)]);
        throw recoveryOutputError('工具已返回但完整结果无法安全持久化，任务已停止自动恢复。');
    }
    const changed = await execute(`
        UPDATE agent_run_checkpoints
        SET status = 'completed', state = ?, committed_at = ?, created_at = COALESCE(created_at, ?)
        WHERE operation_key = ? AND status = 'pending'
    `, [persisted.serialized, options.committedAt || getBeijingTimestamp(), options.createdAt || getBeijingTimestamp(), String(operationKey)]);
    if (changed > 0 && persisted.outputRef) await retainCheckpointOutput(persisted.outputRef);
    return changed > 0;
}

async function failAgentToolCheckpoint(operationKey, error, options = {}) {
    if (!operationKey) return false;
    const row = await queryOne('SELECT state FROM agent_run_checkpoints WHERE operation_key = ?', [String(operationKey)]);
    const current = parseCheckpointState(row?.state);
    const next = {
        ...current,
        errorMessage: String(error?.message || error || '工具执行失败').slice(0, 2000),
        errorCode: String(error?.code || '').slice(0, 80),
        committed: false,
        failedAt: getBeijingTimestamp()
    };
    const changed = await execute(`
        UPDATE agent_run_checkpoints
        SET status = 'error', state = ?, created_at = COALESCE(created_at, ?)
        WHERE operation_key = ? AND status = 'pending'
    `, [serializeCheckpointState(next), options.createdAt || getBeijingTimestamp(), String(operationKey)]);
    return changed > 0;
}

async function listAgentCheckpoints(runId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const rows = await query(`
        SELECT checkpoint_id, run_id, step_index, checkpoint_type, status, state, created_at
        FROM agent_run_checkpoints
        WHERE run_id = ?
        ORDER BY step_index DESC, id DESC
        LIMIT ?
    `, [runId, limit]);
    return await Promise.all(rows.map(async row => {
        const state = parseCheckpointState(row.state);
        const hydrated = options.hydrateOutput === true && options.user
            ? await hydrateCheckpointState(state, options.user)
            : state;
        return { ...row, state: hydrated };
    }));
}

async function listAgentCheckpointsForUser(runId, user, options = {}) {
    const run = await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [runId, user.id]);
    return run ? await listAgentCheckpoints(runId, { ...options, user, hydrateOutput: true }) : null;
}

async function getLatestAgentCheckpoint(runId) {
    const list = await listAgentCheckpoints(runId, { limit: 1 });
    return list[0] || null;
}

async function buildAgentResumeContext(runId) {
    const user = await resolveCheckpointUser(runId);
    const allCheckpoints = (await listAgentCheckpoints(runId, { limit: 80, user, hydrateOutput: true })).reverse();
    const checkpoints = allCheckpoints.filter(item => ['completed', 'success'].includes(String(item.status || '')));
    const observations = checkpoints
        .filter(item => ['tool', 'dag'].includes(item.checkpoint_type))
        .map(item => ({
            step: item.step_index,
            tool: item.state.toolName || '',
            node: item.state.nodeId || '',
            input: item.state.input || {},
            output: item.state.output,
            resumedFromCheckpointId: item.checkpoint_id
        }))
        .slice(-20);
    const recentFailures = allCheckpoints
        .filter(item => item.status === 'error')
        .map(item => ({
            step: item.step_index,
            tool: item.state.toolName || '',
            node: item.state.nodeId || '',
            error: item.state.errorMessage || item.state.output?.error || '执行失败'
        }))
        .slice(-5);
    const latest = checkpoints[checkpoints.length - 1] || null;
    return {
        sourceRunId: runId,
        latestCheckpointId: latest?.checkpoint_id || '',
        latestStepIndex: Number(latest?.step_index || 0),
        checkpointCount: checkpoints.length,
        observations,
        recentFailures
    };
}

async function summarizeAgentCheckpoints(runId) {
    const row = (await queryOne(`
        SELECT COUNT(*) AS total,
               MAX(step_index) AS latest_step,
               MAX(created_at) AS latest_at,
               SUM(CASE WHEN checkpoint_type = 'tool' THEN 1 ELSE 0 END) AS tool_count,
               SUM(CASE WHEN checkpoint_type = 'dag' THEN 1 ELSE 0 END) AS dag_count
        FROM agent_run_checkpoints WHERE run_id = ?
    `, [runId])) || {};
    return {
        total: Number(row.total || 0),
        latestStep: Number(row.latest_step || 0),
        latestAt: row.latest_at || '',
        toolCount: Number(row.tool_count || 0),
        dagCount: Number(row.dag_count || 0)
    };
}

module.exports = {
    buildAgentResumeContext,
    beginAgentToolCheckpoint,
    checkpointInputHash,
    completeAgentToolCheckpoint,
    failAgentToolCheckpoint,
    getLatestAgentCheckpoint,
    listAgentCheckpoints,
    listAgentCheckpointsForUser,
    parseCheckpointState,
    recordAgentCheckpoint,
    serializeCheckpointState,
    summarizeAgentCheckpoints
};
