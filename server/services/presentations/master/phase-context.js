'use strict';

const crypto = require('node:crypto');
const { confirmedWrite } = require('./observations');
const GENERATE_DIGEST = 'ab30c3c0ff8b4351d31d99f5fad77285e37d6830ab185da82f38475347c2203f';
const ROUTING_DIGEST = '4a7495e3e0d8951b52970920f2a22a0a4fccc7ae5c77426c40b0b097690c8d3f';
const SPEC_PRESERVING_TOOLS = new Set(['text_measure', 'check_svg', 'analyze_images', 'icon_sync']);

// 只有真实确认及同一项目的两份文件写入和上游校验均有回执，才能收起已完成的前置章节。
function validatedProject(state) {
    if (state.request?.operation !== 'generate' || state.request?.profile !== 'default' || state.confirmationRevisionPending) return '';
    const approvedProject = state.review?.approvals?.design?.plan?.project;
    if (state.review ? !approvedProject : Number(state.confirmedGates || 0) < 2) return '';
    const files = new Map(); let validated = '';
    for (let index = 0; index < (state.messages || []).length; index++) {
        const assistant = state.messages[index], response = state.messages[index + 1];
        if (assistant.role === 'user' && typeof assistant.content === 'string'
            && (assistant.content.startsWith('宿主中断后从已保存检查点继续。') || assistant.content.startsWith('用户对本次确认问题的实际答复：'))) validated = '';
        if (assistant.role !== 'assistant' || response?.role !== 'user') continue;
        let turn, results;
        try { turn = JSON.parse(assistant.content); results = JSON.parse(response.content); } catch (_) { continue; }
        if (!Array.isArray(turn.actions) || !Array.isArray(results)) continue;
        turn.actions.forEach((action, n) => {
            const result = results[n];
            if (!result || result.action !== action.action || result.error) {
                if (['write', 'run', 'copy', 'copy_template', 'validate_template'].includes(action.action)) validated = '';
                return;
            }
            if (action.action === 'write') {
                const path = String(action.path || ''), match = /^(.*)\/(design_spec\.md|spec_lock\.md)$/.exec(path);
                if (match && confirmedWrite(action, result)) {
                    const entry = files.get(match[1]) || new Set(); entry.add(match[2]); files.set(match[1], entry); validated = '';
                } else if (!/^.+\/svg_output\/[^/]+\.svg$/.test(path)) validated = '';
            } else if (action.action === 'run') {
                const args = action.args || [];
                const project = action.tool === 'project' && args[0] === 'validate' && typeof args[1] === 'string' ? args[1] : '';
                if (project && result.result?.exitCode === 0 && files.get(project)?.size === 2) validated = project;
                else if (!SPEC_PRESERVING_TOOLS.has(action.tool) || result.result?.exitCode !== 0) validated = '';
            } else if (['copy', 'copy_template', 'validate_template'].includes(action.action)) validated = '';
        });
    }
    return approvedProject && validated !== approvedProject ? '' : validated;
}

function phaseMessages(messages, state) {
    const project = validatedProject(state);
    if (!project) return { messages, phase: 'full' };
    const ranges = new Map();
    const result = messages.map(message => {
        if (message.role !== 'user' || typeof message.content !== 'string') return message;
        let item;
        try { item = JSON.parse(message.content); } catch (_) { return message; }
        if (typeof item?.text !== 'string' || item.nextOffset != null) return message;
        const routing = item.runtimeDocument === 'workflows/routing.md';
        if (!routing && item.runtimeDocument !== 'workflows/generate-pptx.md') return message;
        if (crypto.createHash('sha256').update(item.text).digest('hex') !== (routing ? ROUTING_DIGEST : GENERATE_DIGEST)) return message;
        const start = item.text.indexOf(routing ? '## 2. Top-Level Route Matrix' : '### Step 1: Source Content Processing');
        const end = item.text.indexOf(routing ? '## 3. Generate PPTX Profiles and Stages' : '### Step 4: Strategist Phase');
        if (start < 0 || end <= start) return message;
        const updated = { ...message, content: JSON.stringify({ ...item, text: item.text.slice(0, start)
            + `\n[已取得用户对最终方案的批准和当前项目校验回执，暂收起${routing ? '已完成的流程选路表' : '步骤1至3'}；如需原文，用 read_runtime 重新读取 ${item.runtimeDocument}。项目：${project}]\n\n` + item.text.slice(end),
        phase: 'validated_project', fullTextAvailable: true }) };
        ranges.set(updated, [{ offset: 0, points: Array.from(item.text.slice(0, start)) },
            { offset: Array.from(item.text.slice(0, end)).length, points: Array.from(item.text.slice(end)) }]);
        return updated;
    });
    return { messages: result, phase: 'validated_project', ranges };
}

module.exports = { phaseMessages, validatedProject };
