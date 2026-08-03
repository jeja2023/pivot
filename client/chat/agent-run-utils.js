// Agent 运行通用工具 Agent run utils
// Split from agent-run-renderers.js.
// Agent run shared labels and formatting helpers.
/* eslint-disable no-undef */
function ensureAgentRunTitleTooltip() {
    if (agentRunTitleTooltipEl?.isConnected) return agentRunTitleTooltipEl;
    agentRunTitleTooltipEl = document.createElement('div');
    agentRunTitleTooltipEl.className = 'agent-run-title-tooltip hidden';
    agentRunTitleTooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(agentRunTitleTooltipEl);
    return agentRunTitleTooltipEl;
}

function positionAgentRunTitleTooltip(target) {
    if (!agentRunTitleTooltipEl || !target) return;
    const rect = target.getBoundingClientRect();
    const tooltipRect = agentRunTitleTooltipEl.getBoundingClientRect();
    const gap = 8;
    const viewportPadding = 12;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding);
    const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
    let top = rect.bottom + gap;
    if (top + tooltipRect.height > window.innerHeight - viewportPadding) {
        top = Math.max(viewportPadding, rect.top - tooltipRect.height - gap);
    }
    agentRunTitleTooltipEl.style.left = `${Math.round(left)}px`;
    agentRunTitleTooltipEl.style.top = `${Math.round(top)}px`;
}

function showAgentRunTitleTooltip(target) {
    const text = target?.dataset?.agentRunTitleFull || '';
    if (!text) return;
    const tooltip = ensureAgentRunTitleTooltip();
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    agentRunTitleTooltipTarget = target;
    positionAgentRunTitleTooltip(target);
}

function hideAgentRunTitleTooltip(target = null) {
    if (target && target !== agentRunTitleTooltipTarget) return;
    agentRunTitleTooltipEl?.classList.add('hidden');
    agentRunTitleTooltipTarget = null;
}

function translateAgentNotificationText(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    [
        [/\bDAG\s+run\s+completed\b/gi, '工作流运行完成'],
        [/\bDAG\s+run\s+(?:failed|failure)\b/gi, '工作流运行失败'],
        [/\bDAG\s+run\s+error\b/gi, '工作流运行异常'],
        [/\bagent\s+run\s+completed\b/gi, '任务运行完成'],
        [/\bagent\s+run\s+cancelled\b/gi, '任务运行已停止'],
        [/\bagent\s+approval\s+rejected\b/gi, '审批未通过'],
        [/\bagent\s+run\s+requires\s+tool\s+approval\b/gi, '任务需要审批']
    ].forEach(([pattern, replacement]) => {
        text = text.replace(pattern, replacement);
    });
    return text;
}

function agentNotificationTitle(item) {
    const title = String(item?.title || '').trim();
    const translatedText = translateAgentNotificationText(title);
    if (translatedText && translatedText !== title) return translatedText;
    const normalizedTitle = title.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const translatedTitle = {
        'dag run completed': '工作流运行完成',
        'dag run failed': '工作流运行失败',
        'dag run error': '工作流运行异常',
        'agent run completed': '任务运行完成',
        'agent run cancelled': '任务运行已停止',
        'agent approval rejected': '审批未通过',
        'agent run requires tool approval': '任务需要审批'
    }[normalizedTitle];
    if (translatedTitle) return translatedTitle;
    if (!agentLooksLikeCorruptTitle(title)) return title;
    const body = String(item?.body || '').trim();
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return '任务通知';
}

function agentNotificationBody(item) {
    const body = String(item?.body || item?.created_at || '').trim();
    const translatedBody = translateAgentNotificationText(body);
    if (translatedBody && translatedBody !== body) return agentShortText(translatedBody, 72);
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return item?.created_at || '任务状态已更新';
}

function agentStatusLabel(status) {
    const map = {
        queued: '排队中',
        running: '运行中',
        completed: '已完成',
        completed_with_errors: '完成但有错误',
        error: '失败',
        cancelled: '已停止',
        approval_required: '待审批'
    };
    return map[status] || status || '-';
}

function isAgentRunActive(status) {
    return status === 'queued' || status === 'running' || status === 'approval_required';
}

function agentRunModeLabel(mode) {
    const map = { standard: '标准模式', deep: '深度模式', audit: '审查模式', dag: '工作流' };
    return map[mode] || '标准模式';
}

function agentToolPolicyLabel(policy) {
    return policy === 'builtin_only' ? '仅系统工具' : '系统 + 工具库';
}

function agentDownload(url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function formatAgentTokenUsage(run) {
    const total = Number(run?.total_tokens || 0);
    if (!total) return '';
    return `Token ${total}（入 ${Number(run.input_tokens || 0)} / 出 ${Number(run.output_tokens || 0)}）`;
}

function formatAgentCompactCount(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return '0';
    const units = [
        { value: 1_000_000_000, suffix: 'B' },
        { value: 1_000_000, suffix: 'M' },
        { value: 1_000, suffix: 'K' }
    ];
    const unit = units.find(item => Math.abs(num) >= item.value);
    if (!unit) return String(Math.round(num));
    const scaled = num / unit.value;
    const digits = Math.abs(scaled) >= 100 ? 0 : 1;
    return `${scaled.toFixed(digits).replace(/\.0$/, '')}${unit.suffix}`;
}

const formatAgentAuditDate = (dateStr) => {
    if (!dateStr) return '-';
    if (typeof formatDateToCN === 'function') return formatDateToCN(dateStr);
    return String(dateStr);
};

function buildAgentRunTaskTooltip(run, title, mode, counts = {}) {
    const stepCount = Number(counts.stepCount || 0);
    const toolCount = Number(counts.toolCount || 0);
    const errorCount = Number(counts.errorCount || 0);
    const goal = String(run?.goal || '').trim();
    const lines = [
        `任务：${title || '-'}`,
        `状态：${agentStatusLabel(run?.status)}`,
        `创建时间：${formatAgentAuditDate(run?.created_at)}`,
        `开始时间：${formatAgentAuditDate(run?.started_at)}`,
        `完成时间：${formatAgentAuditDate(run?.completed_at)}`,
        `模型：${run?.model_name || '-'}`,
        `模式：${mode || '-'}`,
        `步骤数：${stepCount}`,
        `工具数：${toolCount}`,
        `错误数：${errorCount}`
    ];
    if (goal) lines.push(`目标：${goal}`);
    return lines.join('\n');
}

function agentShortText(value, max = 260) {
    const text = String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
}

function agentParsePayload(payload) {
    if (typeof payload !== 'string') return payload;
    const text = payload.trim();
    if (!text) return '';
    if (!text.startsWith('{') && !text.startsWith('[')) return text;
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
}

function agentSummarizeInput(input) {
    const payload = agentParsePayload(input);
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    const parts = [];
    if (payload.query) parts.push(`查询：${payload.query}`);
    if (payload.limit) parts.push(`数量：${payload.limit}`);
    if (payload.topK) parts.push(`Top K：${payload.topK}`);
    if (payload.candidateLimit) parts.push(`候选：${payload.candidateLimit}`);
    return parts.join(' · ') || agentShortText(JSON.stringify(payload));
}

function agentReadableCell(value) {
    if (value === undefined || value === null || value === '') return '-';
    if (typeof value === 'object') {
        if (typeof agentResultObjectSummary === 'function') return agentResultObjectSummary(value, 2);
        if (Array.isArray(value)) return agentShortText(value.map(item => String(item ?? '')).join('、'), 80);
        return Object.entries(value).slice(0, 2).map(([key, item]) => `${key}：${String(item ?? '-')}`).join(' · ') || '-';
    }
    return agentShortText(value, 80);
}

function agentRowsFromStructuredPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.result)) return payload.result;
    return [];
}
