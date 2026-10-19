'use strict';

/*
 * 持久化 Task Transaction 控制面。
 *
 * 该服务只负责记录和推进事务状态，绝不在数据库事务内直接运行外部副作用。
 * 实际执行器应先将 effect 标为 executing/staged；Verifier 独立判定后，才允许
 * commit。发生失败时将 effect 编入 compensation 队列，避免“模型回答完成”被
 * 误判为真实提交。
 */
const crypto = require('crypto');
const { transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const {
    assertCommitReady,
    assertTransactionTransition,
    createTaskTransactionDraft,
    normalizeEffectPlan,
    transactionError
} = require('./agent-task-transaction');
const {
    acquireTaskResourceLeases,
    recordTaskResourceConflict,
    releaseTaskResourceLeases,
    renewTaskResourceLeases,
    serializeLease,
    serializeResourceConflict
} = require('./agent-task-resource-leases');

function text(value, max = 255) { return String(value ?? '').trim().slice(0, max); }

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function jsonObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function transactionNotFound() {
    return transactionError('任务事务不存在或无权访问。', 'AGENT_TASK_TRANSACTION_NOT_FOUND', 404);
}

function normalizeEffectRow(row = {}) {
    return {
        id: String(row.id || ''),
        transactionId: String(row.transaction_id || ''),
        runId: String(row.run_id || ''),
        effectType: String(row.effect_type || ''),
        resourceKeys: Array.isArray(parseJson(row.resource_keys, [])) ? parseJson(row.resource_keys, []) : [],
        idempotencyKey: String(row.idempotency_key || ''),
        commitMode: String(row.commit_mode || 'after_verify'),
        compensation: jsonObject(parseJson(row.compensation, {})),
        status: String(row.status || 'planned'),
        request: jsonObject(parseJson(row.request, {})),
        result: jsonObject(parseJson(row.result, {})),
        errorInfo: jsonObject(parseJson(row.error_info, {})),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        committedAt: row.committed_at || null
    };
}

function normalizeCompensationRow(row = {}) {
    return {
        id: String(row.id || ''),
        transactionId: String(row.transaction_id || ''),
        effectId: String(row.effect_id || ''),
        status: String(row.status || 'pending'),
        plan: jsonObject(parseJson(row.plan, {})),
        result: jsonObject(parseJson(row.result, {})),
        errorInfo: jsonObject(parseJson(row.error_info, {})),
        attemptCount: Number(row.attempt_count || 0),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        completedAt: row.completed_at || null
    };
}

function normalizeTransactionRow(row = {}, effects = [], compensations = [], resourceLeases = [], resourceConflicts = []) {
    return {
        id: String(row.id || ''),
        runId: String(row.run_id || ''),
        userId: Number(row.user_id || 0),
        tenantId: Number(row.tenant_id || 0),
        status: String(row.status || 'draft'),
        taskContract: jsonObject(parseJson(row.task_contract, {})),
        verification: jsonObject(parseJson(row.verification, {})),
        workspaceSnapshot: jsonObject(parseJson(row.workspace_snapshot, {})),
        commitEvidence: jsonObject(parseJson(row.commit_evidence, {})),
        failureReason: String(row.failure_reason || ''),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        verifiedAt: row.verified_at || null,
        committedAt: row.committed_at || null,
        rolledBackAt: row.rolled_back_at || null,
        effects: effects.map(normalizeEffectRow),
        compensations: compensations.map(normalizeCompensationRow),
        resourceLeases: resourceLeases.map(serializeLease),
        resourceConflicts: resourceConflicts.map(serializeResourceConflict)
    };
}

function effectStatusTransition(current, target) {
    const allowed = {
        planned: new Set(['staged', 'executing', 'cancelled']),
        staged: new Set(['executing', 'committed', 'cancelled', 'compensation_pending']),
        executing: new Set(['staged', 'committed', 'compensation_pending', 'failed']),
        committed: new Set(['compensation_pending']),
        compensation_pending: new Set(['compensated', 'failed']),
        compensated: new Set(), failed: new Set(), cancelled: new Set()
    };
    if (!allowed[String(current || '')]?.has(String(target || ''))) {
        throw transactionError(`副作用状态不能从 ${current || '-'} 转换为 ${target || '-'}。`, 'AGENT_TASK_EFFECT_TRANSITION_INVALID', 409);
    }
}

function assertRollbackEffectsSafe(current, { finalizing = false } = {}) {
    const effects = Array.isArray(current?.effects) ? current.effects : [];
    const compensations = Array.isArray(current?.compensations) ? current.compensations : [];
    if (effects.some(effect => effect.status === 'executing' && effect.commitMode !== 'preview')) {
        throw transactionError('外部副作用正在执行，不能并发回滚；请等待结果并核对后重试。', 'AGENT_TASK_EFFECT_IN_FLIGHT', 409);
    }
    if (effects.some(effect => effect.status === 'failed' && effect.commitMode !== 'preview'
        && !(finalizing && compensations.some(item => item.effectId === effect.id && ['failed', 'manual_required'].includes(item.status))))) {
        throw transactionError('外部副作用的执行结果可能不确定，必须先人工核对，不能直接回滚。', 'AGENT_TASK_EFFECT_OUTCOME_UNCERTAIN', 409);
    }
    if (effects.some(effect => effect.status === 'committed' && effect.commitMode !== 'preview'
        && (finalizing || !effect.compensation?.required || effect.compensation?.mode === 'none'))) {
        throw transactionError('已有不可补偿或尚未补偿的外部副作用，不能标记为已回滚。', 'AGENT_TASK_EFFECT_IRREVERSIBLE', 409);
    }
}

function createTaskTransactionStore(deps = {}) {
    const runTransaction = deps.transaction || transaction;
    const now = deps.now || (() => getBeijingTimestamp());
    const acquireLeases = deps.acquireTaskResourceLeases || acquireTaskResourceLeases;
    const renewLeases = deps.renewTaskResourceLeases || renewTaskResourceLeases;
    const releaseLeases = deps.releaseTaskResourceLeases || releaseTaskResourceLeases;
    const recordConflict = deps.recordTaskResourceConflict || recordTaskResourceConflict;

    async function loadTransaction(trx, id, userId = null, lock = false) {
        const owner = Number.isSafeInteger(Number(userId)) && Number(userId) > 0 ? ' AND user_id = ?' : '';
        const params = owner ? [id, Number(userId)] : [id];
        const row = await trx.queryOne(`SELECT * FROM agent_task_transactions WHERE id = ?${owner}${lock ? ' FOR UPDATE' : ''}`, params);
        if (!row) return null;
        const effects = await trx.query('SELECT * FROM agent_task_effects WHERE transaction_id = ? ORDER BY created_at ASC', [id]);
        const compensations = await trx.query('SELECT * FROM agent_compensations WHERE transaction_id = ? ORDER BY created_at ASC', [id]);
        const resourceLeases = await trx.query('SELECT * FROM agent_task_resource_leases WHERE transaction_id = ? ORDER BY resource_key ASC', [id]);
        const resourceConflicts = await trx.query(`
            SELECT * FROM agent_task_resource_conflicts
            WHERE requester_transaction_id = ? OR holder_transaction_id = ?
            ORDER BY created_at DESC LIMIT 100
        `, [id, id]);
        return normalizeTransactionRow(row, effects, compensations, resourceLeases, resourceConflicts);
    }

    async function assertTaskRunAvailable(trx, current, { requireAwaitingCommit = false } = {}) {
        const run = await trx.queryOne('SELECT status, deleted_at FROM agent_runs WHERE id = ? AND user_id = ? FOR UPDATE', [current.runId, current.userId]);
        if (!run || run.deleted_at || (requireAwaitingCommit && run.status !== 'awaiting_commit')) {
            throw transactionError('任务已隐藏、停止或不在等待提交状态，不能执行事务副作用。', 'AGENT_TASK_RUN_NOT_COMMITTABLE', 409);
        }
    }

    async function createTaskTransaction({ run = {}, user = {}, taskContract = null, workspaceSnapshot = {}, effects = [] } = {}) {
        const draft = createTaskTransactionDraft({
            runId: run.id,
            userId: user.id ?? run.user_id,
            tenantId: run.tenant_id ?? user.tenant_id ?? user.tenantId ?? 0,
            goal: run.goal || '', taskContract, workspaceSnapshot, effects
        });
        return await runTransaction(async trx => {
            const runRow = await trx.queryOne('SELECT id, user_id FROM agent_runs WHERE id = ? AND user_id = ? FOR UPDATE', [draft.runId, draft.userId]);
            if (!runRow) throw transactionNotFound();
            const timestamp = now();
            await trx.execute(`
                INSERT INTO agent_task_transactions (
                    id, run_id, user_id, tenant_id, status, task_contract, workspace_snapshot,
                    verification, commit_evidence, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'draft', ?::jsonb, ?::jsonb, '{}'::jsonb, '{}'::jsonb, ?, ?)
            `, [draft.id, draft.runId, draft.userId, draft.tenantId, JSON.stringify(draft.taskContract), JSON.stringify(draft.workspaceSnapshot), timestamp, timestamp]);
            for (const plan of draft.effects) {
                await trx.execute(`
                    INSERT INTO agent_task_effects (
                        id, transaction_id, run_id, tenant_id, effect_type, resource_keys, idempotency_key,
                        commit_mode, compensation, status, request, result, error_info, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, 'planned', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ?, ?)
                `, [crypto.randomUUID(), draft.id, draft.runId, draft.tenantId, plan.effectType, JSON.stringify(plan.resourceKeys), plan.idempotencyKey, plan.commitMode, JSON.stringify(plan.compensation), timestamp, timestamp]);
            }
            assertTransactionTransition('draft', 'planned');
            await trx.execute("UPDATE agent_task_transactions SET status = 'planned', updated_at = ? WHERE id = ?", [timestamp, draft.id]);
            return await loadTransaction(trx, draft.id, draft.userId, false);
        });
    }

    async function getTaskTransactionForUser(id, user) {
        if (!id || !user?.id) return null;
        return await runTransaction(async trx => await loadTransaction(trx, String(id), user.id, false));
    }

    async function listTaskTransactionsForRun(runId, user, { limit = 20 } = {}) {
        if (!runId || !user?.id) return null;
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        return await runTransaction(async trx => {
            const owned = await trx.queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [runId, user.id]);
            if (!owned) return null;
            const rows = await trx.query('SELECT id FROM agent_task_transactions WHERE run_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', [runId, user.id, safeLimit]);
            return await Promise.all(rows.map(row => loadTransaction(trx, row.id, user.id, false)));
        });
    }

    async function resumeTaskTransactionAfterInput(transactionId, user, taskContract) {
        return runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            if (['planned','executing'].includes(current.status)) return current;
            if (current.status !== 'needs_input' || current.effects.some(effect => !['cancelled','compensated'].includes(effect.status))) {
                throw transactionError('任务仍有待核对的外部动作或工作区预览，请先在事务详情完成处理，再继续。', 'AGENT_TASK_RESUME_EFFECT_REVIEW_REQUIRED', 409);
            }
            await assertTaskRunAvailable(trx, current);
            const contract = require('./agent-verification').normalizeTaskContract(taskContract, current.taskContract?.goal || '');
            // 此专用入口只恢复没有未决副作用的等待输入事务，不放开通用状态 API。
            const snapshot = { ...current.workspaceSnapshot, inputResume: { at: now(), priorVerification: current.verification, contractRevision: contract.revision } };
            await trx.execute("UPDATE agent_task_transactions SET status = 'executing', task_contract = ?::jsonb, verification = '{}'::jsonb, workspace_snapshot = ?::jsonb, failure_reason = '', updated_at = ? WHERE id = ? AND status = 'needs_input'", [JSON.stringify(contract), JSON.stringify(snapshot), now(), current.id]);
            return loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function transitionTaskTransaction(id, user, targetStatus, { failureReason = '', commitEvidence = null } = {}) {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(id), user?.id, true);
            if (!current) throw transactionNotFound();
            const target = assertTransactionTransition(current.status, targetStatus);
            if (['committed', 'compensating', 'rolled_back'].includes(target)) {
                throw transactionError('提交和回滚必须通过专用事务操作，不能直接修改状态。', 'AGENT_TASK_TRANSACTION_CONTROLLED_TRANSITION_REQUIRED', 409);
            }
            if (['cancelled', 'rolled_back', 'partial', 'needs_input', 'failed'].includes(target)) assertRollbackEffectsSafe(current);
            const timestamp = now();
            const fields = ['status = ?', 'updated_at = ?'];
            const params = [target, timestamp];
            if (failureReason) { fields.push('failure_reason = ?'); params.push(text(failureReason, 4000)); }
            if (commitEvidence && typeof commitEvidence === 'object') { fields.push('commit_evidence = ?::jsonb'); params.push(JSON.stringify(commitEvidence)); }
            if (target === 'committed') { fields.push('committed_at = ?'); params.push(timestamp); }
            if (target === 'rolled_back') { fields.push('rolled_back_at = ?'); params.push(timestamp); }
            await trx.execute(`UPDATE agent_task_transactions SET ${fields.join(', ')} WHERE id = ?`, [...params, current.id]);
            if (['committed', 'rolled_back', 'partial', 'needs_input', 'failed', 'cancelled'].includes(target)) {
                await releaseLeases(trx, current.id, { now: timestamp });
            }
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function stageTaskEffect(transactionId, user, planInput = {}, request = {}) {
        const plan = normalizeEffectPlan(planInput);
        try { return await runTransaction(async trx => {
            const transactionRow = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!transactionRow) throw transactionNotFound();
            await assertTaskRunAvailable(trx, transactionRow);
            if (!['planned', 'executing'].includes(transactionRow.status)) {
                throw transactionError('当前任务事务不能增加副作用计划。', 'AGENT_TASK_TRANSACTION_EFFECTS_CLOSED', 409);
            }
            const existing = await trx.queryOne('SELECT * FROM agent_task_effects WHERE transaction_id = ? AND idempotency_key = ? FOR UPDATE', [transactionRow.id, plan.idempotencyKey]);
            if (existing) {
                const normalized = normalizeEffectRow(existing);
                if (normalized.effectType !== plan.effectType || normalized.commitMode !== plan.commitMode) {
                    throw transactionError('同一幂等键的副作用计划不一致。', 'AGENT_TASK_EFFECT_IDEMPOTENCY_CONFLICT', 409);
                }
                await renewLeases(trx, { transactionId: transactionRow.id, now: now() });
                return normalized;
            }
            if (String(plan.idempotencyKey).startsWith('business:')) {
                const duplicate = await trx.queryOne(`
                    SELECT e.id FROM agent_task_effects e
                    JOIN agent_task_transactions t ON t.id = e.transaction_id
                    WHERE t.tenant_id = ? AND e.effect_type = ? AND e.idempotency_key = ?
                    ORDER BY e.created_at DESC LIMIT 1 FOR UPDATE OF e
                `, [transactionRow.tenantId, plan.effectType, plan.idempotencyKey]);
                if (duplicate) throw transactionError('同一业务幂等键已在另一任务中登记；请核对原任务的外部结果，不能重复执行。', 'AGENT_TASK_EFFECT_CROSS_RUN_DUPLICATE', 409);
            }
            const timestamp = now();
            const id = crypto.randomUUID();
            await trx.execute(`
                INSERT INTO agent_task_effects (
                    id, transaction_id, run_id, tenant_id, effect_type, resource_keys, idempotency_key, commit_mode,
                    compensation, status, request, result, error_info, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, 'staged', ?::jsonb, '{}'::jsonb, '{}'::jsonb, ?, ?)
            `, [id, transactionRow.id, transactionRow.runId, transactionRow.tenantId, plan.effectType, JSON.stringify(plan.resourceKeys), plan.idempotencyKey, plan.commitMode, JSON.stringify(plan.compensation), JSON.stringify(jsonObject(request)), timestamp, timestamp]);
            await acquireLeases(trx, {
                transactionId: transactionRow.id, effectId: id, runId: transactionRow.runId,
                tenantId: transactionRow.tenantId, userId: transactionRow.userId,
                resourceKeys: plan.resourceKeys, now: timestamp
            });
            return normalizeEffectRow(await trx.queryOne('SELECT * FROM agent_task_effects WHERE id = ?', [id]));
        }); } catch (error) {
            if (error?.code === '23505' && String(error?.constraint || '').includes('agent_task_effects_business_idempotency')) {
                throw transactionError('同一业务幂等键正在被另一任务登记；请核对原任务结果，不能重复执行。', 'AGENT_TASK_EFFECT_CROSS_RUN_DUPLICATE', 409);
            }
            if (error?.code === 'AGENT_RESOURCE_LEASE_CONFLICT' && error.resourceConflict) {
                try { await recordConflict(error.resourceConflict); } catch (_) {}
            }
            throw error;
        }
    }

    async function updateTaskEffect(id, user, targetStatus, { result = null, errorInfo = null, requireRunAwaitingCommit = false } = {}) {
        return await runTransaction(async trx => {
            const row = await trx.queryOne(`
                SELECT e.*, t.status AS transaction_status, t.verification AS transaction_verification,
                       r.status AS run_status, r.deleted_at AS run_deleted_at FROM agent_task_effects e
                JOIN agent_task_transactions t ON t.id = e.transaction_id
                JOIN agent_runs r ON r.id = t.run_id
                WHERE e.id = ? AND t.user_id = ? FOR UPDATE OF e, t, r
            `, [String(id), user?.id]);
            if (!row) throw transactionNotFound();
            effectStatusTransition(row.status, targetStatus);
            if (['staged', 'executing', 'committed'].includes(targetStatus)
                && (row.run_deleted_at || (requireRunAwaitingCommit && row.run_status !== 'awaiting_commit'))) {
                throw transactionError('任务已隐藏、停止或不在等待提交状态，不能执行事务副作用。', 'AGENT_TASK_RUN_NOT_COMMITTABLE', 409);
            }
            if (targetStatus === 'executing' && String(row.commit_mode || 'after_verify') !== 'preview') {
                const verification = parseJson(row.transaction_verification, {});
                if (String(row.transaction_status || '') !== 'awaiting_commit'
                    || String(verification.outcomeStatus || verification.outcome_status || '') !== 'verified') {
                    throw transactionError('副作用必须在事务仍待提交且独立验收通过时才能开始执行。', 'AGENT_TASK_EFFECT_VERIFICATION_REQUIRED', 409);
                }
            }
            if (targetStatus === 'committed'
                && String(row.commit_mode || 'after_verify') !== 'preview'
                && String(row.transaction_status || '') !== 'awaiting_commit') {
                throw transactionError('副作用必须在独立验收通过后才能提交。', 'AGENT_TASK_EFFECT_VERIFICATION_REQUIRED', 409);
            }
            const timestamp = now();
            const resourceKeys = Array.isArray(parseJson(row.resource_keys, [])) ? parseJson(row.resource_keys, []) : [];
            if (targetStatus === 'staged') {
                await acquireLeases(trx, {
                    transactionId: row.transaction_id, effectId: row.id, runId: row.run_id,
                    userId: user?.id, resourceKeys, now: timestamp
                });
            } else if (['executing', 'committed'].includes(targetStatus)) {
                const renewed = await renewLeases(trx, { transactionId: row.transaction_id, now: timestamp });
                if (resourceKeys.some(key => !renewed.some(lease => lease.effectId === String(row.id) && lease.resourceKey === key))) {
                    throw transactionError('副作用所需的资源租约已失效或被释放，不能执行或提交。', 'AGENT_RESOURCE_LEASE_LOST', 409);
                }
            }
            const fields = ['status = ?', 'updated_at = ?'];
            const params = [targetStatus, timestamp];
            if (result && typeof result === 'object') { fields.push('result = ?::jsonb'); params.push(JSON.stringify(result)); }
            if (errorInfo && typeof errorInfo === 'object') { fields.push('error_info = ?::jsonb'); params.push(JSON.stringify(errorInfo)); }
            if (targetStatus === 'committed') { fields.push('committed_at = ?'); params.push(timestamp); }
            await trx.execute(`UPDATE agent_task_effects SET ${fields.join(', ')} WHERE id = ?`, [...params, row.id]);
            return normalizeEffectRow(await trx.queryOne('SELECT * FROM agent_task_effects WHERE id = ?', [row.id]));
        });
    }

    async function resolveUncertainTaskEffect(id, user, review = {}) {
        return await runTransaction(async trx => {
            const row = await trx.queryOne(`
                SELECT e.*, t.user_id FROM agent_task_effects e
                JOIN agent_task_transactions t ON t.id = e.transaction_id
                WHERE e.id = ? AND t.user_id = ? FOR UPDATE OF e, t
            `, [String(id), user?.id]);
            if (!row) throw transactionNotFound();
            const currentError = jsonObject(parseJson(row.error_info, {}));
            if (String(row.status) !== 'failed' || currentError.outcomeUncertain !== true) {
                throw transactionError('只有结果不确定的副作用可以人工核对。', 'AGENT_TASK_EFFECT_NOT_UNCERTAIN', 409);
            }
            const conclusion = String(review.conclusion || '').trim();
            if (!['committed', 'not_committed'].includes(conclusion)) {
                throw transactionError('人工核对结论必须是 committed 或 not_committed。', 'AGENT_TASK_EFFECT_REVIEW_CONCLUSION_INVALID', 400);
            }
            const evidence = text(review.evidence || review.evidenceSummary || review.evidence_summary, 2000);
            if (evidence.length < 12) {
                throw transactionError('人工核对必须提供至少 12 个字符的外部状态证据摘要。', 'AGENT_TASK_EFFECT_REVIEW_EVIDENCE_REQUIRED', 400);
            }
            const timestamp = now();
            const manualReview = { conclusion, evidence, reviewedByUserId: Number(user.id), reviewedAt: timestamp };
            const targetStatus = conclusion === 'committed' ? 'committed' : 'cancelled';
            await trx.execute(`
                UPDATE agent_task_effects
                SET status = ?,
                    committed_at = CASE WHEN ? = 'committed' THEN COALESCE(committed_at, ?) ELSE committed_at END,
                    error_info = ?::jsonb,
                    updated_at = ?
                WHERE id = ?
            `, [targetStatus, targetStatus, timestamp, JSON.stringify({ ...currentError, outcomeUncertain: false, manualReview }), timestamp, row.id]);
            return normalizeEffectRow(await trx.queryOne('SELECT * FROM agent_task_effects WHERE id = ?', [row.id]));
        });
    }

    async function recordTaskWorkspaceSnapshot(transactionId, user, snapshot = {}) {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
            const worktreeName = text(source.worktreeName, 80);
            if (!worktreeName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(worktreeName)) {
                throw transactionError('工作区快照必须关联受控影子工作树。', 'AGENT_WORKSPACE_SNAPSHOT_INVALID', 409);
            }
            const currentSnapshot = current.workspaceSnapshot && typeof current.workspaceSnapshot === 'object' ? current.workspaceSnapshot : {};
            const entries = Array.isArray(currentSnapshot.shadowWorktrees) ? currentSnapshot.shadowWorktrees : [];
            const archiveDigest = /^[a-f0-9]{64}$/i.test(String(source.archiveDigest || source.archive_digest || '')) ? String(source.archiveDigest || source.archive_digest) : '';
            const restoreHandle = text(source.restoreHandle || source.restore_handle, 160);
            if ((archiveDigest && !restoreHandle) || (!archiveDigest && restoreHandle)) {
                throw transactionError('可恢复工作区快照必须同时提供归档摘要与受控恢复句柄。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_INCOMPLETE', 409);
            }
            const normalized = {
                kind: 'shadow_worktree',
                worktreeName,
                branch: text(source.branch, 160),
                head: /^[a-f0-9]{40}$/i.test(String(source.head || '')) ? String(source.head) : '',
                revision: /^[a-f0-9]{64}$/i.test(String(source.revision || '')) ? String(source.revision) : '',
                effectId: text(source.effectId, 80),
                recovery: archiveDigest ? 'controlled_restore_available' : 'manual_preservation_required',
                ...(archiveDigest ? { archiveDigest, restoreHandle } : {}),
                capturedAt: now()
            };
            const nextEntries = [...entries.filter(item => String(item?.worktreeName || '') !== worktreeName), normalized].slice(-32);
            const next = { ...currentSnapshot, shadowWorktrees: nextEntries, snapshotVersion: 1 };
            await trx.execute('UPDATE agent_task_transactions SET workspace_snapshot = ?::jsonb, updated_at = ? WHERE id = ?', [JSON.stringify(next), now(), current.id]);
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function recordTaskTransactionVerification(transactionId, user, verification) {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            if (!['executing', 'verifying'].includes(current.status)) {
                throw transactionError('当前任务事务不处于可验收状态。', 'AGENT_TASK_TRANSACTION_NOT_VERIFYING', 409);
            }
            const report = jsonObject(verification);
            const outcome = String(report.outcomeStatus || report.outcome_status || 'needs_input');
            const timestamp = now();
            if (current.status === 'executing') {
                assertTransactionTransition('executing', 'verifying');
                await trx.execute("UPDATE agent_task_transactions SET status = 'verifying', updated_at = ? WHERE id = ?", [timestamp, current.id]);
            }
            const target = outcome === 'verified' ? 'awaiting_commit' : (outcome === 'partial' ? 'partial' : 'needs_input');
            assertTransactionTransition('verifying', target);
            await trx.execute(`
                UPDATE agent_task_transactions
                SET status = ?, verification = ?::jsonb, verified_at = ?, updated_at = ?, failure_reason = ?
                WHERE id = ?
            `, [target, JSON.stringify(report), timestamp, timestamp, target === 'awaiting_commit' ? '' : text(report.reason || `验收结果：${outcome}`, 4000), current.id]);
            if (target !== 'awaiting_commit') await releaseLeases(trx, current.id, { now: timestamp });
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function commitTaskTransaction(transactionId, user, commitEvidence = {}, options = {}) {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            await assertTaskRunAvailable(trx, current, { requireAwaitingCommit: options.requireRunAwaitingCommit === true });
            assertCommitReady({ ...current, status: current.status }, current.effects, current.verification);
            const timestamp = now();
            await renewLeases(trx, { transactionId: current.id, now: timestamp });
            assertTransactionTransition('awaiting_commit', 'committed');
            await trx.execute(`
                UPDATE agent_task_transactions
                SET status = 'committed', commit_evidence = ?::jsonb, committed_at = ?, updated_at = ?
                WHERE id = ?
            `, [JSON.stringify(jsonObject(commitEvidence)), timestamp, timestamp, current.id]);
            await releaseLeases(trx, current.id, { now: timestamp });
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function beginTaskCompensation(transactionId, user, reason = '') {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            assertRollbackEffectsSafe(current);
            assertTransactionTransition(current.status, 'compensating');
            const timestamp = now();
            await trx.execute("UPDATE agent_task_transactions SET status = 'compensating', failure_reason = ?, updated_at = ? WHERE id = ?", [text(reason, 4000), timestamp, current.id]);
            for (const effect of current.effects) {
                if (!['staged', 'executing', 'committed'].includes(effect.status) || !effect.compensation?.required) continue;
                await trx.execute("UPDATE agent_task_effects SET status = 'compensation_pending', updated_at = ? WHERE id = ?", [timestamp, effect.id]);
                await trx.execute(`
                    INSERT INTO agent_compensations (id, transaction_id, effect_id, status, plan, result, error_info, attempt_count, created_at, updated_at)
                    VALUES (?, ?, ?, 'pending', ?::jsonb, '{}'::jsonb, '{}'::jsonb, 0, ?, ?)
                    ON CONFLICT (effect_id) DO NOTHING
                `, [crypto.randomUUID(), current.id, effect.id, JSON.stringify(effect.compensation), timestamp, timestamp]);
            }
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    async function completeTaskCompensation(compensationId, user, { success, result = {}, errorInfo = {} } = {}) {
        return await runTransaction(async trx => {
            const row = await trx.queryOne(`
                SELECT c.*, t.user_id FROM agent_compensations c
                JOIN agent_task_transactions t ON t.id = c.transaction_id
                WHERE c.id = ? AND t.user_id = ? FOR UPDATE
            `, [String(compensationId), user?.id]);
            if (!row) throw transactionNotFound();
            if (!['pending', 'executing'].includes(String(row.status))) {
                throw transactionError('补偿任务不处于可完成状态。', 'AGENT_COMPENSATION_STATE_INVALID', 409);
            }
            const timestamp = now();
            const status = success === true ? 'completed' : (jsonObject(parseJson(row.plan, {})).mode === 'manual' ? 'manual_required' : 'failed');
            await trx.execute(`
                UPDATE agent_compensations
                SET status = ?, result = ?::jsonb, error_info = ?::jsonb, attempt_count = attempt_count + 1,
                    completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, updated_at = ?
                WHERE id = ?
            `, [status, JSON.stringify(jsonObject(result)), JSON.stringify(jsonObject(errorInfo)), status, timestamp, timestamp, row.id]);
            await trx.execute("UPDATE agent_task_effects SET status = ?, result = CASE WHEN ? = 'completed' THEN result ELSE result END, updated_at = ? WHERE id = ?", [status === 'completed' ? 'compensated' : 'failed', status, timestamp, row.effect_id]);
            return normalizeCompensationRow(await trx.queryOne('SELECT * FROM agent_compensations WHERE id = ?', [row.id]));
        });
    }

    async function finalizeTaskRollback(transactionId, user) {
        return await runTransaction(async trx => {
            const current = await loadTransaction(trx, String(transactionId), user?.id, true);
            if (!current) throw transactionNotFound();
            if (current.status !== 'compensating') throw transactionError('当前任务事务未在补偿中。', 'AGENT_TASK_TRANSACTION_NOT_COMPENSATING', 409);
            const failed = current.compensations.filter(item => ['failed', 'manual_required'].includes(item.status));
            const pending = current.compensations.filter(item => ['pending', 'executing'].includes(item.status));
            if (pending.length) {
                throw transactionError('仍有补偿动作未完成，不能结束回滚。', 'AGENT_TASK_COMPENSATION_PENDING', 409);
            }
            assertRollbackEffectsSafe(current, { finalizing: true });
            const target = failed.length ? 'needs_input' : 'rolled_back';
            assertTransactionTransition('compensating', target);
            const timestamp = now();
            await trx.execute(`UPDATE agent_task_transactions SET status = ?, rolled_back_at = CASE WHEN ? = 'rolled_back' THEN ? ELSE rolled_back_at END, updated_at = ? WHERE id = ?`, [target, target, timestamp, timestamp, current.id]);
            await releaseLeases(trx, current.id, { now: timestamp });
            return await loadTransaction(trx, current.id, user.id, false);
        });
    }

    return {
        beginTaskCompensation,
        commitTaskTransaction,
        completeTaskCompensation,
        createTaskTransaction,
        finalizeTaskRollback,
        getTaskTransactionForUser,
        listTaskTransactionsForRun,
        resumeTaskTransactionAfterInput,
        recordTaskTransactionVerification,
        recordTaskWorkspaceSnapshot,
        resolveUncertainTaskEffect,
        stageTaskEffect,
        transitionTaskTransaction,
        updateTaskEffect
    };
}

const defaultStore = createTaskTransactionStore();

module.exports = {
    beginTaskCompensation: defaultStore.beginTaskCompensation,
    commitTaskTransaction: defaultStore.commitTaskTransaction,
    completeTaskCompensation: defaultStore.completeTaskCompensation,
    createTaskTransaction: defaultStore.createTaskTransaction,

    finalizeTaskRollback: defaultStore.finalizeTaskRollback,
    getTaskTransactionForUser: defaultStore.getTaskTransactionForUser,
    listTaskTransactionsForRun: defaultStore.listTaskTransactionsForRun,
    resumeTaskTransactionAfterInput: defaultStore.resumeTaskTransactionAfterInput,
    recordTaskTransactionVerification: defaultStore.recordTaskTransactionVerification,
    recordTaskWorkspaceSnapshot: defaultStore.recordTaskWorkspaceSnapshot,
    resolveUncertainTaskEffect: defaultStore.resolveUncertainTaskEffect,
    stageTaskEffect: defaultStore.stageTaskEffect,
    transitionTaskTransaction: defaultStore.transitionTaskTransaction,
    updateTaskEffect: defaultStore.updateTaskEffect
};
