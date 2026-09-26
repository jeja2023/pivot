'use strict';

const { extractReadableDagOutput } = require('./agent-dag-output');

function buildDagFallbackFinalAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const completedNodes = nodes.filter(node => ['completed', 'continued_error'].includes(states.get(node.id)?.status));
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const terminalOutputs = completedNodes.filter(node => !dependencyIds.has(node.id))
        .map(node => ({ node, text: extractReadableDagOutput(states.get(node.id)?.output) })).filter(item => item.text);
    if (terminalOutputs.length === 1) return terminalOutputs[0].text;
    if (terminalOutputs.length > 1) return terminalOutputs.map(({ node, text }) => `## ${node.title || node.id}\n\n${text}`).join('\n\n');
    for (const node of completedNodes.slice().reverse()) {
        const text = extractReadableDagOutput(states.get(node.id)?.output);
        if (text) return text;
    }
    return completedNodes.length ? `工作流执行完成，共 ${completedNodes.length} 个节点完成。` : '';
}

function buildIncompleteDagAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const outputNodes = nodes.filter(node => String(node.tool || '') === 'workflow.output');
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const expected = outputNodes.length ? outputNodes : nodes.filter(node => ['agent.llm', 'agent.content_review'].includes(String(node.tool || '')) && !dependencyIds.has(node.id));
    if (expected.length && expected.every(node => states.get(node.id)?.status === 'completed')) return '';
    const unfinished = expected.filter(node => !['completed', 'continued_error'].includes(states.get(node.id)?.status));
    if (!unfinished.length) return '';
    const failed = nodes.filter(node => ['error', 'continued_error'].includes(states.get(node.id)?.status));
    const lines = ['## 工作流交付未完成', '', '查询或前置处理可能已经成功，但预期的分析/输出节点没有完成，因此不能把行数摘要视为校对结果。', ''];
    failed.forEach(node => lines.push('- 失败节点：' + (node.title || node.id) + '；原因：' + (states.get(node.id)?.error || '未知错误')));
    unfinished.filter(node => !failed.includes(node)).forEach(node => lines.push('- 未完成节点：' + (node.title || node.id) + '；状态：' + (states.get(node.id)?.status || 'pending')));
    return lines.join('\n');
}

module.exports = { buildDagFallbackFinalAnswer, buildIncompleteDagAnswer, extractReadableDagOutput };
