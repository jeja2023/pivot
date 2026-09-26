'use strict';

const { normalizeJsonSchema, schemaHasRules, validateValueAgainstSchema } = require('./agent-dag-contracts');
const { queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const MAX_CONTRACT_ITEMS = 32;

function text(value, max = 4000) {
    return String(value ?? '').trim().slice(0, max);
}

function list(value, limit = MAX_CONTRACT_ITEMS) {
    const source = Array.isArray(value) ? value : [];
    return source.map(item => text(item, 500)).filter(Boolean).slice(0, limit);
}

function normalizeAcceptance(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const schema = normalizeJsonSchema(source.outputSchema || source.output_schema || {});
    return {
        requiredPhrases: list(source.requiredPhrases || source.required_phrases),
        forbiddenPhrases: list(source.forbiddenPhrases || source.forbidden_phrases),
        minLength: Math.max(0, Math.min(Number.parseInt(source.minLength || source.min_length, 10) || 0, 100000)),
        requireJson: source.requireJson === true || source.require_json === true,
        outputSchema: schemaHasRules(schema) ? schema : {},
        requiredArtifacts: list(source.requiredArtifacts || source.required_artifacts, 16),
        requireEvidence: source.requireEvidence === true || source.require_evidence === true
    };
}

function normalizeTaskContract(value = {}, goal = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const acceptance = normalizeAcceptance(source.acceptance || source);
    const revision = Math.max(1, Math.min(Number.parseInt(source.revision, 10) || 1, 1000000));
    return {
        schemaVersion: 1,
        revision,
        goal: text(source.goal || goal, 12000),
        constraints: list(source.constraints, 32),
        deliverables: Array.isArray(source.deliverables) ? source.deliverables.slice(0, 16) : [],
        acceptance,
        repairAttempts: Math.max(0, Math.min(Number.parseInt(source.repairAttempts || source.repair_attempts, 10) || 0, 3)),
        source: text(source.source || 'server_generated', 40) || 'server_generated'
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

function verifyTaskOutcome({ taskContract, goal = '', answer = '', observations = [], evidence = [], partial = false, reason = '' } = {}) {
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
    const artifactNames = findArtifactNames(observations);
    acceptance.requiredArtifacts.forEach(required => add('required_artifact', artifactNames.includes(required), required));
    if (acceptance.requireEvidence) add('evidence', hasEvidence(observations) || (Array.isArray(evidence) && evidence.length > 0), 'evidence');
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

async function verifyAndRecordTaskOutcome({ runId, run, user = null, taskContract = null, answer, observations, partial = false, reason = '', setRunMetadata } = {}) {
    let metadata = run?.metadata;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
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
    const report = verifyTaskOutcome({
        taskContract: taskContract || metadata?.taskContract || metadata?.task_contract || run?.taskContract,
        goal: run?.goal || '',
        answer,
        observations,
        evidence,
        partial,
        reason
    });
    if (typeof setRunMetadata === 'function' && runId) {
        await setRunMetadata(runId, { taskContract: report.taskContract, taskVerification: report });
    }
    if (runId && run?.user_id) {
        const verificationId = `verify_${runId}`.slice(0, 128);
        await queryOne(`
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
    verifyAndRecordTaskOutcome,
    verifyTaskOutcome
};
