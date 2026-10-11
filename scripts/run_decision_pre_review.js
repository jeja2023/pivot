'use strict';

// 在人工冻结标签之前，对已授权真实模型执行脱敏决策评测集。
// 此脚本只生成候选动作与模型版本证据，绝不修改 reviewStatus 或冒充人工审核。
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { queryOne } = require('../server/db/client');
const { getRunnableModelForUserAsync } = require('../server/services/models');
const { callModelText } = require('../server/services/agent-model');
const { createStructuredModelDecisionProvider, evaluateDecisionProviders } = require('../server/services/decision-provider');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function usage() {
    console.log('用法：node scripts/run_decision_pre_review.js --user-id <管理员ID> --model <模型ID或名称> --report <报告路径> [--set <评测集路径>] [--max-cases <数量>] [--case-ids <逗号分隔ID>] [--delay-ms <0-60000>]');
}

function loadSet(file) {
    const source = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    if (source?.kind !== 'pivot_decision_evaluation_set' || !Array.isArray(source?.cases)) throw new Error('决策评测集格式无效。');
    return source;
}

function toContext(entry = {}) {
    const state = entry.taskState && typeof entry.taskState === 'object' ? entry.taskState : {};
    return {
        decisionId: String(entry.id || ''),
        scenario: entry.scenario,
        language: entry.language,
        taskState: {
            ...state,
            routingText: String(entry.providerInput?.routingText || ''),
            toolIntent: { requestedCapabilities: state.requestedCapabilities || state.toolIntent?.requestedCapabilities || [] }
        },
        candidates: entry.candidates || []
    };
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { usage(); return; }
    const userId = Number.parseInt(arg('--user-id'), 10);
    const modelRef = arg('--model');
    const reportPath = arg('--report');
    const setPath = arg('--set', path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json'));
    const maxCases = Math.min(Math.max(Number.parseInt(arg('--max-cases', '15'), 10) || 15, 1), 100);
    const requestedCaseIds = new Set(arg('--case-ids').split(',').map(value => value.trim()).filter(Boolean));
    const delayMs = Math.max(0, Math.min(Number.parseInt(arg('--delay-ms', '0'), 10) || 0, 60000));
    if (!Number.isSafeInteger(userId) || userId <= 0 || !modelRef || !reportPath) {
        usage();
        throw new Error('决策预审核缺少管理员、模型或报告路径。');
    }
    const user = await queryOne('SELECT id, username, nickname, unit, role, status, deleted_at FROM users WHERE id = ?', [userId]);
    if (!user || user.deleted_at || user.status === 'disabled' || user.role !== 'admin') throw new Error('决策预审核需要活动管理员账号。');
    const modelCfg = await getRunnableModelForUserAsync(modelRef, user);
    if (!modelCfg || modelCfg.secret_error) throw new Error('指定的评测模型不可用或缺少受控凭据。');
    const source = loadSet(setPath);
    const provider = createStructuredModelDecisionProvider({
        id: 'pre-review-model', version: modelCfg.model_name || modelCfg.name || '', modelCfg, user,
        invoke: callModelText, maxTokens: 256, timeoutMs: 30_000, weight: 1
    });
    const results = [];
    let circuitReason = '';
    const cases = requestedCaseIds.size
        ? source.cases.filter(entry => requestedCaseIds.has(String(entry.id || '')))
        : source.cases.slice(0, maxCases);
    if (!cases.length) throw new Error('未匹配到任何待预审核案例。');
    for (const [index, entry] of cases.entries()) {
        const context = toContext(entry);
        if (circuitReason) {
            results.push({
                caseId: String(entry.id || ''), scenario: String(entry.scenario || ''), language: String(entry.language || ''),
                allowedActionIds: (entry.candidates || []).filter(item => item?.allowed !== false).map(item => item.id),
                selectedActionId: '', scores: {}, durationMs: 0, error: `未运行：模型端点已不可用（${circuitReason}）`, providerVersion: modelCfg.model_name || modelCfg.name || ''
            });
            continue;
        }
        const output = (await evaluateDecisionProviders({ providers: [provider], context }))[0] || {};
        if (/熔断|status code 5\d\d|provider_timeout|ECONNREFUSED/i.test(String(output.error || ''))) circuitReason = String(output.error || '模型端点不可用').slice(0, 240);
        results.push({
            caseId: String(entry.id || ''), scenario: String(entry.scenario || ''), language: String(entry.language || ''),
            allowedActionIds: (entry.candidates || []).filter(item => item?.allowed !== false).map(item => item.id),
            selectedActionId: output.selectedActionId || '', scores: output.scores || {}, durationMs: Number(output.durationMs || 0),
            error: output.error || '', providerVersion: output.providerVersion || modelCfg.model_name || modelCfg.name || ''
        });
        if (!circuitReason && delayMs > 0 && index < cases.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    const report = {
        kind: 'pivot_decision_pre_review_report', generatedAt: new Date().toISOString(), evaluationSetVersion: source.version,
        model: { id: modelCfg.id, name: modelCfg.name || '', modelName: modelCfg.model_name || '' },
        caseCount: results.length, results,
        reviewNotice: '此报告只记录模型对脱敏冻结案例的候选选择，不构成人工审核标签，也不能用于训练、发布或开启 active 灰度。'
    };
    const target = path.resolve(reportPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ report: target, caseCount: results.length, failures: results.filter(item => item.error).length }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
