'use strict';

// 将因上游限流而分段生成的真实预审核报告合并为一份可审计证据。
// 只合并已有模型结果；绝不写入人工 reviewStatus 或改变灰度状态。
const fs = require('fs');
const path = require('path');

function arg(name, fallback = '') {
    const inline = process.argv.find(value => String(value).startsWith(`${name}=`));
    if (inline) return String(inline).slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function usage() {
    console.log('用法：node scripts/merge_decision_pre_review_reports.js --inputs <报告1,报告2,...> --report <输出报告> [--set <评测集路径>]');
}

function loadJson(file) {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { usage(); return; }
    const inputs = arg('--inputs').split(',').map(value => value.trim()).filter(Boolean);
    const reportPath = arg('--report');
    const setPath = arg('--set', path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json'));
    if (!inputs.length || !reportPath) {
        usage();
        throw new Error('合并报告需要 --inputs 与 --report。');
    }
    const reports = inputs.map(loadJson);
    if (reports.some(item => item?.kind !== 'pivot_decision_pre_review_report' || !Array.isArray(item?.results))) {
        throw new Error('输入包含无效的预审核报告。');
    }
    const first = reports[0];
    if (reports.some(item => item.evaluationSetVersion !== first.evaluationSetVersion || item.model?.id !== first.model?.id)) {
        throw new Error('输入报告的评测集版本或模型不一致，拒绝合并。');
    }
    const evaluationSet = loadJson(setPath);
    if (evaluationSet?.version !== first.evaluationSetVersion || !Array.isArray(evaluationSet?.cases)) {
        throw new Error('评测集与输入报告版本不一致。');
    }
    const resultsByCase = new Map();
    reports.forEach((report, reportIndex) => {
        report.results.forEach(result => {
            const id = String(result?.caseId || '').trim();
            if (!id) return;
            const previous = resultsByCase.get(id);
            // 成功结果优先；多个成功结果时保留后一次，便于重试纠正瞬态失败。
            if (!previous || !result.error || previous.error) {
                resultsByCase.set(id, { ...result, mergedFrom: path.basename(inputs[reportIndex]) });
            }
        });
    });
    const results = evaluationSet.cases.map(entry => {
        const result = resultsByCase.get(String(entry.id));
        if (result) return result;
        return {
            caseId: String(entry.id || ''), scenario: String(entry.scenario || ''), language: String(entry.language || ''),
            allowedActionIds: (entry.candidates || []).filter(item => item?.allowed !== false).map(item => item.id),
            selectedActionId: '', scores: {}, durationMs: 0, error: '未在输入预审核报告中找到此案例。', providerVersion: first.model?.modelName || ''
        };
    });
    const merged = {
        kind: 'pivot_decision_pre_review_report',
        generatedAt: new Date().toISOString(),
        evaluationSetVersion: first.evaluationSetVersion,
        model: first.model,
        caseCount: results.length,
        mergedFrom: inputs.map(item => path.basename(item)),
        results,
        reviewNotice: '此报告只记录模型对脱敏冻结案例的候选选择，不构成人工审核标签，也不能用于训练、发布或开启 active 灰度。'
    };
    const target = path.resolve(reportPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ report: target, caseCount: results.length, failures: results.filter(item => item.error).length, sources: merged.mergedFrom }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
