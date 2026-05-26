/* Agent and MCP workbench */
let agentRunsCache = [];
let agentRefreshTimer = null;
let activeAgentRunId = '';
let agentToolsCache = [];
let agentTemplatesCache = [];
let agentSchedulesCache = [];
let agentArtifactsCache = [];
let capabilityPackagesCache = [];
let agentRealtimeSource = null;
let agentRealtimeConnected = false;
let agentRealtimeRefreshTimer = null;
let activeAgentConfigSection = '';
let agentRunsPage = 1;
let agentRunsTotal = 0;
const AGENT_RUNS_PAGE_SIZE = 10;
const AGENT_WORKFLOW_DRAFT_KEY = 'pivot.agent.workflow.draft';
const AGENT_WORKFLOW_SAVED_KEY = 'pivot.agent.workflow.saved';

const agentEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));

function agentLooksLikeCorruptTitle(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (/^[?\uFFFD\s._-]+$/.test(text) && /[?\uFFFD]{3,}/.test(text)) return true;
    const questionCount = (text.match(/[?\uFFFD]/g) || []).length;
    return questionCount >= 3 && questionCount / Math.max(text.length, 1) > 0.55;
}

function agentDisplayTitle(item) {
    const title = String(item?.title || '').trim();
    const goal = String(item?.goal || '').trim();
    if (!agentLooksLikeCorruptTitle(title)) return title;
    return goal || '智能体任务';
}

function agentNotificationTitle(item) {
    const title = String(item?.title || '').trim();
    if (!agentLooksLikeCorruptTitle(title)) return title;
    const body = String(item?.body || '').trim();
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return '智能体通知';
}

function agentNotificationBody(item) {
    const body = String(item?.body || item?.created_at || '').trim();
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return item?.created_at || '任务状态已更新';
}

function agentStatusLabel(status) {
    const map = {
        queued: '排队中',
        running: '运行中',
        completed: '已完成',
        error: '失败',
        cancelled: '已停止',
        approval_required: '待审批'
    };
    return map[status] || status || '-';
}

function isAgentRunActive(status) {
    return status === 'queued' || status === 'running' || status === 'approval_required';
}

function agentRunMeta(run) {
    const parts = [];
    if (run.model_name) parts.push(`模型 ${run.model_name}`);
    if (run.run_mode) parts.push(agentRunModeLabel(run.run_mode));
    if (run.tool_policy === 'builtin_only') parts.push('仅系统工具');
    if (Number(run.tool_count || 0) > 0) parts.push(`工具 ${run.tool_count}`);
    if (Number(run.error_count || 0) > 0) parts.push(`错误 ${run.error_count}`);
    if (Number(run.step_count || 0) > 0) parts.push(`步骤 ${run.step_count}`);
    return parts.join(' · ');
}

function agentRunTooltip(run) {
    const lines = [];
    const title = agentDisplayTitle(run);
    const goal = run.goal || '';
    const meta = agentRunMeta(run);
    if (title) lines.push(`标题：${title}`);
    lines.push(`状态：${agentStatusLabel(run.status)}`);
    if (run.created_at) lines.push(`创建时间：${formatDateToCN(run.created_at)}`);
    if (run.started_at) lines.push(`开始时间：${formatDateToCN(run.started_at)}`);
    if (run.completed_at) lines.push(`完成时间：${formatDateToCN(run.completed_at)}`);
    if (meta) lines.push(`详情：${meta}`);
    if (goal && goal !== title) lines.push(`目标：${goal}`);
    return lines.join('\n');
}

function agentRunModeLabel(mode) {
    const map = { standard: '标准模式', deep: '深度模式', audit: '审查模式', dag: '工作流编排' };
    return map[mode] || '标准模式';
}

function agentToolPolicyLabel(policy) {
    return policy === 'builtin_only' ? '仅系统工具' : '系统 + 能力库';
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

function agentStepPreview(step) {
    const payload = agentParsePayload(step.output || step.input || {});
    if (typeof payload === 'string') return agentShortText(payload, 500);
    if (Array.isArray(payload)) return `返回 ${payload.length} 条结果。`;
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    if (payload.answer) return payload.answer;
    if (payload.error) return payload.error;
    if (payload.thought || payload.action) {
        const lines = [];
        if (payload.thought) lines.push(`判断：${agentShortText(payload.thought, 220)}`);
        if (payload.action === 'tool') lines.push(`动作：调用 ${agentToolTitle(payload.tool)}`);
        if (payload.action === 'final') lines.push('动作：生成最终结果');
        if (payload.input) lines.push(`参数：${agentSummarizeInput(payload.input)}`);
        return lines.join('\n') || '已完成一次规划。';
    }
    if (Array.isArray(payload.matches)) {
        const scores = payload.matches
            .map(item => Number(item.score))
            .filter(score => Number.isFinite(score));
        const best = scores.length ? `，最高相关度 ${Math.max(...scores).toFixed(3)}` : '';
        const named = payload.matches.find(item => item.name || item.source || item.document_name);
        const source = named ? `，来源：${agentShortText(named.name || named.source || named.document_name, 80)}` : '';
        return `返回 ${payload.matches.length} 条匹配结果${best}${source}。`;
    }
    if (Array.isArray(payload.documents)) return `返回 ${payload.documents.length} 个知识库文档。`;
    if (Array.isArray(payload.sessions)) return `返回 ${payload.sessions.length} 条会话记录。`;
    if (Array.isArray(payload.models)) return `返回 ${payload.models.length} 个可用模型。`;
    if (payload.query) return `查询：${payload.query}`;
    if (payload.status) return `状态：${payload.status}`;
    return agentShortText(JSON.stringify(payload), 500);
}

function normalizeAgentMarkdown(text) {
    return String(text || '')
        .replace(/\*\*([^*\n]+?)：\s+\*\*/g, '**$1：**')
        .replace(/\*\*([^*\n]+?):\s+\*\*/g, '**$1:**');
}

function agentStepRawDetail(step, preview) {
    const payload = step.output || step.input;
    if (payload === undefined || payload === null) return '';
    const raw = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload, null, 2);
    if (!raw || raw === preview) return '';
    return raw.length > 5000 ? `${raw.slice(0, 5000)}\n...` : raw;
}

function agentStepMarkup(step) {
    const preview = normalizeAgentMarkdown(agentStepPreview(step));
    const raw = agentStepRawDetail(step, preview);
    return `
        <div class="agent-step ${agentEscape(step.status)}">
            <div class="agent-step-head">
                <strong>${step.step_index}. ${agentEscape(agentStepTitle(step))}</strong>
                <span>${agentEscape(agentToolTitle(step.tool_name || step.type))} · ${Number(step.duration_ms || 0)} 毫秒</span>
            </div>
            <div class="agent-step-body">${renderMarkdown(agentEscape(preview))}</div>
            ${raw ? `<details class="agent-step-raw"><summary>查看原始数据</summary><pre>${agentEscape(raw)}</pre></details>` : ''}
        </div>
    `;
}

// 任务历史可视化：水平时间轴 + 工具调用频次榜
function buildAgentTimelineMarkup(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '';
    const durations = steps.map(s => Math.max(Number(s.duration_ms || 0), 0));
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    // 当所有 duration 都是 0（异步任务还没记录）时，按等宽切分
    const segments = steps.map((step, idx) => {
        const dur = durations[idx];
        const ratio = totalDuration > 0 ? (dur / totalDuration) : (1 / steps.length);
        const width = Math.max(ratio * 100, 1.5); // 至少 1.5%，保证窄段也可见
        const type = String(step.type || '').toLowerCase();
        const status = String(step.status || '').toLowerCase();
        const title = `${step.step_index}. ${(step.tool_name || step.type || '步骤')} · ${dur} ms${status === 'error' ? ' · 失败' : ''}`;
        return `<div class="agent-timeline-seg agent-timeline-type-${agentEscape(type)} ${status === 'error' ? 'is-error' : ''}" style="flex: ${width.toFixed(2)} 0 0%" title="${agentEscape(title)}" aria-label="${agentEscape(title)}">
            <span class="agent-timeline-seg-label">${step.step_index}</span>
        </div>`;
    }).join('');
    const legend = [
        { type: 'plan', label: '规划' },
        { type: 'tool', label: '工具' },
        { type: 'control', label: '控制' },
        { type: 'approval', label: '审批' }
    ].map(item => `<span class="agent-timeline-legend-item"><i class="agent-timeline-legend-swatch agent-timeline-type-${item.type}"></i>${item.label}</span>`).join('');
    return `
        <section class="agent-timeline">
            <header class="agent-timeline-head">
                <strong>任务时间轴</strong>
                <span class="agent-timeline-legend">${legend}<span class="agent-timeline-legend-item is-error"><i class="agent-timeline-legend-swatch is-error"></i>失败步骤</span></span>
            </header>
            <div class="agent-timeline-bar" role="list">${segments}</div>
            <footer class="agent-timeline-foot">${steps.length} 步 · 总耗时 ${totalDuration} ms</footer>
        </section>
    `;
}

function buildAgentToolStatsMarkup(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '';
    const toolSteps = steps.filter(s => String(s.type || '').toLowerCase() === 'tool' && s.tool_name);
    if (toolSteps.length === 0) return '';
    const stats = new Map();
    toolSteps.forEach(step => {
        const name = String(step.tool_name);
        const entry = stats.get(name) || { name, count: 0, errors: 0, durationMs: 0 };
        entry.count += 1;
        entry.durationMs += Math.max(Number(step.duration_ms || 0), 0);
        if (String(step.status || '').toLowerCase() === 'error') entry.errors += 1;
        stats.set(name, entry);
    });
    const ranked = [...stats.values()].sort((a, b) => b.count - a.count || b.durationMs - a.durationMs);
    const maxCount = ranked[0].count || 1;
    const rows = ranked.map(entry => {
        const widthPct = Math.max(4, (entry.count / maxCount) * 100);
        const avg = entry.count > 0 ? Math.round(entry.durationMs / entry.count) : 0;
        return `
            <div class="agent-tool-stat-row ${entry.errors > 0 ? 'has-error' : ''}">
                <span class="agent-tool-stat-name" title="${agentEscape(entry.name)}">${agentEscape(entry.name)}</span>
                <div class="agent-tool-stat-bar"><div class="agent-tool-stat-bar-fill" style="width:${widthPct.toFixed(1)}%"></div></div>
                <span class="agent-tool-stat-count">${entry.count} 次</span>
                <span class="agent-tool-stat-extra">${entry.durationMs} ms · 均 ${avg} ms${entry.errors > 0 ? ` · <em>${entry.errors} 失败</em>` : ''}</span>
            </div>
        `;
    }).join('');
    return `
        <section class="agent-tool-stats">
            <header class="agent-tool-stats-head"><strong>工具调用统计</strong><span>${ranked.length} 种工具 · 共 ${toolSteps.length} 次调用</span></header>
            <div class="agent-tool-stats-list">${rows}</div>
        </section>
    `;
}

function agentProgressLabel(run = {}, progress = {}) {
    const stepCount = Number(progress.stepCount || 0);
    const maxSteps = Number(progress.maxSteps || run.max_steps || 0);
    if (isAgentRunActive(run.status)) {
        if (progress.isLimitReached && maxSteps > 0) return `已执行 ${stepCount} 步（已达上限 ${maxSteps} 步）`;
        return maxSteps > 0 ? `已执行 ${stepCount} 步（上限 ${maxSteps} 步）` : `已执行 ${stepCount} 步`;
    }
    return `已执行 ${stepCount} 步`;
}

function agentDagNodeMarkup(node) {
    const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
    const output = node.output ? (typeof node.output === 'string' ? node.output : JSON.stringify(node.output, null, 2)) : '';
    return `
        <div class="agent-dag-node ${agentEscape(node.status)}">
            <div class="agent-dag-node-head">
                <strong>${agentEscape(node.title || node.node_key)}</strong>
                <span>${agentEscape(node.status || 'pending')} · ${agentEscape(agentToolTitle(node.tool_name))}</span>
            </div>
            ${deps.length ? `<small>依赖：${agentEscape(deps.join(', '))}</small>` : ''}
            ${node.error_message ? `<div class="error-detail">${agentEscape(node.error_message)}</div>` : ''}
            ${output ? `<details><summary>节点输出</summary><pre>${agentEscape(agentShortText(output, 3000))}</pre></details>` : ''}
        </div>
    `;
}

function agentModelCapabilityMarkup(model) {
    const textIcon = '<span class="cap-icon text" title="文本模型"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>';
    if (!model) return textIcon;
    const hasVision = Number(model.supports_vision || 0) === 1 || model.capabilities?.includes?.('vision');
    const hasReasoning = Number(model.supports_reasoning || 0) === 1 || model.capabilities?.includes?.('reasoning');
    const icons = [textIcon];
    if (hasVision) icons.push('<span class="cap-icon vision" title="支持视觉输入"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    if (hasReasoning) icons.push('<span class="cap-icon reasoning" title="支持推理/思考"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    return icons.join('');
}

function updateAgentModelCaps() {
    const select = document.getElementById('agent-model-select');
    const caps = document.getElementById('agent-selected-model-caps');
    const name = document.getElementById('agent-selected-model-name');
    if (!select || !caps || !name) return;
    const model = (window._cachedAgentModels || []).find(item => String(item.id) === String(select.value));
    name.textContent = model ? `${model.name}${model.user_id ? ' (个人)' : ''}` : '请选择模型';
    caps.innerHTML = agentModelCapabilityMarkup(model);
}

function setAgentModelListOpen(open) {
    const trigger = document.getElementById('agent-model-trigger');
    const list = document.getElementById('agent-model-list');
    if (!trigger || !list) return;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    list.classList.toggle('hidden', !open);
}

function selectAgentModel(id, close = true) {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    select.value = id;
    updateAgentModelCaps();
    document.querySelectorAll('[data-agent-model-id]').forEach(item => {
        const active = String(item.dataset.agentModelId) === String(id);
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (close) setAgentModelListOpen(false);
}

const agentToolDisplayMap = {
    'rag.search': { title: '知识库检索', description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。' },
    'sessions.search': { title: '会话检索', description: '按关键词检索当前用户的历史会话内容。' },
    'sessions.recent': { title: '最近会话', description: '列出当前用户最近的未删除会话。' },
    'knowledge.list': { title: '知识库文档', description: '列出当前用户的知识库文档及索引状态。' },
    'models.list': { title: '可用模型', description: '列出当前用户可以使用的模型。' },
    'system.health': { title: '系统健康', description: '查看数据库、存储、内存和磁盘健康状态。' },
    'system.modelRuntime': { title: '模型运行状态', description: '查看模型端点队列、熔断器和监控状态。' }
};

function agentToolTitle(tool) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    if (String(name || '').startsWith('mcp.')) {
        return tool?.title || String(name).replace(/^mcp\.[^.]+\./, '') || '工具';
    }
    return tool?.title || agentToolDisplayMap[name]?.title || name || '工具';
}

function agentToolDescription(tool) {
    if (String(tool?.name || '').startsWith('mcp.')) return '来自已保存的能力服务，可由智能体任务按需调用。';
    return agentToolDisplayMap[tool?.name]?.description || tool?.description || '';
}

function agentCleanCapabilityName(name) {
    return String(name || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function agentCapabilityTypeLabel(type) {
    if (type === 'builtin_tool') return '系统工具';
    if (type === 'database_connection') return '数据库连接';
    return '能力服务';
}

function isAdminOnlyAgentTool(tool) {
    return Boolean(tool?.admin) || String(tool?.name || '').startsWith('system.');
}

function agentStepTitle(step) {
    const raw = step?.title || step?.type || '';
    if (raw === 'Planning') return '规划下一步';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    return raw || '执行步骤';
}

async function loadAgentModels() {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    const loaded = typeof window.loadSelectableModels === 'function'
        ? await window.loadSelectableModels()
        : { models: [], defaultModelId: '' };
    const defaultModelId = loaded.defaultModelId || '';
    const nextModels = (loaded.models || []).filter(model => model.type !== 'embedding');
    window._cachedAgentModels = nextModels;
    select.innerHTML = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
            const meta = [];
            meta.push(model.user_id ? '个人模型' : '全局模型');
            if (model.model_name && model.model_name !== model.name) meta.push(model.model_name);
            const title = typeof describeSelectorModel === 'function' ? describeSelectorModel(model, false) : model.name;
            return `
                <button type="button" role="option" class="agent-model-option" data-agent-model-id="${agentEscape(model.id)}" title="${agentEscape(title)}">
                    <span>
                        <strong>${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</strong>
                        <small>${agentEscape(meta.join(' · '))}</small>
                    </span>
                    <span class="agent-model-caps">${agentModelCapabilityMarkup(model)}</span>
                </button>
            `;
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
        list.querySelectorAll('[data-agent-model-id]').forEach(item => {
            item.addEventListener('click', () => selectAgentModel(item.dataset.agentModelId));
        });
    }
    const trigger = document.getElementById('agent-model-trigger');
    if (trigger && trigger.dataset.agentModelBound !== '1') {
        trigger.dataset.agentModelBound = '1';
        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            setAgentModelListOpen(document.getElementById('agent-model-list')?.classList.contains('hidden'));
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#agent-model-picker')) setAgentModelListOpen(false);
        });
    }
    if (select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    const mainSelectedId = document.getElementById('model-selector')?.value || '';
    const initialId = (mainSelectedId && nextModels.some(model => String(model.id) === String(mainSelectedId)))
        ? mainSelectedId
        : (defaultModelId && nextModels.some(model => String(model.id) === String(defaultModelId)))
            ? defaultModelId
            : (nextModels[0]?.id || '');
    if (nextModels.length) select.value = initialId;
    selectAgentModel(select.value || initialId, false);
}

async function _loadAgentModelsLegacy() {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    const res = await apiFetch(`${API_BASE}/models/available`);
    if (!res.ok) throw new Error('智能体模型列表加载失败');
    const nextModels = (await res.json()).filter(model => model.type !== 'embedding');
    window._cachedAgentModels = nextModels;
    select.innerHTML = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
            const meta = [];
            meta.push(model.user_id ? '个人模型' : '全局模型');
            if (model.model_name && model.model_name !== model.name) meta.push(model.model_name);
            const title = typeof describeSelectorModel === 'function' ? describeSelectorModel(model, false) : model.name;
            return `
                <button type="button" role="option" class="agent-model-option" data-agent-model-id="${agentEscape(model.id)}" title="${agentEscape(title)}">
                    <span>
                        <strong>${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</strong>
                        <small>${agentEscape(meta.join(' · '))}</small>
                    </span>
                    <span class="agent-model-caps">${agentModelCapabilityMarkup(model)}</span>
                </button>
            `;
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
        list.querySelectorAll('[data-agent-model-id]').forEach(item => {
            item.addEventListener('click', () => selectAgentModel(item.dataset.agentModelId));
        });
    }
    const trigger = document.getElementById('agent-model-trigger');
    if (trigger && trigger.dataset.agentModelBound !== '1') {
        trigger.dataset.agentModelBound = '1';
        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            setAgentModelListOpen(document.getElementById('agent-model-list')?.classList.contains('hidden'));
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#agent-model-picker')) setAgentModelListOpen(false);
        });
    }
    if (select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    if (nextModels.length && !select.value) select.value = nextModels[0].id;
    selectAgentModel(select.value || nextModels[0]?.id || '', false);
}

async function loadAgentTools() {
    const list = document.getElementById('agent-tool-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const seenToolKeys = new Set();
    const visibleTools = (data.tools || [])
        .filter(tool => currentUser?.username === 'admin' || !isAdminOnlyAgentTool(tool))
        .filter(tool => {
            const key = String(tool?.name || `${tool?.source || ''}:${tool?.title || ''}:${tool?.description || ''}`);
            if (!key || seenToolKeys.has(key)) return false;
            seenToolKeys.add(key);
            return true;
        });
    agentToolsCache = visibleTools;
    mountAgentDagEditor();
    list.innerHTML = `
        ${visibleTools.map(tool => {
            const title = agentToolTitle(tool);
            const description = agentToolDescription(tool);
            const tags = [
                isAdminOnlyAgentTool(tool) ? '管理员' : '',
                tool.source === 'mcp' ? '能力库' : '系统',
                tool.requiresApproval ? '需审批' : ''
            ].filter(Boolean);
            const tooltip = [
                title,
                description,
                tags.length ? `标签：${tags.join(' / ')}` : ''
            ].filter(Boolean).join('\n');
            return `
            <label class="agent-tool-chip agent-tool-select ${isAdminOnlyAgentTool(tool) ? 'admin-tool' : ''}" title="${agentEscape(tooltip)}">
                <input type="checkbox" data-agent-tool-allow="${agentEscape(tool.name)}" checked>
                <strong>
                    ${agentEscape(title)}
                    ${tags.map(tag => `<em>${agentEscape(tag)}</em>`).join('')}
                </strong>
                <span>${agentEscape(description)}</span>
            </label>
        `;
        }).join('') || '<div class="empty-state">暂无可用能力</div>'}
    `;
}

async function loadCapabilityPackages() {
    const list = document.getElementById('agent-capability-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/capabilities/packages`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '能力市场加载失败');
    capabilityPackagesCache = data.data || [];
    const visible = capabilityPackagesCache.slice(0, 12);
    list.innerHTML = visible.length ? visible.map(item => `
        <label class="agent-capability-item ${item.enabled ? 'enabled' : 'disabled'}">
            <input type="checkbox" data-capability-key="${agentEscape(item.package_key)}" ${item.enabled ? 'checked' : ''}>
            <span>
                <strong>${agentEscape(agentCleanCapabilityName(item.name))}</strong>
                <small>${agentEscape(agentCapabilityTypeLabel(item.type))}</small>
            </span>
        </label>
    `).join('') : '<div class="empty-state compact">暂无能力包</div>';
    list.querySelectorAll('[data-capability-key]').forEach(input => {
        input.addEventListener('change', async () => {
            const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(input.dataset.capabilityKey)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: input.checked })
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) {
                input.checked = !input.checked;
                return showToast(result.error || '能力包状态更新失败', 'error');
            }
            showToast(input.checked ? '能力包已启用' : '能力包已停用', 'success');
            await loadAgentTools();
        });
    });
}

async function loadAgentRuntimeStatus() {
    const target = document.getElementById('agent-runtime-status');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/runtime`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>并发 ${Number(data.active || 0)} / ${Number(data.maxConcurrent || 0)}</span>
        <span>队列 ${Number(data.databaseQueued || data.queued || 0)}</span>
        <span>我的排队 ${Number(data.userQueued || 0)}</span>
    `;
}

async function loadAgentMetrics() {
    const target = document.getElementById('agent-metrics');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/metrics?days=7`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>7日任务 ${Number(data.total || 0)}</span>
        <span>成功率 ${Number(data.successRate || 0)}%</span>
        <span>失败 ${Number(data.error || 0)}</span>
        <span>Token ${agentEscape(formatAgentCompactCount(data.totalTokens || 0))}</span>
    `;
}

function renderAgentPreflight(data) {
    const target = document.getElementById('agent-preflight-panel');
    if (!target || !data) return;
    const statusText = data.status === 'blocked' ? '阻断' : data.status === 'warning' ? '有风险' : '可运行';
    const messages = [...(data.blockers || []), ...(data.warnings || []), ...(data.recommendations || [])].slice(0, 5);
    const summary = data.summary || {};
    target.className = `workspace-governance-panel agent-preflight-panel ${agentEscape(data.status || 'ready')}`;
    target.innerHTML = `
        <div class="governance-head">
            <strong>任务预检：${agentEscape(statusText)}</strong>
            <span>工具 ${Number(summary.toolCount || 0)} · 能力库 ${Number(summary.mcpToolCount || 0)} · 知识分块 ${Number(summary.knowledgeChunks || 0)}</span>
        </div>
        <div class="governance-list">
            ${messages.map(item => `<span>${agentEscape(item)}</span>`).join('') || '<span>预检通过。</span>'}
        </div>
    `;
}

async function preflightAgentPayload(payload) {
    const target = document.getElementById('agent-preflight-panel');
    if (target) {
        target.className = 'workspace-governance-panel agent-preflight-panel';
        target.innerHTML = '<div class="governance-head"><strong>任务预检中...</strong></div>';
    }
    const res = await apiFetch(`${API_BASE}/agents/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '任务预检失败');
    renderAgentPreflight(data);
    return data;
}

function renderAgentRunsPagination(page = agentRunsPage, total = agentRunsTotal, limit = AGENT_RUNS_PAGE_SIZE) {
    window.renderWorkspacePagination?.('pagination-agentRuns', {
        total,
        page,
        limit,
        onPageChange: targetPage => loadAgentRuns(targetPage).catch(err => showToast(err.message || '任务列表刷新失败', 'error'))
    });
}

async function loadAgentRuns(page = agentRunsPage) {
    const list = document.getElementById('agent-runs-list');
    if (!list) return;
    const status = document.getElementById('agent-filter-status')?.value || '';
    const query = document.getElementById('agent-filter-query')?.value.trim() || '';
    agentRunsPage = Math.max(Number(page) || 1, 1);
    const params = new URLSearchParams({
        page: String(agentRunsPage),
        limit: String(AGENT_RUNS_PAGE_SIZE)
    });
    if (status) params.set('status', status);
    if (query) params.set('query', query);
    const res = await apiFetch(`${API_BASE}/agents/runs?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务列表加载失败');
    agentRunsCache = data.data || [];
    agentRunsTotal = Number(data.total || agentRunsCache.length || 0);
    agentRunsPage = Number(data.page || agentRunsPage);
    const pageSize = Number(data.limit || AGENT_RUNS_PAGE_SIZE);
    if (agentRunsCache.length === 0 && agentRunsTotal > 0 && agentRunsPage > 1) {
        const lastPage = Math.max(Math.ceil(agentRunsTotal / pageSize), 1);
        return loadAgentRuns(Math.min(agentRunsPage - 1, lastPage));
    }
    updateAgentAutoRefresh();
    renderAgentRunsPagination(agentRunsPage, agentRunsTotal, pageSize);
    const displayRuns = agentRunsCache;
    if (agentRunsTotal === 0 && !status && !query) {
        list.innerHTML = '';
        activeAgentRunId = '';
        closeAgentRunDetailModal();
        list.innerHTML = `
            <div class="agent-empty-state agent-empty-hero">
                <strong>还没有智能体任务</strong>
                <span>在左侧输入目标并点击运行后，这里会显示任务记录。点击详情可查看执行步骤和最终结果。</span>
            </div>
        `;
        return;
    }
    if (displayRuns.length === 0) {
        list.innerHTML = '<div class="empty-state agent-empty-state">没有匹配的任务记录。</div>';
        return;
    }
    const hasSelectedRun = activeAgentRunId && displayRuns.some(run => run.id === activeAgentRunId);
    if (!hasSelectedRun && !isAgentRunDetailModalOpen()) activeAgentRunId = '';
    list.innerHTML = `
        <div class="agent-runs-table-wrap">
            <table class="data-table agent-runs-table">
                <thead>
                    <tr>
                        <th class="text-center">序号</th>
                        <th>任务</th>
                        <th>模型</th>
                        <th>模式</th>
                        <th>步骤</th>
                        <th>工具</th>
                        <th>错误</th>
                        <th>输入Token</th>
                        <th>输出Token</th>
                        <th>总Token</th>
                        <th>创建时间</th>
                        <th>状态</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${displayRuns.map((run, index) => {
        const title = agentDisplayTitle(run);
        const mode = agentRunModeLabel(run.run_mode);
        const tokenTotal = Number(run.total_tokens || 0);
        const inputTokens = Number(run.input_tokens || 0);
        const outputTokens = Number(run.output_tokens || 0);
        const stepCount = Number(run.step_count || 0);
        const toolCount = Number(run.tool_count || 0);
        const errorCount = Number(run.error_count || 0);
        const canDelete = !isAgentRunActive(run.status);
        return `
            <tr class="${run.id === activeAgentRunId ? 'active' : ''}" data-agent-run-id="${agentEscape(run.id)}">
                <td class="text-center">${(agentRunsPage - 1) * pageSize + index + 1}</td>
                <td class="agent-runs-title-cell" title="${agentEscape(agentRunTooltip(run))}">
                    <strong>${agentEscape(title)}</strong>
                </td>
                <td>
                    <strong class="agent-runs-compact">${agentEscape(run.model_name || '-')}</strong>
                </td>
                <td>${agentEscape(mode)}</td>
                <td>${stepCount || '-'}</td>
                <td>${toolCount}</td>
                <td>${errorCount}</td>
                <td>${inputTokens ? agentEscape(formatAgentCompactCount(inputTokens)) : '-'}</td>
                <td>${outputTokens ? agentEscape(formatAgentCompactCount(outputTokens)) : '-'}</td>
                <td>${tokenTotal ? agentEscape(formatAgentCompactCount(tokenTotal)) : '-'}</td>
                <td>${agentEscape(formatDateToCN(run.created_at))}</td>
                <td>
                    <span class="agent-run-status ${agentEscape(run.status)}">${agentStatusLabel(run.status)}</span>
                </td>
                <td>
                    <div class="agent-run-table-actions">
                        <button class="btn-secondary agent-run-detail-btn" type="button" data-agent-run-detail="${agentEscape(run.id)}">详情</button>
                        ${canDelete ? `<button class="btn-danger-outline agent-run-delete-btn" type="button" data-agent-run-delete="${agentEscape(run.id)}">删除</button>` : ''}
                    </div>
                </td>
            </tr>
    `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
    list.querySelectorAll('[data-agent-run-detail]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentRun(btn.dataset.agentRunDetail));
    });
    list.querySelectorAll('[data-agent-run-delete]').forEach(btn => {
        btn.addEventListener('click', () => window.deleteAgentRun(btn.dataset.agentRunDelete));
    });
}

function isAgentRunDetailModalOpen() {
    return !document.getElementById('agent-run-detail-modal')?.classList.contains('hidden');
}

function closeAgentRunDetailModal() {
    const modal = document.getElementById('agent-run-detail-modal');
    const detail = document.getElementById('agent-run-detail');
    modal?.classList.add('hidden');
    if (detail) detail.innerHTML = '';
    document.querySelectorAll('[data-agent-run-id]').forEach(row => row.classList.remove('active'));
    activeAgentRunId = '';
}

window.closeAgentRunDetailModal = closeAgentRunDetailModal;

window.openAgentRun = async function(runId) {
    activeAgentRunId = runId;
    const modal = document.getElementById('agent-run-detail-modal');
    const detail = document.getElementById('agent-run-detail');
    if (!detail) return;
    document.querySelectorAll('[data-agent-run-id]').forEach(row => {
        const active = row.dataset.agentRunId === runId;
        row.classList.toggle('active', active);
    });
    modal?.classList.remove('hidden');
    detail.innerHTML = '<div class="empty-state agent-empty-state">正在加载任务详情...</div>';
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (!res.ok) {
        detail.innerHTML = `<div class="empty-state agent-empty-state">${agentEscape(data.error || '加载失败')}</div>`;
        return;
    }
    const run = data.run;
    const steps = data.steps || [];
    const dagNodes = data.dagNodes || [];
    const progress = data.progress || {};
    const canCancel = isAgentRunActive(run.status);
    const canRerun = !isAgentRunActive(run.status);
    const canApprove = run.status === 'approval_required';
    const tokenUsage = formatAgentTokenUsage(run);
    const progressPercent = Math.max(0, Math.min(Number(progress.percent || 0), 100));
    const progressLabel = agentProgressLabel(run, progress);
    const title = document.getElementById('agent-run-detail-title');
    if (title) title.textContent = agentDisplayTitle(run);
    detail.innerHTML = `
        <div class="agent-progress-summary">
            <div class="agent-progress-bar"><span style="width: ${progressPercent}%"></span></div>
            <div class="agent-progress-meta">
                <span>${agentEscape(progressLabel)}</span>
                <span>工具 ${Number(progress.toolCount || 0)}</span>
                <span>错误 ${Number(progress.errorCount || 0)}</span>
                <span>耗时 ${Number(progress.totalDurationMs || 0)} 毫秒</span>
                <span>${agentEscape(agentRunModeLabel(run.run_mode))}</span>
                <span>${agentEscape(agentToolPolicyLabel(run.tool_policy))}</span>
                ${tokenUsage ? `<span>${agentEscape(tokenUsage)}</span>` : ''}
                ${canCancel ? `<button class="btn-danger-outline" data-agent-cancel="${agentEscape(run.id)}">停止</button>` : ''}
                ${canApprove ? `<button class="btn-primary" data-agent-approve="${agentEscape(run.id)}">批准工具</button><button class="btn-danger-outline" data-agent-reject="${agentEscape(run.id)}">拒绝</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-rerun="${agentEscape(run.id)}">重新运行</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-resume="${agentEscape(run.id)}">断点续跑</button>` : ''}
                ${run.final_answer || run.error_message ? `<button class="btn-secondary" data-agent-save-artifact="${agentEscape(run.id)}">保存结果</button>` : ''}
                <button class="btn-secondary" data-agent-export-md="${agentEscape(run.id)}">导出</button>
            </div>
        </div>
        ${run.final_answer ? `<div class="agent-final">${renderMarkdown(normalizeAgentMarkdown(run.final_answer))}</div>` : ''}
        ${run.error_message ? `<div class="error-detail">${agentEscape(run.error_message)}</div>` : ''}
        ${dagNodes.length ? `
            <div class="agent-dag-list">
                <div class="agent-tool-section-head compact">
                    <strong>工作流节点</strong>
                    <span>${dagNodes.length} 个节点</span>
                </div>
                ${dagNodes.map(node => agentDagNodeMarkup(node)).join('')}
            </div>
        ` : ''}
        ${buildAgentTimelineMarkup(steps)}
        ${buildAgentToolStatsMarkup(steps)}
        <div class="agent-step-list">
            ${steps.map(step => agentStepMarkup(step)).join('') || '<div class="empty-state agent-empty-state">任务还没有执行步骤。</div>'}
        </div>
    `;
    detail.querySelector('[data-agent-cancel]')?.addEventListener('click', () => window.cancelAgentRun(run.id));
    detail.querySelector('[data-agent-approve]')?.addEventListener('click', () => window.approveAgentRun(run.id, true));
    detail.querySelector('[data-agent-reject]')?.addEventListener('click', () => window.approveAgentRun(run.id, false));
    detail.querySelector('[data-agent-rerun]')?.addEventListener('click', () => window.rerunAgentRun(run.id));
    detail.querySelector('[data-agent-resume]')?.addEventListener('click', () => window.resumeAgentRun(run.id));
    detail.querySelector('[data-agent-save-artifact]')?.addEventListener('click', () => window.saveAgentArtifact(run.id));
    detail.querySelector('[data-agent-export-md]')?.addEventListener('click', () => agentDownload(`${API_BASE}/agents/runs/${encodeURIComponent(run.id)}/export?format=markdown`));
};

function ensureAgentAuditModal() {
    let modal = document.getElementById('agent-audit-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-audit-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>智能体删除审计</h3>
                    <p class="model-modal-desc">仅 admin 超级管理员可查看，普通用户移除的任务记录会保留在这里。</p>
                </div>
                <button type="button" id="agent-audit-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap agent-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 52px;" class="text-center">序号</th>
                            <th>任务</th>
                            <th style="width: 120px;">用户</th>
                            <th style="width: 90px;">状态</th>
                            <th style="width: 150px;">模型</th>
                            <th style="width: 115px;">统计</th>
                            <th style="width: 155px;">删除时间</th>
                            <th style="width: 120px;">删除人</th>
                        </tr>
                    </thead>
                    <tbody id="agent-audit-body"></tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#agent-audit-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function renderAgentAuditRows(items = []) {
    if (!items.length) {
        return '<tr><td colspan="8" class="text-center muted-text">暂无已移除的智能体任务记录</td></tr>';
    }
    return items.map((item, index) => {
        const userName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
        const deletedBy = item.deleted_by_nickname || item.deleted_by_username || `用户 ${item.deleted_by_user || '-'}`;
        const stats = `步骤 ${Number(item.step_count || 0)} / 工具 ${Number(item.tool_count || 0)} / 错误 ${Number(item.error_count || 0)}`;
        return `
            <tr>
                <td class="text-center">${index + 1}</td>
                <td title="${agentEscape(item.goal || item.title)}">
                    <strong>${agentEscape(agentDisplayTitle(item) || '-')}</strong>
                    <small>${agentEscape(agentShortText(item.goal || '', 90))}</small>
                </td>
                <td>${agentEscape(userName)}</td>
                <td>${agentEscape(agentStatusLabel(item.status))}</td>
                <td title="${agentEscape(item.model_name || '')}">${agentEscape(item.model_name || '-')}</td>
                <td>${agentEscape(stats)}</td>
                <td>${agentEscape(formatAgentAuditDate(item.deleted_at))}</td>
                <td>${agentEscape(deletedBy)}</td>
            </tr>
        `;
    }).join('');
}

function updateAgentAutoRefresh() {
    const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
    const hasActiveRun = agentRunsCache.some(run => isAgentRunActive(run.status));
    if (agentRealtimeConnected) {
        if (agentRefreshTimer) {
            clearInterval(agentRefreshTimer);
            agentRefreshTimer = null;
        }
        return;
    }
    if (agentRefreshTimer && (!modalOpen || !hasActiveRun)) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
    }
    if (!agentRefreshTimer && modalOpen && hasActiveRun) {
        agentRefreshTimer = setInterval(async () => {
            try {
                await loadAgentRuns();
                await loadAgentRuntimeStatus();
                await loadAgentMetrics();
                if (activeAgentRunId && isAgentRunDetailModalOpen()) await window.openAgentRun(activeAgentRunId);
            } catch (e) {}
        }, 3000);
    }
}

function scheduleAgentRealtimeRefresh(payload = {}) {
    clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = setTimeout(async () => {
        try {
            const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
            if (!modalOpen) return;
            await Promise.all([
                loadAgentRuns(),
                loadAgentRuntimeStatus(),
                loadAgentNotifications()
            ]);
            if (payload.type === 'agent.run') await loadAgentMetrics();
            const runId = payload.run?.id || payload.notification?.run_id || '';
            if (activeAgentRunId && isAgentRunDetailModalOpen() && (!runId || runId === activeAgentRunId)) {
                await window.openAgentRun(activeAgentRunId);
            }
        } catch (e) {}
    }, 300);
}

function handleAgentRealtimeEvent(event) {
    const payload = JSON.parse(event.data || '{}');
    if (payload.type === 'agent.notification' && payload.notification?.status === 'unread') {
        showToast(agentNotificationTitle(payload.notification) || '收到新的智能体通知', 'info');
    }
    scheduleAgentRealtimeRefresh(payload);
}

window.initAgentRealtime = function() {
    if (agentRealtimeSource || !window.EventSource || !currentUser) return;
    agentRealtimeSource = new EventSource(`${API_BASE}/events`);
    agentRealtimeSource.addEventListener('connected', () => {
        agentRealtimeConnected = true;
        updateAgentAutoRefresh();
    });
    agentRealtimeSource.addEventListener('agent.run', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.notification', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.streaming', handleAgentStreamingEvent);
    agentRealtimeSource.onerror = () => {
        agentRealtimeConnected = false;
        updateAgentAutoRefresh();
    };
};

// v0.0.52 流式 function calling 实时演示：把累加器快照渲染到任务详情面板
function handleAgentStreamingEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch (e) { return; }
    if (!payload || !payload.runId) return;
    // 只为当前打开的任务渲染，避免后台任务覆盖前台 UI
    if (activeAgentRunId !== payload.runId) return;
    renderAgentStreamingPanel(payload);
}

function renderAgentStreamingPanel(payload) {
    const container = document.getElementById('agent-run-detail');
    if (!container) return;
    let panel = container.querySelector('.agent-streaming-panel');
    if (!panel) {
        panel = document.createElement('section');
        panel.className = 'agent-streaming-panel';
        container.insertBefore(panel, container.firstChild || null);
    }
    const step = Number(payload.step) || 0;
    const finish = payload.finishReason ? agentEscape(payload.finishReason) : '—';
    const completed = Boolean(payload.completed);
    const content = String(payload.content || '');
    const partial = Array.isArray(payload.partialToolCalls) ? payload.partialToolCalls : [];
    const toolHtml = partial.length === 0
        ? '<div class="agent-streaming-empty">尚未发现工具调用增量</div>'
        : partial.map((call, idx) => {
            const name = agentEscape(call.name || `工具#${idx + 1}`);
            const argsLen = String(call.argumentsRaw || '').length;
            const preview = agentEscape(String(call.argumentsRaw || '').slice(0, 240));
            return `
                <div class="agent-streaming-tool">
                    <div class="agent-streaming-tool-head"><strong>${name}</strong><span>arguments ${argsLen} 字符</span></div>
                    <pre class="agent-streaming-tool-args">${preview}${argsLen > 240 ? '…' : ''}</pre>
                </div>
            `;
        }).join('');
    panel.innerHTML = `
        <header class="agent-streaming-head">
            <strong>流式生成（实验）</strong>
            <span>第 ${step} 步 · finish_reason: ${finish}${completed ? ' · 已完成' : ''}</span>
        </header>
        <div class="agent-streaming-body">
            <div class="agent-streaming-content">${agentEscape(content) || '<em>等待第一个 token…</em>'}</div>
            <div class="agent-streaming-tools">${toolHtml}</div>
        </div>
    `;
    // 任务终态时延迟收起面板：5s 后淡出，避免长期占据视野
    if (completed && payload.finishReason && payload.finishReason !== 'tool_calls') {
        setTimeout(() => panel?.classList.add('is-fading'), 5000);
    } else {
        panel.classList.remove('is-fading');
    }
}

window.closeAgentRealtime = function() {
    if (agentRealtimeRefreshTimer) clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = null;
    agentRealtimeConnected = false;
    if (agentRealtimeSource) {
        agentRealtimeSource.close();
        agentRealtimeSource = null;
    }
    updateAgentAutoRefresh();
};

function getSelectedAgentToolAllowlist() {
    const checked = [...document.querySelectorAll('[data-agent-tool-allow]:checked')].map(input => input.dataset.agentToolAllow);
    if (!checked.length) return ['__none__'];
    if (checked.length === agentToolsCache.length) return [];
    return checked;
}

function getAgentContextConfig() {
    return {
        mode: document.getElementById('agent-context-mode')?.value || 'auto',
        notes: document.getElementById('agent-context-notes')?.value || ''
    };
}

function getAgentWorkflowText() {
    return document.getElementById('agent-dag-spec')?.value.trim() || '';
}

function parseAgentWorkflowText(raw = getAgentWorkflowText()) {
    if (!raw) return { nodes: [] };
    return JSON.parse(raw);
}

function writeAgentWorkflowText(value) {
    const textarea = document.getElementById('agent-dag-spec');
    if (!textarea) return;
    textarea.value = typeof value === 'string' ? value : JSON.stringify(value || { nodes: [] }, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function persistAgentWorkflow(key, label) {
    const raw = getAgentWorkflowText();
    let parsed;
    try {
        parsed = parseAgentWorkflowText(raw);
    } catch (e) {
        showToast('工作流编排 JSON 格式不正确', 'error');
        return false;
    }
    try {
        localStorage.setItem(key, JSON.stringify({
            savedAt: new Date().toISOString(),
            spec: parsed
        }));
    } catch (e) {
        showToast(`${label}失败，浏览器存储不可用`, 'error');
        return false;
    }
    return true;
}

function restoreAgentWorkflowSnapshot() {
    const textarea = document.getElementById('agent-dag-spec');
    if (!textarea || textarea.value.trim()) return;
    const readSnapshot = (key) => {
        try {
            return JSON.parse(localStorage.getItem(key) || 'null');
        } catch (e) {
            return null;
        }
    };
    const saved = readSnapshot(AGENT_WORKFLOW_SAVED_KEY);
    const draft = readSnapshot(AGENT_WORKFLOW_DRAFT_KEY);
    const savedAt = saved?.savedAt ? Date.parse(saved.savedAt) : 0;
    const draftAt = draft?.savedAt ? Date.parse(draft.savedAt) : 0;
    const snapshot = draftAt > savedAt ? draft : saved;
    if (snapshot?.spec) writeAgentWorkflowText(snapshot.spec);
}

window.saveAgentWorkflowDraft = function() {
    if (persistAgentWorkflow(AGENT_WORKFLOW_DRAFT_KEY, '保存草稿')) {
        showToast('工作流草稿已保存', 'success');
    }
};

window.saveAgentWorkflow = function() {
    if (!persistAgentWorkflow(AGENT_WORKFLOW_SAVED_KEY, '保存工作流')) return;
    const runMode = document.getElementById('agent-run-mode');
    if (runMode) runMode.value = 'dag';
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
    } catch (e) {
        // ignore storage cleanup failures
    }
    showToast('工作流已保存，并设为智能体运行模式', 'success');
};

function getAgentRunPayload(goalOverride = '') {
    const goal = goalOverride || document.getElementById('agent-goal-input')?.value.trim();
    const allowMcp = document.getElementById('agent-allow-mcp')?.checked !== false;
    const runMode = document.getElementById('agent-run-mode')?.value || 'standard';
    const payload = {
        goal,
        modelId: document.getElementById('agent-model-select')?.value,
        maxSteps: document.getElementById('agent-max-steps')?.value || 10,
        runMode,
        toolPolicy: allowMcp ? 'all' : 'builtin_only',
        approvalPolicy: document.getElementById('agent-approval-policy')?.value || 'safe_mcp_auto',
        modelRouter: document.getElementById('agent-model-router')?.value || 'fixed',
        maxTokenBudget: document.getElementById('agent-token-budget')?.value || 0,
        retryLimit: document.getElementById('agent-retry-limit')?.value || 1,
        toolAllowlist: getSelectedAgentToolAllowlist(),
        contextConfig: getAgentContextConfig(),
        sessionId: window.currentSessionId || null
    };
    if (runMode === 'dag') {
        const rawDag = document.getElementById('agent-dag-spec')?.value.trim();
        if (rawDag) {
            try {
                payload.dagSpec = JSON.parse(rawDag);
            } catch (e) {
                showToast('工作流编排 JSON 格式不正确', 'error');
                payload._invalid = true;
            }
        } else {
            payload.dagSpec = { nodes: [] };
        }
    }
    return payload;
}

function applyAgentTemplate(template) {
    if (!template) return;
    const goalInput = document.getElementById('agent-goal-input');
    if (goalInput) goalInput.value = template.goal_template || '';
    const runMode = document.getElementById('agent-run-mode');
    if (runMode) runMode.value = template.run_mode || 'standard';
    const allowMcp = document.getElementById('agent-allow-mcp');
    if (allowMcp) allowMcp.checked = template.tool_policy !== 'builtin_only';
    const approval = document.getElementById('agent-approval-policy');
    if (approval) approval.value = template.approval_policy || 'safe_mcp_auto';
    const router = document.getElementById('agent-model-router');
    if (router) router.value = template.model_router || 'fixed';
    const steps = document.getElementById('agent-max-steps');
    if (steps) steps.value = template.max_steps || 10;
    const budget = document.getElementById('agent-token-budget');
    if (budget) budget.value = template.max_token_budget || '';
    const retry = document.getElementById('agent-retry-limit');
    if (retry) retry.value = template.retry_limit || 1;
    const context = agentParsePayload(template.context_config || '{}') || {};
    const contextMode = document.getElementById('agent-context-mode');
    if (contextMode) contextMode.value = context.mode || 'auto';
    const contextNotes = document.getElementById('agent-context-notes');
    if (contextNotes) contextNotes.value = context.notes || '';
    const allowlist = agentParsePayload(template.tool_allowlist || '[]');
    const selectedTools = Array.isArray(allowlist) ? allowlist.map(item => String(item || '').trim()).filter(Boolean) : [];
    document.querySelectorAll('[data-agent-tool-allow]').forEach(input => {
        input.checked = selectedTools.length === 0 ? true : selectedTools.includes(input.dataset.agentToolAllow);
    });
}

async function loadAgentTemplates() {
    const list = document.getElementById('agent-template-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/templates`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '模板库加载失败');
    agentTemplatesCache = data.data || [];
    list.innerHTML = agentTemplatesCache.length ? agentTemplatesCache.slice(0, 8).map(template => `
        <div class="agent-template-item" title="${agentEscape(template.description || template.goal_template)}">
            <button type="button" class="agent-template-apply" data-agent-template-id="${agentEscape(template.id)}">
                <strong>${agentEscape(template.name)}</strong>
                <span>${agentEscape(template.scope === 'shared' ? '共享' : '个人')}</span>
            </button>
            ${template.scope === 'personal' ? `<button type="button" class="agent-mini-danger" data-agent-template-delete="${agentEscape(template.id)}">删除</button>` : ''}
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无模板</div>';
    list.querySelectorAll('[data-agent-template-id]').forEach(btn => {
        btn.addEventListener('click', () => applyAgentTemplate(agentTemplatesCache.find(item => String(item.id) === String(btn.dataset.agentTemplateId))));
    });
    list.querySelectorAll('[data-agent-template-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentTemplate(btn.dataset.agentTemplateDelete));
    });
}

async function saveCurrentAgentTemplate() {
    const payload = getAgentRunPayload();
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    const name = window.prompt('模板名称', payload.goal.slice(0, 24));
    if (!name) return;
    const res = await apiFetch(`${API_BASE}/agents/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            goalTemplate: payload.goal,
            description: '从智能体工作台保存',
            ...payload
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '保存模板失败', 'error');
    showToast('模板已保存', 'success');
    await loadAgentTemplates();
}

function deleteAgentTemplate(templateId) {
    showConfirm('删除智能体模板', '确定删除这个智能体模板吗？已创建的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除模板失败', 'error');
        showToast('模板已删除', 'success');
        await loadAgentTemplates();
    });
}

async function loadAgentSchedules() {
    const list = document.getElementById('agent-schedule-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/schedules`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '计划队列加载失败');
    agentSchedulesCache = data.data || [];
    list.innerHTML = agentSchedulesCache.length ? agentSchedulesCache.slice(0, 5).map(schedule => `
        <div class="agent-ops-item">
            <strong>${agentEscape(schedule.name)}</strong>
            <span>${agentEscape(schedule.frequency === 'daily' ? '每天' : schedule.frequency === 'weekly' ? '每周' : '手动')} · 下次 ${agentEscape(schedule.next_run_at || '-')}</span>
            <div class="agent-ops-actions">
                <button type="button" class="btn-secondary" data-agent-schedule-run="${agentEscape(schedule.id)}">运行</button>
                <button type="button" class="btn-danger-outline" data-agent-schedule-delete="${agentEscape(schedule.id)}">删除</button>
            </div>
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无计划</div>';
    list.querySelectorAll('[data-agent-schedule-run]').forEach(btn => {
        btn.addEventListener('click', () => runAgentSchedule(btn.dataset.agentScheduleRun));
    });
    list.querySelectorAll('[data-agent-schedule-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentSchedule(btn.dataset.agentScheduleDelete));
    });
}

async function runAgentSchedule(scheduleId) {
    const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}/run`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '计划运行失败', 'error');
    showToast('计划任务已入队', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
}

function deleteAgentSchedule(scheduleId) {
    showConfirm('删除智能体计划', '确定删除这个计划吗？已产生的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除计划失败', 'error');
        showToast('计划已删除', 'success');
        await loadAgentSchedules();
    });
}

async function loadAgentNotifications() {
    const list = document.getElementById('agent-notification-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/notifications?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '通知加载失败');
    const items = data.data || [];
    list.innerHTML = items.length ? items.slice(0, 5).map(item => `
        <button type="button" class="agent-ops-item ${item.status === 'unread' ? 'unread' : ''}" data-agent-notification-id="${agentEscape(item.id)}" data-agent-notification-run="${agentEscape(item.run_id || '')}">
            <strong>${agentEscape(agentNotificationTitle(item))}</strong>
            <span>${agentEscape(agentNotificationBody(item))}</span>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无通知</div>';
    list.querySelectorAll('[data-agent-notification-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await apiFetch(`${API_BASE}/agents/notifications/${encodeURIComponent(btn.dataset.agentNotificationId)}/read`, { method: 'POST' });
            if (btn.dataset.agentNotificationRun) await window.openAgentRun(btn.dataset.agentNotificationRun);
            await loadAgentNotifications();
        });
    });
}

async function loadAgentArtifacts() {
    const list = document.getElementById('agent-artifact-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/artifacts?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '结果沉淀加载失败');
    agentArtifactsCache = data.data || [];
    list.innerHTML = agentArtifactsCache.length ? agentArtifactsCache.slice(0, 4).map(item => `
        <button type="button" class="agent-ops-item" data-agent-artifact-id="${agentEscape(item.id)}">
            <strong>${agentEscape(item.title)}</strong>
            <span>v${Number(item.current_version || 1)} · ${Number(item.version_count || 1)} 版 · ${agentEscape(formatDateToCN(item.updated_at || item.created_at))}</span>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无沉淀结果</div>';
    list.querySelectorAll('[data-agent-artifact-id]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentArtifactVersions(btn.dataset.agentArtifactId));
    });
}

function ensureAgentArtifactModal() {
    let modal = document.getElementById('agent-artifact-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-artifact-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-artifact-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="agent-artifact-title">结果版本</h3>
                    <p class="model-modal-desc" id="agent-artifact-desc"></p>
                </div>
                <button type="button" id="agent-artifact-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="agent-artifact-editor">
                <label>
                    <span>版本备注</span>
                    <input id="agent-artifact-note" class="form-input" placeholder="说明本次修改、回滚或校订原因">
                </label>
                <label>
                    <span>当前内容</span>
                    <textarea id="agent-artifact-content" class="form-input agent-artifact-content"></textarea>
                </label>
                <button type="button" id="agent-artifact-save-version" class="btn-primary">保存新版本</button>
            </div>
            <div id="agent-artifact-diff" class="agent-artifact-diff"></div>
            <div id="agent-artifact-version-list" class="agent-artifact-version-list"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('#agent-artifact-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

async function loadAgentArtifactModal(artifactId) {
    const modal = ensureAgentArtifactModal();
    const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '版本加载失败', 'error');
    const artifact = data.artifact || {};
    const versions = data.versions || [];
    modal.querySelector('#agent-artifact-title').textContent = artifact.title || '结果版本';
    modal.querySelector('#agent-artifact-desc').textContent = `${versions.length} 个版本 · 当前 v${artifact.current_version || 1}`;
    modal.querySelector('#agent-artifact-content').value = artifact.content || '';
    modal.querySelector('#agent-artifact-note').value = '';
    modal.querySelector('#agent-artifact-diff').innerHTML = '';
    modal.querySelector('#agent-artifact-save-version').onclick = async () => {
        const content = modal.querySelector('#agent-artifact-content').value;
        const note = modal.querySelector('#agent-artifact-note').value;
        const saveRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, note })
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) return showToast(saveData.error || '保存版本失败', 'error');
        showToast('新版本已保存', 'success');
        await loadAgentArtifacts();
        await loadAgentArtifactModal(artifactId);
    };
    const list = modal.querySelector('#agent-artifact-version-list');
    list.innerHTML = versions.map(version => `
        <div class="agent-artifact-version ${version.id === artifact.current_version_id ? 'current' : ''}">
            <div>
                <strong>v${Number(version.version)}</strong>
                <span>${agentEscape(version.note || '无备注')}</span>
                <small>${agentEscape(formatDateToCN(version.created_at))}</small>
            </div>
            <div class="agent-artifact-version-actions">
                ${version.version > 1 ? `<button type="button" class="btn-secondary" data-artifact-diff="${version.version}">对比上一版</button>` : ''}
                ${version.id !== artifact.current_version_id ? `<button type="button" class="btn-secondary" data-artifact-rollback="${version.version}">回滚</button>` : ''}
            </div>
        </div>
    `).join('') || '<div class="empty-state compact">暂无版本</div>';
    list.querySelectorAll('[data-artifact-diff]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const to = Number(btn.dataset.artifactDiff);
            const diffRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/diff?from=${to - 1}&to=${to}`);
            const diffData = await diffRes.json().catch(() => ({}));
            if (!diffRes.ok) return showToast(diffData.error || '对比失败', 'error');
            modal.querySelector('#agent-artifact-diff').innerHTML = `
                <strong>v${to - 1} → v${to}</strong>
                <pre>${agentEscape((diffData.diff || []).filter(row => row.type !== 'same').map(row => `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '} ${row.text}`).join('\n') || '无差异')}</pre>
            `;
        });
    });
    list.querySelectorAll('[data-artifact-rollback]').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('回滚结果版本', `确定回滚到 v${btn.dataset.artifactRollback} 吗？会生成一个新的当前版本。`, async () => {
                const rollbackRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/rollback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version: Number(btn.dataset.artifactRollback) })
                });
                const rollbackData = await rollbackRes.json().catch(() => ({}));
                if (!rollbackRes.ok) return showToast(rollbackData.error || '回滚失败', 'error');
                showToast('已回滚并生成新版本', 'success');
                await loadAgentArtifacts();
                await loadAgentArtifactModal(artifactId);
            });
        });
    });
    modal.classList.remove('hidden');
}

window.openAgentArtifactVersions = loadAgentArtifactModal;

window.createAgentRun = async function() {
    const payload = getAgentRunPayload();
    const frequency = document.getElementById('agent-schedule-frequency')?.value || 'manual';
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (!payload.modelId) return showToast('请选择模型', 'error');
    if (payload._invalid) return;
    const preflight = await preflightAgentPayload(payload);
    if (preflight.status === 'blocked') return showToast('任务预检未通过，请先处理阻断项', 'error');
    if (frequency !== 'manual') {
        const scheduleRes = await apiFetch(`${API_BASE}/agents/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                name: payload.goal.slice(0, 40),
                frequency,
                timeOfDay: document.getElementById('agent-schedule-time')?.value || '09:00',
                dayOfWeek: document.getElementById('agent-schedule-weekday')?.value || 1
            })
        });
        const scheduleData = await scheduleRes.json().catch(() => ({}));
        if (!scheduleRes.ok) return showToast(scheduleData.error || '计划创建失败', 'error');
        showToast('计划任务已创建', 'success');
        await loadAgentSchedules();
        return;
    }
    const res = await apiFetch(`${API_BASE}/agents/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '任务创建失败', 'error');
    showToast('智能体任务已入队', 'success');
    document.getElementById('agent-goal-input').value = '';
    await Promise.all([loadAgentRuns(1), loadAgentSchedules(), loadAgentNotifications()]);
    await window.openAgentRun(data.run.id);
};

window.approveAgentRun = async function(runId, approve = true) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '审批处理失败', 'error');
    showToast(approve ? '已批准工具调用，任务继续排队' : '已拒绝工具调用', 'success');
    await loadAgentRuns();
    await window.openAgentRun(runId);
};

window.cancelAgentRun = function(runId) {
    showConfirm('停止智能体任务', '确定停止这个正在执行的智能体任务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('智能体任务已停止', 'success');
        await loadAgentRuns();
        const stillExists = agentRunsCache.some(run => run.id === runId);
        if (stillExists) await window.openAgentRun(runId);
    });
};

window.rerunAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '重新运行失败', 'error');
    showToast('已创建新的智能体任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.resumeAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '断点续跑失败', 'error');
    showToast('已从上次执行位置创建续跑任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.saveAgentArtifact = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '保存结果失败', 'error');
    showToast('结果已沉淀', 'success');
    await loadAgentArtifacts();
};

window.deleteAgentRun = function(runId) {
    showConfirm('移除智能体任务记录', '确定从任务列表移除这条智能体任务记录吗？记录会保留给超级管理员审计。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '移除记录失败', 'error');
        showToast('智能体任务记录已移除', 'success');
        closeAgentRunDetailModal();
        await loadAgentRuns();
    });
};

window.showAgentRunAudit = async function() {
    if (currentUser?.username !== 'admin') {
        showToast('仅 admin 超级管理员可查看智能体删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/deleted/audit?limit=100`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureAgentAuditModal();
        const body = modal.querySelector('#agent-audit-body');
        if (body) body.innerHTML = renderAgentAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

window.loadAgentWorkbench = async function() {
    try {
        await loadAgentModels();
        await Promise.all([
            loadCapabilityPackages(),
            loadAgentTools(),
            loadAgentRuns(),
            loadAgentRuntimeStatus(),
            loadAgentMetrics(),
            loadAgentTemplates(),
            loadAgentSchedules(),
            loadAgentNotifications(),
            loadAgentArtifacts()
        ]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

window.openAgentWorkbench = async function() {
    window.showMainWorkspace?.('agent');
    const panel = document.getElementById('agent-workbench-modal');
    if (!panel) return;
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', currentUser?.username !== 'admin');
    });
    await window.loadAgentWorkbench();
    window.bindAgentFilters?.();
    window.bindAgentEnterpriseControls?.();
    window.bindAgentConfigModal?.();
};

window.openAgentDagWorkbench = async function() {
    closeAgentConfigModal();
    window.showMainWorkspace?.('agent-dag');
    restoreAgentWorkflowSnapshot();
    mountAgentDagEditor();
    window.refreshAgentDagEditor?.();
    window.bindAgentDagWorkbench?.();
};

window.closeAgentWorkbench = function() {
    closeAgentConfigModal();
    closeAgentRunDetailModal();
    window.showMainWorkspace?.('chat');
    updateAgentAutoRefresh();
};

window.closeAgentDagWorkbench = function() {
    window.showMainWorkspace?.('agent');
};

window.bindAgentGoalTemplates = function() {
    document.querySelectorAll('[data-agent-goal-template]').forEach(btn => {
        if (btn.dataset.boundAgentTemplate === '1') return;
        btn.dataset.boundAgentTemplate = '1';
        btn.addEventListener('click', () => {
            const input = document.getElementById('agent-goal-input');
            if (!input) return;
            input.value = btn.dataset.agentGoalTemplate || '';
            if (btn.dataset.agentRunMode) {
                const mode = document.getElementById('agent-run-mode');
                if (mode) mode.value = btn.dataset.agentRunMode;
            }
            if (btn.dataset.agentMcp) {
                const allowMcp = document.getElementById('agent-allow-mcp');
                if (allowMcp) allowMcp.checked = btn.dataset.agentMcp === 'true';
            }
            input.focus();
        });
    });
};

window.bindAgentFilters = function() {
    ['agent-filter-status', 'agent-filter-query'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.boundAgentFilter === '1') return;
        el.dataset.boundAgentFilter = '1';
        const reloadFirstPage = () => loadAgentRuns(1).catch(err => showToast(err.message || '任务列表刷新失败', 'error'));
        el.addEventListener('input', reloadFirstPage);
        el.addEventListener('change', reloadFirstPage);
    });
};

window.bindAgentEnterpriseControls = function() {
    const saveTemplateBtn = document.getElementById('agent-save-template-btn');
    if (saveTemplateBtn && saveTemplateBtn.dataset.boundAgentTemplateSave !== '1') {
        saveTemplateBtn.dataset.boundAgentTemplateSave = '1';
        saveTemplateBtn.addEventListener('click', saveCurrentAgentTemplate);
    }
    const frequency = document.getElementById('agent-schedule-frequency');
    const weekday = document.getElementById('agent-schedule-weekday');
    if (frequency && frequency.dataset.boundAgentSchedule !== '1') {
        frequency.dataset.boundAgentSchedule = '1';
        const update = () => weekday?.classList.toggle('is-disabled', frequency.value !== 'weekly');
        frequency.addEventListener('change', update);
        update();
    }
};

const agentConfigSectionTitles = {
    templates: '模板与计划',
    results: '能力与结果'
};

function closeAgentConfigModal() {
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const store = document.getElementById('agent-config-section-store');
    if (body && store) {
        Array.from(body.children).forEach(child => {
            store.appendChild(child);
            if (child.matches?.('.agent-collapse-section')) child.open = true;
        });
    }
    activeAgentConfigSection = '';
    if (modal) delete modal.dataset.agentConfigSection;
    modal?.classList.add('hidden');
}

function openAgentConfigSection(sectionKey) {
    const section = document.querySelector(`[data-agent-config-section="${CSS.escape(sectionKey)}"]`);
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const title = document.getElementById('agent-config-modal-title');
    if (!section || !modal || !body) return;
    closeAgentConfigModal();
    activeAgentConfigSection = sectionKey;
    modal.dataset.agentConfigSection = sectionKey;
    if (title) title.textContent = agentConfigSectionTitles[sectionKey] || '智能体配置';
    section.open = true;
    body.appendChild(section);
    modal.classList.remove('hidden');
    if (sectionKey === 'advanced') {
        mountAgentDagEditor();
        setTimeout(() => window.refreshAgentDagEditor?.(), 50);
    }
}

window.closeAgentConfigModal = closeAgentConfigModal;
window.openAgentConfigSection = openAgentConfigSection;

window.bindAgentConfigModal = function() {
    document.querySelectorAll('[data-agent-config-open]').forEach(btn => {
        if (btn.dataset.boundAgentConfigOpen === '1') return;
        btn.dataset.boundAgentConfigOpen = '1';
        btn.addEventListener('click', () => openAgentConfigSection(btn.dataset.agentConfigOpen));
    });
    const closeBtn = document.getElementById('agent-config-modal-close');
    if (closeBtn && closeBtn.dataset.boundAgentConfigClose !== '1') {
        closeBtn.dataset.boundAgentConfigClose = '1';
        closeBtn.addEventListener('click', closeAgentConfigModal);
    }
    const modal = document.getElementById('agent-config-modal');
    if (modal && modal.dataset.boundAgentConfigOverlay !== '1') {
        modal.dataset.boundAgentConfigOverlay = '1';
        modal.addEventListener('click', event => {
            if (event.target === modal) closeAgentConfigModal();
        });
    }
    const runDetailClose = document.getElementById('agent-run-detail-close');
    if (runDetailClose && runDetailClose.dataset.boundAgentRunDetailClose !== '1') {
        runDetailClose.dataset.boundAgentRunDetailClose = '1';
        runDetailClose.addEventListener('click', closeAgentRunDetailModal);
    }
    const runDetailModal = document.getElementById('agent-run-detail-modal');
    if (runDetailModal && runDetailModal.dataset.boundAgentRunDetailOverlay !== '1') {
        runDetailModal.dataset.boundAgentRunDetailOverlay = '1';
        runDetailModal.addEventListener('click', event => {
            if (event.target === runDetailModal) closeAgentRunDetailModal();
        });
    }
    document.querySelectorAll('#agent-open-dag-btn').forEach(btn => {
        if (btn.dataset.boundAgentDagOpen === '1') return;
        btn.dataset.boundAgentDagOpen = '1';
        btn.addEventListener('click', () => window.openAgentDagWorkbench?.());
    });
};

window.bindAgentDagWorkbench = function() {
    const draftBtn = document.getElementById('agent-dag-save-draft-btn');
    if (draftBtn && draftBtn.dataset.boundAgentDagDraft !== '1') {
        draftBtn.dataset.boundAgentDagDraft = '1';
        draftBtn.addEventListener('click', () => window.saveAgentWorkflowDraft?.());
    }
    const saveBtn = document.getElementById('agent-dag-save-btn');
    if (saveBtn && saveBtn.dataset.boundAgentDagSave !== '1') {
        saveBtn.dataset.boundAgentDagSave = '1';
        saveBtn.addEventListener('click', () => window.saveAgentWorkflow?.());
    }
    const backBtn = document.getElementById('agent-dag-back-btn');
    if (backBtn && backBtn.dataset.boundAgentDagBack !== '1') {
        backBtn.dataset.boundAgentDagBack = '1';
        backBtn.addEventListener('click', () => window.closeAgentDagWorkbench?.());
    }
};

// 智能体 DAG 可视化编辑器挂载（v0.0.47）
// 与 #agent-dag-spec textarea 双向同步：编辑器内部变化 -> textarea；textarea 手动改 -> 编辑器重绘
let dagEditorInstance = null;
function mountAgentDagEditor() {
    const canvas = document.getElementById('agent-dag-editor-canvas');
    const textarea = document.getElementById('agent-dag-spec');
    const toolbar = document.getElementById('agent-dag-editor-toolbar');
    const inspector = document.getElementById('agent-dag-editor-inspector');
    if (!canvas || !textarea || !window.PivotDagEditor) return;
    if (!canvas.offsetParent && activeAgentConfigSection !== 'advanced') return;
    if (dagEditorInstance) dagEditorInstance.destroy();
    dagEditorInstance = window.PivotDagEditor.mount({
        canvas,
        textarea,
        toolbar,
        inspector,
        getTools: () => agentToolsCache || [],
        onChange: (result) => {
            if (result && result.error === 'invalid_json') {
                showToast('工作流编排 JSON 格式不正确', 'error');
            }
        }
    });
}
window.refreshAgentDagEditor = () => dagEditorInstance?.refresh();

