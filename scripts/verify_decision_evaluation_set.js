'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeActionId, sanitizeDecisionContext } = require('../server/services/decision-provider');

const file = path.resolve(process.argv[2] || path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json'));
const requireVerified = process.argv.includes('--require-verified');
const source = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
const pending = [];
const fingerprints = new Set();

if (source?.schemaVersion !== 1 || source?.kind !== 'pivot_decision_evaluation_set' || !Array.isArray(source?.cases)) {
    failures.push('评测集格式无效：需要 schemaVersion=1、正确 kind 与 cases 数组。');
}
for (const entry of source?.cases || []) {
    const id = String(entry?.id || '').trim();
    const rawTaskState = entry?.taskState && typeof entry.taskState === 'object' ? entry.taskState : {};
    const safe = sanitizeDecisionContext({
        scenario: entry?.scenario,
        language: entry?.language,
        taskState: {
            ...rawTaskState,
            toolIntent: { requestedCapabilities: rawTaskState.requestedCapabilities || rawTaskState.toolIntent?.requestedCapabilities || [] }
        },
        candidates: entry?.candidates
    });
    const allowed = new Set(safe.candidates.filter(candidate => candidate.allowed).map(candidate => candidate.id));
    if (!id || !/^[a-z0-9-]{4,80}$/i.test(id)) failures.push('用例 ID 无效：' + id);
    if (!safe.scenario || safe.scenario === 'unknown' || allowed.size < 2) failures.push('用例候选或场景无效：' + id);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ scenario: safe.scenario, language: safe.language, requestState: safe.requestState, candidates: safe.candidates })).digest('hex');
    if (fingerprints.has(fingerprint)) failures.push('存在重复的脱敏用例：' + id);
    fingerprints.add(fingerprint);
    const routingText = String(entry?.providerInput?.routingText || '').trim();
    if (!routingText || routingText.length > 512) failures.push('用例缺少有限长度的合成路由指令：' + id);
    if (/(?:sk-|pk-|Bearer\s+)[A-Za-z0-9._~+/=-]{12,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[-\s]?)?1[3-9]\d{9}|\b(?:\d{15}|\d{17}[0-9Xx])\b/iu.test(routingText)) {
        failures.push('冻结评测集路由指令不得包含疑似敏感数据：' + id);
    }
    const status = String(entry?.reviewStatus || 'pending_human_review');
    if (status === 'verified') {
        const expected = normalizeActionId(entry?.expectedActionId);
        if (!expected || !allowed.has(expected) || !String(entry?.reviewedBy || '').trim() || !String(entry?.reviewedAt || '').trim()) {
            failures.push('已核验用例缺少合法标签或复核记录：' + id);
        }
    } else {
        pending.push(id);
        if (entry?.expectedActionId) failures.push('未核验用例不得写入 expectedActionId：' + id);
    }
}
if (requireVerified && pending.length) failures.push('仍有 ' + pending.length + ' 个用例等待人工核验。');
const result = { file, version: source?.version || '', total: source?.cases?.length || 0, verified: (source?.cases || []).length - pending.length, pending: pending.length, pendingIds: pending };
if (failures.length) {
    failures.forEach(message => console.error(message));
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
} else {
    console.log(JSON.stringify(result, null, 2));
}
