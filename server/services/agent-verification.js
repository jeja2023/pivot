'use strict';

const { normalizeJsonSchema, schemaHasRules, validateValueAgainstSchema } = require('./agent-dag-contracts');
const { queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { buildChatAttachmentEvidenceObservation, buildChatRagEvidenceObservation } = require('./chat-rag-context');
const { normalizeBusinessScope } = require('./chat-task-contract-update');

const MAX_CONTRACT_ITEMS = 32;

function text(value, max = 4000) {
    return String(value ?? '').trim().slice(0, max);
}

function normalizeContractItems(value, limit = MAX_CONTRACT_ITEMS) {
    const source = Array.isArray(value) ? value : [];
    return source.map(item => text(item, 500)).filter(Boolean).slice(0, limit);
}

function normalizeAcceptance(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const schema = normalizeJsonSchema(source.outputSchema || source.output_schema || {});
    const requiredFormats = [...new Set(normalizeContractItems(source.requiredFormats || source.required_formats, 20).map(value => value.toLowerCase()))]
        .filter(format => /^[a-z0-9][a-z0-9_-]{0,15}$/u.test(format));
    return {
        ...(requiredFormats.length ? { requiredFormats } : {}),
        requiredPhrases: normalizeContractItems(source.requiredPhrases || source.required_phrases),
        forbiddenPhrases: normalizeContractItems(source.forbiddenPhrases || source.forbidden_phrases),
        minLength: Math.max(0, Math.min(Number.parseInt(source.minLength || source.min_length, 10) || 0, 100000)),
        requireJson: source.requireJson === true || source.require_json === true,
        outputSchema: schemaHasRules(schema) ? schema : {},
        requiredArtifacts: normalizeContractItems(source.requiredArtifacts || source.required_artifacts, 16),
        requireEvidence: source.requireEvidence === true || source.require_evidence === true,
        ...(source.artifactRequired === true || requiredFormats.length ? { artifactRequired: true } : {}),
        ...(source.requireSemanticVerification === true || requiredFormats.length ? { requireSemanticVerification: true } : {}),
        ...(source.requireCompleteSource === true ? { requireCompleteSource: true } : {})
    };
}

function normalizeTaskContract(value = {}, goal = '', { verifyByDefault = false } = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const acceptance = normalizeAcceptance(source.acceptance || source);
    const hasAcceptance = acceptance.requiredPhrases.length || acceptance.forbiddenPhrases.length || acceptance.minLength > 0
        || acceptance.requireJson || schemaHasRules(acceptance.outputSchema) || acceptance.requiredArtifacts.length
        || acceptance.requireEvidence || acceptance.artifactRequired || acceptance.requireSemanticVerification;
    if (verifyByDefault && !hasAcceptance) acceptance.requireSemanticVerification = true;
    const revision = Math.max(1, Math.min(Number.parseInt(source.revision, 10) || 1, 1000000));
    return {
        schemaVersion: 1,
        revision,
        goal: text(source.goal || goal, 12000),
        constraints: normalizeContractItems(source.constraints, 32),
        ...(Object.keys(normalizeBusinessScope(source.businessScope)).length ? { businessScope: normalizeBusinessScope(source.businessScope) } : {}),
        deliverables: Array.isArray(source.deliverables) ? source.deliverables.slice(0, 16) : [],
        acceptance,
        repairAttempts: Math.max(0, Math.min(Number.parseInt(source.repairAttempts || source.repair_attempts, 10) || 0, 3)),
        source: text(source.source || 'server_generated', 40) || 'server_generated',
        ...(source.authorizationRef ? { authorizationRef: text(source.authorizationRef, 160) } : {}),
        ...(source.budgetRef ? { budgetRef: text(source.budgetRef, 160) } : {})
    };
}

function parseOutput(value) {
    const source = text(value, 2_000_000);
    if (!source) return null;
    try { return JSON.parse(source); } catch (_) {}
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return null;
    try { return JSON.parse(fenced[1]); } catch (_) { return null; }
}

function findArtifactNames(observations = []) {
    const names = new Set();
    const collectArtifactName = (value, depth = 0) => {
        if (depth > 5 || value === null || value === undefined) return;
        if (typeof value === 'string') return;
        if (Array.isArray(value)) return value.slice(0, 80).forEach(item => collectArtifactName(item, depth + 1));
        if (typeof value !== 'object') return;
        const name = text(value.name || value.title || value.fileName || value.filename, 300);
        const hasReference = value.id || value.fileId || value.artifactId || value.url || value.downloadUrl || value.outputRef;
        if (name && hasReference) names.add(name);
        Object.values(value).slice(0, 80).forEach(item => collectArtifactName(item, depth + 1));
    };
    collectArtifactName(observations);
    return [...names];
}

function hasEvidence(observations = []) {
    return (Array.isArray(observations) ? observations : []).some(item => {
        const value = item?.output ?? item;
        return Boolean(value?.citations?.length || value?.sources?.length || value?.evidence?.length || value?.results?.some?.(result => result?.url));
    });
}

function verifyTaskOutcome({ taskContract, goal = '', answer = '', observations = [], evidence = [], partial = false, reason = '', semanticVerification = null } = {}) {
    const contract = normalizeTaskContract(taskContract, goal);
    const output = text(answer, 2_000_000);
    const acceptance = contract.acceptance;
    const rules = [];
    const add = (key, passed, actual = '', hard = true) => rules.push({ key, passed: Boolean(passed), hard, actual: text(actual, 500) });
    add('final_answer_non_empty', Boolean(output), output.length, true);
    acceptance.requiredPhrases.forEach(phrase => add('required_phrase', output.includes(phrase), phrase));
    acceptance.forbiddenPhrases.forEach(phrase => add('forbidden_phrase', !output.includes(phrase), phrase));
    if (acceptance.minLength > 0) add('min_length', output.length >= acceptance.minLength, output.length);
    const parsed = parseOutput(output);
    if (acceptance.requireJson) add('valid_json', parsed !== null, parsed === null ? 'invalid' : 'valid');
    if (schemaHasRules(acceptance.outputSchema)) {
        const issues = parsed === null ? ['结果不是合法 JSON。'] : validateValueAgainstSchema(parsed, acceptance.outputSchema, { allowTemplates: false }, '结果', []);
        add('output_schema', issues.length === 0, issues[0] || 'valid');
    }
    const verifiedArtifacts = acceptance.requireSemanticVerification ? (semanticVerification?.verifiedArtifacts || []) : [];
    const artifactNames = acceptance.requireSemanticVerification ? verifiedArtifacts.map(item => text(item.title, 300)).filter(Boolean) : findArtifactNames(observations);
    const hasArtifact = acceptance.requireSemanticVerification ? verifiedArtifacts.length > 0 : artifactNames.length > 0;
    if (acceptance.artifactRequired) add('artifact_required', hasArtifact, hasArtifact ? (artifactNames.join('、') || '已生成受控文件') : '尚未生成要求的文件');
    if (acceptance.requireSemanticVerification) add('deliverables_verified', semanticVerification?.passed === true, semanticVerification?.reason || (semanticVerification?.missing || []).join('；'));
    acceptance.requiredArtifacts.forEach(required => add('required_artifact', artifactNames.includes(required), required));
    const evidenceFound = semanticVerification?.reason !== 'source_revoked' && (hasEvidence(observations) || semanticVerification?.verifiedSourceImages?.length > 0 || (Array.isArray(evidence) && evidence.length > 0));
    if (semanticVerification?.reason === 'source_revoked') add('knowledge_sources_current', false, '资料来源已变化或不可访问');
    if (acceptance.requireEvidence) add('evidence', evidenceFound, evidenceFound ? '已提供可核验来源' : '缺少引用来源与佐证');
    const hardFailures = rules.filter(rule => rule.hard && !rule.passed);
    const outcomeStatus = partial ? 'partial' : hardFailures.length ? 'needs_input' : 'verified';
    return {
        version: 1,
        verifiedAt: new Date().toISOString(),
        taskContract: contract,
        outcomeStatus,
        hardFailures: hardFailures.map(rule => rule.key),
        rules,
        artifactNames,
        observationCount: Array.isArray(observations) ? observations.length : 0,
        reason: text(reason, 1000)
    };
}

function taskVerificationFailureMessage(report = {}) {
    const labels = {
        final_answer_non_empty: '未生成有效答案', evidence: '缺少可核验的资料来源',
        required_phrase: '缺少要求的内容', forbidden_phrase: '包含禁止的内容', min_length: '答复内容不完整',
        valid_json: '结果格式不符合要求', output_schema: '结果结构不符合要求',
        artifact_required: '尚未生成要求的文件', required_artifact: '缺少要求的文件',
        deliverables_verified: '交付内容尚未通过核验'
        ,knowledge_sources_current: '资料来源已变化或不可访问'
    };
    const semanticReasons = { source_revoked: '原始资料已不可用', source_not_fully_read: '尚未读取完整资料',
        artifact_not_materialized: '尚未生成要求的文件', artifact_integrity_failed: '生成文件未通过完整性检查', verifier_unavailable: '验收服务暂时不可用，可稍后重试', verification_evidence_incomplete: '完整核验证据不可用，请重新读取资料后再核验', verification_context_limit: '核验材料超过模型上下文容量，请分批处理或选择更大上下文的模型', user_input_required: '需要用户补充业务信息' };
    const semantic = report.semanticVerification;
    const details = [...new Set((report.hardFailures || []).map(key => labels[key] || '结果尚未通过验收'))];
    if (semantic?.reason) details.push(semanticReasons[semantic.reason] || require('./task-verification-details').verificationReasonLabel(semantic.reason));
    if (Array.isArray(semantic?.missing)) details.push(...semantic.missing.slice(0, 3).map(item => text(item, 200)));
    return `任务尚未完成：${details.filter(Boolean).join('；') || '请查看详情中的验收结果'}。`;
}

async function verifyAndRecordTaskOutcome({ runId, run, user = null, taskContract = null, answer, observations, partial = false, reason = '', setRunMetadata, signal, budget, repairOptions = null, buildFinalState = null, beforeFinalize = null } = {}, deps = {}) {
    signal?.throwIfAborted();
    let metadata = run?.metadata;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
    }
    const chatBridge = metadata?.chatBridge;
    const ragEvidence = buildChatRagEvidenceObservation(chatBridge);
    const attachmentEvidence = buildChatAttachmentEvidenceObservation(chatBridge);
    observations = [
        ...(Array.isArray(observations) ? observations : []),
        ...(run?.knowledgeBoundaryEvidence ? [{ tool: 'agent.history', knowledgeEvidence: run.knowledgeBoundaryEvidence }] : []),
        ...(ragEvidence ? [ragEvidence] : []),
        ...(attachmentEvidence ? [attachmentEvidence] : [])
    ];
    let evidenceFailure = null;
    if (runId && run?.user_id) {
        try { observations = await require('./agent-verification-evidence').loadVerificationEvidence(runId, user || { id: run.user_id }, observations, deps); }
        catch (error) {
            signal?.throwIfAborted();
            evidenceFailure = { passed: false, reason: error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE' ? 'source_revoked'
                : error.code === 'VERIFICATION_CONTEXT_LIMIT' ? 'verification_context_limit' : 'verification_evidence_incomplete' };
        }
    }
    let evidence = [];
    if (runId) {
        try {
            const row = await queryOne('SELECT COUNT(*) AS count FROM agent_evidence_items WHERE run_id = ?', [runId]);
            evidence = Number(row?.count || 0) > 0 ? [{}] : [];
        } catch (_) {
            evidence = [];
        }
    }
    const contract = normalizeTaskContract(taskContract || metadata?.taskContract || metadata?.task_contract || run?.taskContract, run?.goal || '', { verifyByDefault: run?.run_mode !== 'dag' });
    let semanticVerification = evidenceFailure || (contract.acceptance.requireSemanticVerification && !partial
        ? await require('./chat-task-verification').verifyAutomaticTask({ run, user: user || { id: run?.user_id }, contract, answer, observations, signal, budget }) : null);
    if (!semanticVerification && observations.some(item => item.knowledgeEvidence || item.output?.knowledgeEvidence || item.output?.knowledgeSourceVersion === 1)) {
        const current = await require('./knowledge-tool-results').revalidateKnowledgeToolEvidence(observations, user || { id: run?.user_id });
        if (!current) semanticVerification = { passed: false, reason: 'source_revoked' };
    }
    signal?.throwIfAborted();
    const report = verifyTaskOutcome({
        taskContract: contract,
        goal: run?.goal || '',
        answer,
        observations,
        evidence,
        partial: partial || semanticVerification?.reason === 'budget_exceeded',
        reason,
        semanticVerification
    });
    if (semanticVerification) report.semanticVerification = semanticVerification;
    if (/^[a-f0-9]{64}$/.test(String(run?.executionModelIdentity || ''))) report.executionModelIdentity = run.executionModelIdentity;
    if (require('./agent-verification-repair').canAttemptVerificationRepair(report, { ...repairOptions, budget })) {
        report.taskContract.repairAttempts += 1;
        report.repair = { allowed: true, attempt: report.taskContract.repairAttempts, maxAttempts: 2 };
    }
    // DAG 的验收报告、事务和终态在同一行锁内写入，暂停与换租约共享这道边界。
    const persist = async executor => {
        signal?.throwIfAborted();
        if (executor) {
            const current = await executor.queryOne(`SELECT status, locked_by, realtime_lease_epoch, deleted_at,
                lock_expires_at > clock_timestamp() AS lease_current FROM agent_runs WHERE id = ? AND user_id = ? FOR UPDATE`, [runId, run.user_id]);
            signal?.throwIfAborted();
            if (!current || current.deleted_at || current.status !== 'verifying') {
                throw Object.assign(new Error('任务已离开核验阶段。'), { code: current?.status === 'needs_input' ? 'AGENT_RUN_PAUSED' : 'AGENT_RUN_CANCELLED' });
            }
            if (current.locked_by !== (run.realtimeLeaseOwner || null) || (run.realtimeLeaseOwner &&
                (!current.lease_current || String(current.realtime_lease_epoch) !== String(run.realtimeLeaseEpoch)))) {
                throw Object.assign(new Error('任务核验执行权已失效。'), { code: 'AGENT_RUN_LEASE_LOST' });
            }
        }
        const patch = async metadataPatch => {
            if (executor) await executor.execute(`UPDATE agent_runs SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb WHERE id = ?`, [JSON.stringify(metadataPatch), runId]);
            else if (runId && typeof setRunMetadata === 'function') await setRunMetadata(runId, metadataPatch);
        };
        await patch({ taskContract: report.taskContract, taskVerification: report });
        if (runId && run?.user_id) {
            const verificationId = `verify_${runId}`.slice(0, 128);
            await (executor?.queryOne || queryOne)(`
                INSERT INTO agent_verifications (
                    id, run_id, user_id, contract, outcome_status, report, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (run_id) DO UPDATE SET
                    contract = EXCLUDED.contract,
                    outcome_status = EXCLUDED.outcome_status,
                    report = EXCLUDED.report,
                    updated_at = EXCLUDED.updated_at
                RETURNING id
            `, [
                verificationId,
                runId,
                run.user_id,
                JSON.stringify(report.taskContract),
                report.outcomeStatus,
                JSON.stringify(report),
                getBeijingTimestamp(),
                getBeijingTimestamp()
            ]);
        }
        // Task Transaction 与文本验收分层：先持久化独立 VerificationReport，
        // 再推进事务。无副作用事务可在验收后自动提交；带副作用事务会停在
        // awaiting_commit，直到每个 effect 提供提交证据，绝不因模型文本而自动交付。
        const transactionId = String(metadata?.taskTransactionId || metadata?.task_transaction_id || '').trim();
        signal?.throwIfAborted();
        if (runId && transactionId && !report.repair?.allowed && (user?.id || run?.user_id)) {
            const transactionUser = user || { id: run.user_id };
            const {
                commitTaskTransaction,
                getTaskTransactionForUser,
                recordTaskTransactionVerification
            } = require('./agent-task-transactions');
            let taskTransaction = await getTaskTransactionForUser(transactionId, transactionUser, executor);
            signal?.throwIfAborted();
            if (taskTransaction && ['executing', 'verifying'].includes(taskTransaction.status)) {
                taskTransaction = await recordTaskTransactionVerification(transactionId, transactionUser, report, executor);
            }
            if (taskTransaction?.status === 'awaiting_commit') {
                const hasPendingEffect = taskTransaction.effects.some(effect => (
                    effect.commitMode !== 'preview' && effect.status !== 'committed'
                ));
                if (!hasPendingEffect) {
                    signal?.throwIfAborted();
                    taskTransaction = await commitTaskTransaction(transactionId, transactionUser, {
                        kind: 'verification_auto_commit',
                        verificationId: `verify_${runId}`.slice(0, 128),
                        verifiedAt: report.verifiedAt
                    }, { executor });
                }
            }
            if (taskTransaction) {
                report.taskTransaction = {
                    id: taskTransaction.id,
                    status: taskTransaction.status,
                    effectCount: taskTransaction.effects.length,
                    compensationCount: taskTransaction.compensations.length,
                    committedAt: taskTransaction.committedAt || null
                };
                await patch({
                        taskTransactionId: taskTransaction.id,
                        taskTransactionStatus: taskTransaction.status,
                        taskVerification: report
                    });
            }
        }
        if (executor) {
            signal?.throwIfAborted();
            const final = buildFinalState(report);
            const now = getBeijingTimestamp();
            const updated = await executor.execute(`UPDATE agent_runs SET status = ?, final_answer = ?, error_message = ?, completed_at = ?,
                last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND (NOT ?::boolean OR lock_expires_at > clock_timestamp())`,
            [final.status, final.final_answer, final.error_message, final.completed_at || null, now, now, runId, Boolean(run.realtimeLeaseOwner)]);
            if (!updated) throw Object.assign(new Error('任务核验执行权已失效。'), { code: 'AGENT_RUN_LEASE_LOST' });
            return final.status;
        }
        return null;
    };
    if (beforeFinalize) await beforeFinalize();
    const finalizedStatus = buildFinalState ? await transaction(persist) : await persist(null);
    if (finalizedStatus) report.finalizedStatus = finalizedStatus;
    if (runId && run?.user_id) {
        try {
            const { recordModelQualityOutcome } = require('./agent-model-quality');
            await recordModelQualityOutcome({ run, user: user || { id: run.user_id }, verification: report });
        } catch (_) {
            // 质量指标汇聚属于参考性操作，指标记录失败不能覆盖确定性的任务验收结果。
        }
    }
    return report;
}

async function getTaskVerificationForUser(runId, user) {
    if (!runId || !user?.id) return null;
    const row = await queryOne(`
        SELECT v.id, v.run_id, v.contract, v.outcome_status, v.report, v.created_at, v.updated_at
        FROM agent_verifications v
        JOIN agent_runs r ON r.id = v.run_id
        WHERE v.run_id = ? AND r.user_id = ? AND r.deleted_at IS NULL
    `, [runId, user.id]);
    if (!row) return null;
    const parse = value => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
    };
    return {
        id: row.id,
        runId: row.run_id,
        outcomeStatus: row.outcome_status,
        contract: parse(row.contract),
        report: parse(row.report),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

module.exports = {
    getTaskVerificationForUser,
    normalizeTaskContract,
    taskVerificationFailureMessage,
    verifyAndRecordTaskOutcome,
    verifyTaskOutcome
};
