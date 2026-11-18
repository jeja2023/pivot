'use strict';

const crypto = require('node:crypto');
const { confirmedWrite } = require('./observations');
const GENERATE_DIGEST = '3639027ce5e3ff8e328cc0056440a4cb308306fc7503d725a62c6b39e1221048';

// 只有真实确认及同一项目的两份文件写入和上游校验均有回执，才能收起已完成的前置章节。
function validatedProject(state) {
    if (state.request?.operation !== 'generate' || state.request?.profile !== 'default' || state.confirmationRevisionPending || Number(state.confirmedGates || 0) < 2) return '';
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
                validated = project && result.result?.exitCode === 0 && files.get(project)?.size === 2 ? project : '';
            } else if (['copy', 'copy_template', 'validate_template'].includes(action.action)) validated = '';
        });
    }
    return validated;
}

function phaseMessages(messages, state) {
    const project = validatedProject(state);
    if (!project) return { messages, phase: 'full' };
    const result = messages.map(message => {
        if (message.role !== 'user' || typeof message.content !== 'string') return message;
        let item;
        try { item = JSON.parse(message.content); } catch (_) { return message; }
        if (item.runtimeDocument !== 'workflows/generate-pptx.md' || typeof item.text !== 'string' || item.nextOffset != null
            || crypto.createHash('sha256').update(item.text).digest('hex') !== GENERATE_DIGEST) return message;
        const start = item.text.indexOf('### Step 1: Source Content Processing'), end = item.text.indexOf('### Step 4: Strategist Phase');
        if (start < 0 || end <= start) return message;
        return { ...message, content: JSON.stringify({ ...item, text: item.text.slice(0, start)
            + `\n[已取得两次用户确认和当前项目校验回执，暂收起步骤1至3；如需原文，用 read_runtime 重新读取 ${item.runtimeDocument}。项目：${project}]\n\n` + item.text.slice(end),
        phase: 'validated_project', fullTextAvailable: true }) };
    });
    return { messages: result, phase: 'validated_project' };
}

module.exports = { phaseMessages, validatedProject };
