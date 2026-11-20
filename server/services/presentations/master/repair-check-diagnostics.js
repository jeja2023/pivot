'use strict';

const { posix } = require('node:path');
const { confirmedWrite } = require('./observations');

// 工具原始输出只留在检查点。进度和修复提示使用固定中文原因及受控源页坐标。
const categories = [
    [/data-pptx-bounds overlaps/i, '页面对象区域重叠'],
    [/without explicit data-pptx-bounds/i, '页面模块缺少边界声明'],
    [/typography-size recurrence|undeclared font-size/i, '重复使用了规范未声明的字号'],
    [/zero intrinsic|non-degenerate path/i, '渐变路径的可见宽度或高度为零'],
    [/exceeds .*data-pptx-bounds/i, '文字超出页面模块边界'],
    [/not well-formed|parse error|invalid XML/i, 'SVG 格式无效']
];

function checkIssues(result, pageSources) {
    if (!pageSources?.length || !Number.isInteger(result?.exitCode) || result.exitCode === 0) return [];
    const byFile = new Map(pageSources.flatMap((path, index) => typeof path === 'string' ? [[posix.basename(path), index + 1]] : []));
    const issues = new Map();
    let page = 0;
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) page = 0;
        const header = /^\[(OK|WARN|ERROR)\] (.+?\.svg) - (?:Passed|Failed)\b/u.exec(line);
        if (header) {
            page = header[1] === 'ERROR' ? byFile.get(header[2]) || 0 : 0;
            if (page && !issues.has(page)) issues.set(page, new Set());
        } else if (page && /^\s+\[ERROR\] /u.test(line)) {
            const reason = categories.find(([pattern]) => pattern.test(line))?.[1] || '页面未通过 SVG 校验';
            issues.get(page).add(reason);
        }
    }
    return [...issues].map(([page, reasons]) => ({ page, reasons: reasons.size ? [...reasons] : ['页面未通过 SVG 校验'] }));
}

function repairIssuesText(issues) {
    return (issues || []).map(({ page, reasons }) => `第 ${page} 页${reasons.join('、')}`).join('，');
}

function lastPageCheck(state, project) {
    const messages = state.messages || [];
    for (let index = messages.length - 2; index >= 0; index--) {
        if (messages[index].role !== 'assistant' || messages[index + 1].role !== 'user') continue;
        let turn, observations;
        try {
            turn = JSON.parse(messages[index].content);
            observations = JSON.parse(messages[index + 1].content);
        } catch (_) { continue; }
        if (!Array.isArray(turn?.actions) || !Array.isArray(observations)) continue;
        for (let offset = observations.length - 1; offset >= 0; offset--) {
            const action = turn.actions[offset];
            const observation = observations[offset];
            if (action?.tool === 'check_svg' && action.args?.[0] === project
                && action.args.includes('--canonical-authoring') && action.args.includes('final')) {
                return checkIssues(observation?.result, state.pageSources);
            }
            if (action?.path?.startsWith(project + '/') && confirmedWrite(action, observation)) return [];
        }
    }
    return [];
}

module.exports = { checkIssues, lastPageCheck, repairIssuesText };
