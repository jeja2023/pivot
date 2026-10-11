'use strict';

// 生成只读审阅包，协助业务管理员把模型候选转换为明确的人审标签。
// 它绝不修改决策评测集或数据库中的 reviewStatus。
const fs = require('fs');
const path = require('path');

function arg(name, fallback = '') {
    const inline = process.argv.find(value => String(value).startsWith(`${name}=`));
    if (inline) return String(inline).slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function escapeCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function usage() {
    console.log('用法：node scripts/generate_decision_review_packet.js --report <预审核报告> --output <Markdown路径> [--set <评测集路径>]');
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { usage(); return; }
    const reportPath = arg('--report');
    const outputPath = arg('--output');
    const setPath = arg('--set', path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json'));
    if (!reportPath || !outputPath) {
        usage();
        throw new Error('审阅包需要 --report 与 --output。');
    }
    const report = JSON.parse(await fs.promises.readFile(path.resolve(reportPath), 'utf8'));
    const evaluationSet = JSON.parse(await fs.promises.readFile(path.resolve(setPath), 'utf8'));
    if (report?.kind !== 'pivot_decision_pre_review_report' || report.evaluationSetVersion !== evaluationSet?.version) {
        throw new Error('预审核报告与评测集版本不匹配。');
    }
    const results = new Map((report.results || []).map(item => [String(item.caseId || ''), item]));
    const lines = [
        '# 决策冻结集人工审阅包',
        '',
        `- 评测集版本：\`${escapeCell(evaluationSet.version)}\``,
        `- 模型：\`${escapeCell(report.model?.name || report.model?.modelName || '')}\``,
        `- 模型预审核时间：${escapeCell(report.generatedAt)}`,
        '- 说明：下表的“模型候选”不是人工结论。管理员必须根据业务规则独立确认“人工预期动作”，再使用系统审阅界面或受控审阅命令写入标签。',
        '',
        '| 案例 | 场景 | 脱敏请求 | 允许动作 | 模型候选 | 人工预期动作 | 审阅说明 |',
        '| --- | --- | --- | --- | --- | --- | --- |'
    ];
    for (const entry of evaluationSet.cases || []) {
        const result = results.get(String(entry.id || '')) || {};
        const allowed = (entry.candidates || []).filter(item => item?.allowed !== false).map(item => item.id).join('、');
        lines.push(`| ${escapeCell(entry.id)} | ${escapeCell(entry.scenario)} | ${escapeCell(entry.providerInput?.routingText)} | ${escapeCell(allowed)} | ${escapeCell(result.selectedActionId || '无结果')} | 待业务管理员填写 | 待业务管理员填写 |`);
    }
    lines.push('', '审阅完成后，每条案例应由有权限的管理员提交对应的人工预期动作。系统会拒绝不在“允许动作”范围内的标签，且在全部 15 条完成前保持主动灰度关闭。', '');
    const target = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ output: target, cases: (evaluationSet.cases || []).length }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
