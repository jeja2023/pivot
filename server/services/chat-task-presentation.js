'use strict';

const { sanitizeUserVisibleText } = require('../llm');

const EVENT_TYPES = Object.freeze([
    'run.status_changed', 'run.paused', 'run.resumed', 'run.completed',
    'tool.requested', 'tool.started', 'tool.completed', 'tool.failed', 'tool.denied', 'tool.replayed',
    'sandbox.denied', 'transaction.denied', 'transaction.effect_staged',
    'approval.requested', 'approval.granted', 'approval.rejected', 'approval.auto_reviewed',
    'control.message_sent', 'control.message_acknowledged'
]);
const STATUS_LABELS = Object.freeze({
    queued: '等待执行', planning: '正在安排执行步骤', running: '正在处理任务', executing: '正在执行操作',
    observing: '正在检查操作结果', diagnosing: '正在检查异常原因', replanning: '正在调整处理方案',
    resuming: '正在恢复任务', verifying: '正在核验结果', needs_input: '等待补充信息或继续',
    approval_required: '等待操作授权', waiting_approval: '等待审批决定', awaiting_approval: '等待审批决定',
    awaiting_commit: '等待确认提交外部操作', completed: '任务已完成', completed_with_errors: '任务完成，部分步骤有异常',
    partial: '任务部分完成', error: '任务执行失败', failed: '任务执行失败', cancelled: '任务已停止', deleted: '任务不可用'
});
const TOOL_LABELS = Object.freeze({
    'terminal.runtime': '执行工作区操作', 'workspace.read': '读取工作区文件', 'workspace.list': '查看工作区文件',
    'workspace.patch': '修改工作区文件', 'workspace.install': '安装工作区依赖',
    'agent.code': '执行受控代码', 'agent.python': '运行数据分析', 'agent.llm': '分析资料',
    'agent.delegate': '处理子任务', 'agent.skill_search': '查找可用技能', 'agent.skill_describe': '读取技能说明',
    'system.observe': '检查运行环境', 'tool.search': '查找可用工具', 'tool.describe': '读取工具说明',
    'tools.search': '查找可用工具', 'tools.describe': '读取工具说明', 'tools.execute': '执行已选工具',
    'workflow.approval': '请求操作确认', 'workflow.delay': '等待指定时间', 'workflow.foreach': '处理多项数据',
    'document.render': '生成结果文档', 'artifact.render': '生成结果文件', 'artifact.deliver': '交付结果文件'
});

const PHASE_TITLES = Object.freeze({
    queued: '任务排队等待', planning: '安排执行步骤', running: '处理任务', executing: '执行操作',
    observing: '检查操作结果', diagnosing: '排查异常原因', replanning: '调整处理方案',
    resuming: '恢复任务执行', verifying: '核验执行结果', needs_input: '等待补充要求',
    approval_required: '等待操作授权', waiting_approval: '提交审批决定', awaiting_approval: '提交审批决定',
    awaiting_commit: '等待确认外部操作', completed: '任务已完成', completed_with_errors: '任务完成（部分步骤异常）',
    partial: '任务部分完成', error: '任务执行失败', failed: '任务执行失败', cancelled: '任务已停止', deleted: '任务不可用'
});

function parseObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (_) { return {}; }
}

function safeTaskText(value, limit = 320) {
    return sanitizeUserVisibleText(String(value ?? ''))
        .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9_.\-/+]{8,}/gi, '[凭据已隐藏]')
        .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
        .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s<>]+/gi, '[连接信息已隐藏]')
        .replace(/\bhttps?:\/\/[^\s<>]+/gi, url => url.replace(/\/\/[^/@\s]+:[^/@\s]+@/, '//[凭据已隐藏]@').replace(/[?#].*$/, ''))
        .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"|]+/g, '[本机路径]')
        .replace(/\/(?:home|root|Users|tmp|var|srv|opt|mnt)\/[^\s<>"']+/g, '[执行环境路径]')
        .trim().slice(0, limit);
}

function toolLabel(tool = '', input = {}) {
    const name = String(tool);
    if (name === 'terminal.runtime') return ({ read: '读取文件', list: '查看文件', write: '写入文件', exec: '运行命令' })[input.action] || TOOL_LABELS[name];
    if (TOOL_LABELS[name]) return TOOL_LABELS[name];
    if (/^(?:local\.|desktop\.|browser\.local)/.test(name)) return '执行本机操作';
    if (/browser/.test(name)) return '操作浏览器';
    if (/^(?:mcp\.\d+\.)?db\./.test(name)) return '查询业务数据';
    if (/search/.test(name)) return '检索相关资料';
    if (/read|fetch|get|list/.test(name)) return '读取所需资料';
    if (/render|export|artifact|document/.test(name)) return '生成结果文件';
    return '执行工具操作';
}

function executionLocation(tool = '', plan = {}) {
    if (/^(?:workspace\.|local\.|desktop\.)/.test(tool) || /local.*browser|browser.*local/.test(tool)) return '我的电脑';
    if (tool === 'terminal.runtime' || plan.sandboxRequired === true) return '隔离执行环境';
    if (/^mcp\./.test(tool) || /^api\.operation\./.test(tool)) return '外部服务';
    return '服务器';
}

function approvalSummary(pending) {
    const value = parseObject(pending);
    if (!value.tool) return null;
    const input = parseObject(value.input);
    const fields = [];
    for (const key of ['action', 'command', 'filename', 'fileName', 'format', 'deviceId', 'url']) {
        if (typeof input[key] === 'string') fields.push({ label: ({ action: '操作', command: '命令', filename: '文件', fileName: '文件', format: '格式', deviceId: '设备', url: '目标站点' })[key],
            value: key === 'command' && !/^[\w.-]{1,80}$/.test(input[key]) ? '完整命令请在任务详情中查看' : safeTaskText(input[key], 160) });
    }
    if (input.path || input.filePath || input.cwd) fields.push({ label: '文件范围', value: '受控授权目录内，完整范围可在任务详情中查看' });
    if (Array.isArray(input.args)) fields.push({ label: '命令参数', value: `共 ${input.args.length} 项，完整内容可在任务详情中查看` });
    return { title: value.tool !== 'terminal.runtime' && /[\u3400-\u9fff]/.test(String(value.title || '')) ? safeTaskText(value.title, 80) : toolLabel(value.tool, input), location: executionLocation(value.tool), fields,
        requestedAt: value.requestedAt || null, expiresAt: value.expiresAt || null,
        binding: { inputHash: String(value.inputHash || ''), key: String(value.key || ''), requestedAt: value.requestedAt || '' } };
}

function presentTaskEvent(row) {
    const payload = parseObject(row.payload);
    const type = String(row.event_type || '');
    if (!EVENT_TYPES.includes(type)) return null;
    const tool = String(payload.tool || '');
    const base = { id: `event:${row.id}`, seq: Number(row.event_seq), type, step: Number(row.step_index || 0),
        at: row.created_at, title: '', status: 'completed' };
    if (/^(?:tool\.|sandbox\.denied|transaction\.)/.test(type)) {
        const statuses = { 'tool.requested': 'preparing', 'tool.started': 'running', 'tool.completed': 'completed',
            'tool.replayed': 'reused', 'transaction.effect_staged': 'staged', 'tool.denied': 'denied', 'sandbox.denied': 'denied', 'transaction.denied': 'denied' };
        const attempt = Math.max(1, Number(payload.attempt || 1));
        return { ...base, kind: 'tool', operationId: `${String(payload.operationKey || base.id)}:attempt:${attempt}`, attempt,
            title: tool !== 'terminal.runtime' && /[\u3400-\u9fff]/.test(String(payload.toolTitle || '')) ? safeTaskText(payload.toolTitle, 80) : toolLabel(tool, { action: payload.action }),
            location: executionLocation(tool, parseObject(payload.executionPlan)),
            status: payload.outcomeMayBeUncertain ? 'uncertain' : statuses[type] || 'failed', durationMs: Math.max(0, Number(payload.durationMs || 0)),
            detail: payload.outcomeMayBeUncertain ? '操作结果尚未确认，请核实后再决定是否重试。'
                : safeTaskText(payload.errorMessage || payload.resultSummary || (type === 'tool.replayed' ? '复用已完成结果，未重复执行。' : type === 'transaction.effect_staged' ? '已准备外部操作，尚未提交执行。' : '')) };
    }
    if (type.startsWith('approval.')) return { ...base, kind: 'approval',
        title: ({ 'approval.requested': '已请求操作授权', 'approval.granted': '操作授权已确认', 'approval.rejected': '用户拒绝了操作', 'approval.auto_reviewed': '已通过受控操作检查' })[type],
        status: type === 'approval.requested' ? 'waiting' : type === 'approval.rejected' ? 'rejected' : 'completed' };
    if (type.startsWith('control.')) return { ...base, kind: 'control',
        title: type === 'control.message_sent' ? (payload.messageType === 'steer' ? '已收到补充要求，将在下一次规划前处理' : '已收到任务控制指令') : '任务补充或控制指令已处理' };
    if (type === 'run.status_changed' && payload.from && payload.to === payload.from) return null;
    const status = String(payload.to || '');
    return { ...base, kind: 'phase', title: PHASE_TITLES[status] || STATUS_LABELS[status] || '任务状态已更新',
        status: ['error', 'failed'].includes(status) ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed' };
}

function presentLegacyStep(step) {
    const type = String(step.type || '');
    return { id: `step:${step.id}`, seq: 0, legacyStepId: Number(step.id), kind: type === 'tool' ? 'tool' : 'phase',
        operationId: `legacy:${step.id}`, title: type === 'tool' ? toolLabel(step.tool_name)
            : type === 'plan' ? '已生成执行安排' : type === 'approval' ? '操作授权记录' : '任务处理记录',
        status: ['error', 'failed'].includes(step.status) ? 'failed' : 'completed',
        durationMs: Math.max(0, Number(step.duration_ms || 0)), at: step.completed_at || step.created_at,
        location: type === 'tool' ? executionLocation(step.tool_name) : '', detail: '' };
}

module.exports = { EVENT_TYPES, STATUS_LABELS, parseObject, safeTaskText, toolLabel, executionLocation, approvalSummary, presentTaskEvent, presentLegacyStep };
