// Agent 运行通用工具 Agent run utils
// Split from agent-run-renderers.js.
// 智能体运行共享标签与格式化辅助工具
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
        awaiting_approval: '等待审批',
        approval_required: '待审批',
        waiting_approval: '待审批',
        queued: '排队中',
        planning: '规划中',
        executing: '执行中',
        observing: '观察中',
        diagnosing: '诊断中',
        replanning: '重规划中',
        resuming: '恢复中',
        pending: '待执行',
        running: '运行中',
        completed: '已完成',
        completed_with_errors: '完成但有错误',
        continued_error: '失败后继续',
        issues_found: '存在问题',
        passed: '未发现问题',
        incomplete: '未完整处理',
        success: '成功',
        error: '失败',
        failed: '失败',
        cancelled: '已停止',
        skipped: '已跳过',
        deleted: '已删除'
    };
    return map[String(status || '').trim().toLowerCase()] || status || '-';
}

function isAgentRunActive(status) {
    return status === 'queued' || status === 'running' || status === 'approval_required' || status === 'awaiting_approval' || status === 'waiting_approval';
}

function agentRunModeLabel(mode) {
    const map = {
        standard: '标准模式',
        deep: '深度模式',
        audit: '审查模式',
        dag: '工作流',
        free: '自主任务',
        scheduled: '计划任务'
    };
    return map[String(mode || '').trim().toLowerCase()] || '标准模式';
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
    return `模型用量 ${total}（输入 ${Number(run.input_tokens || 0)} / 输出 ${Number(run.output_tokens || 0)}）`;
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

function buildAgentRunTaskTooltip(_run, title, _mode, _counts = {}) {
    return String(title || '').trim() || '-';
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
    let candidate = payload.trim();
    if (!candidate) return '';
    for (let depth = 0; depth < 3; depth += 1) {
        if (!candidate.startsWith('{') && !candidate.startsWith('[') && !candidate.startsWith('"')) return candidate;
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed !== 'string') return parsed;
            const next = parsed.trim();
            if (!next || next === candidate) return parsed;
            candidate = next;
        } catch (e) {
            return candidate;
        }
    }
    return candidate;
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
