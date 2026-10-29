// --- 模型管理模块 ---
const pendingTests = new Set();

function formatModelPriceCurrency(value) {
    const raw = String(value || '').trim();
    if (!raw) return '人民币';
    return /[一-龥]/.test(raw) ? raw : '人民币';
}

function ensureModelCostFields() {
    if (document.getElementById('m-input-price')) return;
    const dailyInput = document.getElementById('m-daily-limit');
    const anchorRow = dailyInput?.closest('.model-form-row');
    if (!anchorRow) return;
    const row = document.createElement('div');
    row.className = 'model-form-row model-cost-row';
    PivotSafeHtml.setHtml(row, `
        <div class="form-item">
            <label>输入单价（每百万 Token）</label>
            <input type="number" id="m-input-price" class="form-input" min="0" step="0.000001" placeholder="0 表示不统计成本">
        </div>
        <div class="form-item">
            <label>输出单价（每百万 Token）</label>
            <input type="number" id="m-output-price" class="form-input" min="0" step="0.000001" placeholder="0 表示不统计成本">
        </div>
        <div class="form-item">
            <label>计价币种</label>
            <select id="m-price-currency" class="form-input">
                <option value="人民币">人民币</option>
                <option value="美元">美元</option>
                <option value="欧元">欧元</option>
                <option value="港币">港币</option>
                <option value="日元">日元</option>
                <option value="英镑">英镑</option>
            </select>
        </div>
    `);
    anchorRow.insertAdjacentElement('afterend', row);
}

function renderModelCapabilityBadges(model) {
    const icons = [
        '<span class="model-capability-icon cap-icon text" title="文本模型" aria-label="文本模型"><svg viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>'
    ];

    if (Number(model.supports_vision || 0) === 1) {
        icons.push('<span class="model-capability-icon cap-icon vision" title="支持视觉输入" aria-label="支持视觉输入"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    }

    if (Number(model.supports_reasoning || 0) === 1) {
        icons.push('<span class="model-capability-icon cap-icon reasoning" title="支持思考/推理" aria-label="支持思考/推理"><svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    }

    const toolCallMode = String(model.tool_call_mode || 'auto');
    const toolCallStatus = String(model.tool_call_probe_status || 'unknown');
    if (toolCallMode !== 'disabled' && (Number(model.supports_tool_calls || 0) === 1 || toolCallMode === 'enabled')) {
        icons.push('<span class="model-capability-icon cap-icon reasoning" title="支持 Agent 原生工具调用" aria-label="支持 Agent 原生工具调用"><svg viewBox="0 0 24 24"><path d="M8 5V3"/><path d="M16 5V3"/><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 11h8"/><path d="M8 15h4"/></svg></span>');
    } else if (toolCallMode === 'auto' && toolCallStatus === 'unsupported') {
        icons.push('<span class="model-capability-icon cap-icon text" title="端点不支持原生工具调用，Agent 将使用 JSON 规划回退" aria-label="原生工具调用已回退"><svg viewBox="0 0 24 24"><path d="M12 3v10"/><path d="m8 10 4 4 4-4"/><path d="M5 21h14"/></svg></span>');
    }

    return icons.join('');
}

function canTestModelConnection(model) {
    if (!model || !currentUser?.id) return false;
    if (String(model.user_id) === String(currentUser.id)) return true;
    if (!model.user_id) {
        if (isAdminUser()) return true;
        if (!model.allowed_units) return true;
        const units = String(model.allowed_units).split(',').map(u => u.trim()).filter(Boolean);
        const userUnit = String(currentUser.unit || '').trim();
        return Boolean(userUnit && units.includes(userUnit));
    }
    return false;
}

function renderRetrievalModelServices(settings = {}) {
    const target = document.getElementById('retrieval-model-services-body');
    if (!target) return;
    const isSuperAdmin = isSuperAdminUser();
    const embedding = settings.retrievalModelConfig || settings.embeddingConfig || {};
    const rerank = settings.rerankConfig || {};
    const rag = settings.ragConfig || {};
    const ocr = settings.ocrConfig || window.Pivot?.ocrConfig || {};

    const ocrEngine = settings.ocrEngineStatus?.http || window.Pivot?.ocrEngineStatus?.http || null;
    const ocrAvailable = ocrEngine ? ocrEngine.available === true : null;
    const ocrReadyClass = ocrAvailable === true ? 'is-ready' : (ocrAvailable === false ? 'is-warning' : '');
    const ocrStatusText = ocrAvailable === true
        ? '服务可用 · 外部 OCR 服务'
        : (ocrAvailable === false ? `连接异常 (${ocrEngine?.error || '无法连接'})` : '外部 OCR 服务 (HTTP)');

    const canViewEmbeddingUrl = isSuperAdmin || (Boolean(embedding.isPersonal) && embedding.source?.url === 'user');
    const displayEmbeddingUrl = canViewEmbeddingUrl
        ? (embedding.apiUrl || '未配置服务地址')
        : (embedding.apiUrl ? '********' : '未配置服务地址');
    const embeddingUrlTitle = canViewEmbeddingUrl
        ? displayEmbeddingUrl
        : (embedding.apiUrl ? '服务地址已脱敏' : '未配置服务地址');

    const canViewOcrUrl = isSuperAdmin;
    const rawOcrUrl = ocr.serviceUrl || (canViewOcrUrl ? 'http://ocr-service:9100' : '');
    const isOcrConfigured = Boolean((ocr.serviceUrl && ocr.serviceUrl !== '未配置服务地址') || ocr.configured || ocrAvailable !== null);
    const displayOcrUrl = canViewOcrUrl
        ? (rawOcrUrl || '未配置服务地址')
        : (isOcrConfigured ? '********' : '未配置服务地址');
    const ocrUrlTitle = canViewOcrUrl
        ? (rawOcrUrl || '未配置服务地址')
        : (isOcrConfigured ? '服务地址已脱敏' : '未配置服务地址');

    const embeddingReady = Boolean(embedding.apiUrl && embedding.model);
    const rerankReady = rerank.enabled === true;
    const policySummary = `Top ${Number(rag.topK || 0)} · 候选 ${Number(rag.candidateLimit || 0)} · 分块 ${Number(rag.chunkSize || 0)}`;
    const canConfigure = isSuperAdmin;
    const configButton = (section, label) => canConfigure
        ? `<button class="btn-secondary retrieval-model-service-config" type="button" data-retrieval-model-config-open="${section}">${label}</button>`
        : '';
    const testButton = (serviceKey, label = '测试') => `
        <button class="btn-secondary retrieval-model-service-test" type="button" data-retrieval-model-test="${serviceKey}">${label}</button>
    `;
    PivotSafeHtml.setHtml(target, `
        <article class="retrieval-model-service-card ${embeddingReady ? 'is-ready' : 'is-warning'}">
            <strong>向量生成服务</strong>
            <span title="当前向量模型">${escapeHtml(embedding.model || '未配置')}</span>
            <small title="${escapeHtml(embeddingUrlTitle)}">${escapeHtml(displayEmbeddingUrl)}</small>
            <div class="retrieval-model-service-actions">
                ${testButton('embedding', '测试')}
                ${configButton('embedding', '配置')}
            </div>
        </article>
        <article class="retrieval-model-service-card ${rerankReady ? 'is-ready' : 'is-warning'}">
            <strong>重排序服务</strong>
            <span title="当前重排序模型">${escapeHtml(rerank.model || 'BAAI/bge-reranker-v2-m3')}</span>
            <small>${rerank.configured ? `${rerank.enabled ? '已启用' : '已配置，当前未启用'} · ${rerank.protocol === 'llama_cpp' ? 'llama.cpp' : 'TEI'} 协议` : '未配置，使用本地确定性排序'}</small>
            <div class="retrieval-model-service-actions">
                ${testButton('rerank', '测试')}
                ${configButton('rerank', '配置')}
            </div>
        </article>
        <article class="retrieval-model-service-card is-ready">
            <strong>检索策略</strong>
            <span>${escapeHtml(policySummary)}</span>
            <small>策略随系统检索配置保存；法规与知识库共用模型服务。</small>
            <div class="retrieval-model-service-actions">
                ${configButton('policy', '配置策略')}
            </div>
        </article>
        <article class="retrieval-model-service-card ${ocrReadyClass}">
            <strong>OCR 识别服务</strong>
            <span title="${escapeHtml(ocrUrlTitle)}">${escapeHtml(displayOcrUrl)}</span>
            <small title="${escapeHtml(ocrStatusText)}">${escapeHtml(ocrStatusText)}</small>
            <div class="retrieval-model-service-actions">
                ${testButton('ocr', '测试')}
                ${configButton('ocr', '配置')}
            </div>
        </article>
        ${window.Pivot.moduleApi('settings.speech', {}).renderCard?.(settings.speechConfig) || ''}
    `);
    window.Pivot.moduleApi('settings.speech', {}).refreshStatus?.();
}

window.Pivot?.exposeModule?.('models.retrieval', { renderRetrievalModelServices });

window.Pivot.legacy.loadModels = async function(page = 1) {
    const [modelRes, settingsRes] = await Promise.all([
        apiFetch(`${API_BASE}/models?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/settings`, { headers: authHeaders() })
    ]);

    if (modelRes.status === 401) {
        handleUnauthorized();
        return;
    }
    const result = await modelRes.json();
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    if (settings.ocrConfig) window.Pivot.ocrConfig = settings.ocrConfig;
    renderRetrievalModelServices(settings);
    window.Pivot.legacy.updateEmbeddingSettingsForm?.(settings.retrievalModelConfig || settings.embeddingConfig, settings.rerankConfig);
    window.Pivot.legacy.bindEmbeddingModalEvents?.();
    if (!window.Pivot?.ocrEngineStatus) {
        apiFetch(`${API_BASE}/apps/ocr/engines`, { headers: authHeaders() })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.engines) {
                    window.Pivot.ocrEngineStatus = data.engines;
                    renderRetrievalModelServices({ ...settings, ocrEngineStatus: data.engines });
                }
            })
            .catch(() => {});
    }
    const personalDefaultId = settings.personalDefaultModelId;
    const globalDefaultId = settings.defaultModelId;
    const data = result.data || [];
    const total = result.total || 0;
    
    if (page === 1) refreshModelSelector();

    PivotSafeHtml.setHtml(document.getElementById('model-list-body'), data.map((m, idx) => {
        const isGlobalModel = !m.user_id;
        const isPersonalDefault = String(m.id) === String(personalDefaultId);
        const isGlobalDefault = isGlobalModel && String(m.id) === String(globalDefaultId);
        const isSuperAdmin = isSuperAdminUser();
        const isMyModel = String(m.user_id) === String(currentUser?.id);
        
        let defaultBtn = '';
        if (isSuperAdmin) {
            if (isGlobalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-global-default" data-model-id="" data-page="${page}">取消默认</button>`;
            } else if (isGlobalModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-global-default" data-model-id="${m.id}" data-page="${page}">设为默认</button>`;
            } else if (isMyModel && isPersonalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-personal-default" data-model-id="" data-page="${page}">取消个人默认</button>`;
            } else if (isMyModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-personal-default" data-model-id="${m.id}" data-page="${page}">设为个人默认</button>`;
            }
        } else {
            if (isPersonalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-personal-default" data-model-id="" data-page="${page}">取消默认</button>`;
            } else if (isMyModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-personal-default" data-model-id="${m.id}" data-page="${page}">设为默认</button>`;
            }
        }

        const isOwnModel = String(m.user_id) === String(currentUser?.id);
        const canEdit = isOwnModel || (isSuperAdmin && isGlobalModel);
        const canDelete = canEdit;
        
        let displayUrl = escapeHtml(m.url);
        if (isSuperAdmin) {
            if (!isGlobalModel && !isOwnModel) displayUrl = '********';
        } else {
            if (!isOwnModel) displayUrl = '********';
        }

        const capabilityBadge = renderModelCapabilityBadges(m);
        const priceCurrency = formatModelPriceCurrency(m.price_currency);
        const scopeText = m.user_id ? '仅本人' : (m.allowed_units || '全部');
        const safeScope = escapeHtml(scopeText);

        return `
        <tr id="model-row-${m.id}">
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            <td title="${escapeHtml(m.name)}">
                <div class="model-name-cell">
                    <span>${escapeHtml(m.name)}${m.user_id ? ' <small>(私有)</small>' : ' <small>(全局)</small>'}</span>
                </div>
            </td>
            <td title="${displayUrl}">${displayUrl}</td>
            <td title="${Number(m.daily_token_limit || 0).toLocaleString()} Tokens / ${escapeHtml(priceCurrency)} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}">${formatTokenAmount(m.daily_token_limit)} / <small>${escapeHtml(priceCurrency)} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}</small></td>
            <td class="model-capability-cell"><div class="model-capability-icons">${capabilityBadge}</div></td>
            <td title="${safeScope}">${safeScope}</td>
            <td title="${escapeHtml(m.owner_nickname || m.owner_name || '全局')}">${escapeHtml(m.owner_nickname || m.owner_name || '全局')}</td>
            <td class="text-center">
                <span class="status-dot status-unknown" id="status-${m.id}" title="未检测"></span>
                <small id="latency-${m.id}"></small>
            </td>
            <td title="${escapeHtml(formatDateToCN(m.created_at))}">${escapeHtml(formatDateToCN(m.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="test" data-model="${encodeActionArg(m)}">测试</button>
                    ${defaultBtn}
                    ${canEdit ? `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem;" data-model-action="edit" data-model="${encodeActionArg(m)}">编辑</button>` : ''}
                    ${canDelete ? `<button class="btn-danger" style="padding: 1px 5px; font-size: 0.68rem;" data-model-action="delete" data-model-id="${m.id}">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `; }).join(''));

    data.filter(model => !canTestModelConnection(model)).forEach(model => {
        document.querySelector(`#model-row-${model.id} [data-model-action="test"]`)?.remove();
    });
    
    renderPagination('models', total, page);
    window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
}

document.getElementById('model-list-body')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-model-action]');
    if (!button) return;
    const action = button.dataset.modelAction;
    const modelId = button.dataset.modelId || null;
    const page = Number.parseInt(button.dataset.page, 10) || pageState.models || 1;
    const model = button.dataset.model ? JSON.parse(decodeURIComponent(button.dataset.model)) : null;

    if (action === 'test' && model) return window.Pivot.legacy.testExistingModel(model);
    if (action === 'edit' && model) return window.Pivot.legacy.prepareEditModel(model);
    if (action === 'delete' && modelId) return window.Pivot.legacy.deleteModel(modelId);
    if (action === 'set-global-default') {
        await window.Pivot.legacy.setGlobalDefaultModel(modelId, button);
        return window.Pivot.legacy.loadModels(page);
    }
    if (action === 'set-personal-default') {
        await window.Pivot.legacy.saveMyDefaultModel(modelId, button);
        return window.Pivot.legacy.loadModels(page);
    }
});

async function checkSingleModelStatus(id, source = 'manual') {
    if (pendingTests.has(id)) return;
    const dot = document.getElementById(`status-${id}`);
    const latencyEl = document.getElementById(`latency-${id}`);
    if (!dot) return;
    pendingTests.add(id);
    const startTime = Date.now();
    try {
        const res = await apiFetch('/api/models/test', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id, source })
        });
        const duration = Date.now() - startTime;
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success !== false) {
            dot.className = 'status-dot status-online';
            dot.title = '在线';
            if (latencyEl) latencyEl.innerText = `${duration}ms`;
            if (source === 'manual') showToast('连接成功');
        } else {
            dot.className = 'status-dot status-offline';
            dot.title = data.error || '连接失败';
            if (latencyEl) latencyEl.innerText = '';
            if (source === 'manual') showToast('连接失败: ' + (data.error || '未知错误'), 'error');
        }
    } catch (e) {
        dot.className = 'status-dot status-offline';
        dot.title = '网络错误';
        if (source === 'manual') showToast('网络错误', 'error');
    } finally {
        pendingTests.delete(id);
    }
}

window.Pivot.legacy.openModelModal = () => {
    ensureModelCostFields();
    window.Pivot.legacy.resetModelForm();
    document.getElementById('model-modal-title').innerText = '添加新模型';
    window.Pivot.legacy.updateModelScopeControls?.();
    document.getElementById('model-modal-container').classList.remove('hidden');
};
window.Pivot.legacy.closeModelModal = () => document.getElementById('model-modal-container').classList.add('hidden');

window.Pivot.legacy.prepareEditModel = (model) => {
    ensureModelCostFields();
    document.getElementById('m-id').value = model.id;
    const scopeEl = document.getElementById('m-scope');
    if (scopeEl) scopeEl.value = model.user_id ? 'personal' : 'global';
    document.getElementById('m-name').value = model.name;
    document.getElementById('m-url').value = model.url;
    document.getElementById('m-model').value = model.model_name;
    document.getElementById('m-key').value = model.api_key || '';
    document.getElementById('m-daily-limit').value = formatTokenInputValue(model.daily_token_limit);
    document.getElementById('m-units').value = model.allowed_units || '';
    const tempEl = document.getElementById('m-temp');
    if (tempEl) tempEl.value = model.temperature !== null && model.temperature !== undefined ? model.temperature : '';
    const maxTokensEl = document.getElementById('m-max-tokens');
    if (maxTokensEl) maxTokensEl.value = formatTokenInputValue(model.max_tokens);
    const maxInputTokensEl = document.getElementById('m-max-input-tokens');
    if (maxInputTokensEl) maxInputTokensEl.value = formatTokenInputValue(model.max_input_tokens);
    const contextWindowTokensEl = document.getElementById('m-context-window-tokens');
    if (contextWindowTokensEl) contextWindowTokensEl.value = formatTokenInputValue(model.context_window_tokens);
    const maxConcurrentEl = document.getElementById('m-max-concurrent');
    if (maxConcurrentEl) maxConcurrentEl.value = model.max_concurrent || '';
    const monitorUrlEl = document.getElementById('m-monitor-url');
    if (monitorUrlEl) monitorUrlEl.value = model.monitor_url || '';
    const toolCallModeEl = document.getElementById('m-tool-call-mode');
    if (toolCallModeEl) toolCallModeEl.value = ['auto', 'enabled', 'disabled'].includes(model.tool_call_mode) ? model.tool_call_mode : 'auto';
    const toolCallProbeEl = document.getElementById('m-tool-call-probe-status');
    if (toolCallProbeEl) {
        const status = String(model.tool_call_probe_status || 'unknown');
        const details = String(model.tool_call_probe_error || '').trim();
        const labels = {
            supported: '已验证支持原生工具调用。',
            unsupported: '端点不支持原生工具调用，Agent 将自动使用 JSON 规划回退。',
            degraded: '最近一次原生工具调用异常，Agent 将尝试自动回退。',
            unknown: '尚未探测；自动模式会在首次 Agent 调用中验证。'
        };
        toolCallProbeEl.textContent = `${labels[status] || labels.unknown}${details ? ` 原因：${details}` : ''}`;
    }
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = Number(model.supports_vision || 0) === 1;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = Number(model.supports_reasoning || 0) === 1;
    const chatThinkingEnabledEl = document.getElementById('m-chat-thinking-enabled');
    if (chatThinkingEnabledEl) chatThinkingEnabledEl.checked = Number(model.chat_thinking_enabled || 0) === 1;
    const inputPriceEl = document.getElementById('m-input-price');
    if (inputPriceEl) inputPriceEl.value = model.input_price_per_million || '';
    const outputPriceEl = document.getElementById('m-output-price');
    if (outputPriceEl) outputPriceEl.value = model.output_price_per_million || '';
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = formatModelPriceCurrency(model.price_currency);
    document.getElementById('model-modal-title').innerText = '编辑模型配置';
    window.Pivot.legacy.updateModelScopeControls?.(model);
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.Pivot.legacy.testExistingModel = async (model) => {
    if (!canTestModelConnection(model)) return showToast('无权测试该模型', 'error');
    if (pendingTests.has(model.id)) return showToast('该模型正在检测，请稍后再试', 'info');
    showToast('正在测试连接...', 'info');
    await checkSingleModelStatus(model.id, 'manual');
};

window.Pivot.legacy.testModelConfig = async () => {
    const button = document.getElementById('modal-model-test');
    if (button?.disabled) return;
    const id = document.getElementById('m-id').value;
    const url = document.getElementById('m-url').value;
    const api_key = document.getElementById('m-key').value;
    const model_name = document.getElementById('m-model').value;
    if (button) button.disabled = true;
    try { await testConnection(url, api_key, model_name, id); }
    finally { if (button) button.disabled = false; }
};

async function testConnection(url, api_key, model_name, id = null) {
    if (!id && !url) return showToast('请输入接口地址', 'error');
    showToast('正在测试连接...', 'info');
    const startTime = Date.now();
    try {
        const res = await apiFetch('/api/models/test', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id, url, api_key, model_name, source: 'manual' })
        });
        const duration = Date.now() - startTime;
        const data = await res.json().catch(() => ({}));
        if (id) {
            const dot = document.getElementById(`status-${id}`);
            const latencyEl = document.getElementById(`latency-${id}`);
            if (dot) {
                if (res.ok && data.success !== false) {
                    dot.className = 'status-dot status-online';
                    dot.title = '在线';
                    if (latencyEl) latencyEl.innerText = `${duration}ms`;
                } else {
                    dot.className = 'status-dot status-offline';
                    dot.title = data.error || '连接失败';
                    if (latencyEl) latencyEl.innerText = '';
                }
            }
        }
        if (res.ok && data.success === false) return showToast('连接失败: ' + (data.error || '未知错误'), 'error');
        if (res.ok) showToast('连接成功');
        else showToast('连接失败: ' + (data.error || '未知错误'), 'error');
    } catch (e) { showToast('网络错误', 'error'); }
}

// refreshModelSelector 已在 ui.js 中定义
window.Pivot.legacy.resetModelForm = () => {
    ensureModelCostFields();
    ['m-id', 'm-name', 'm-url', 'm-model', 'm-key', 'm-daily-limit', 'm-units', 'm-temp', 'm-max-input-tokens', 'm-max-tokens', 'm-context-window-tokens', 'm-max-concurrent', 'm-monitor-url', 'm-input-price', 'm-output-price'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = '人民币';
    const toolCallModeEl = document.getElementById('m-tool-call-mode');
    if (toolCallModeEl) toolCallModeEl.value = 'auto';
    const toolCallProbeEl = document.getElementById('m-tool-call-probe-status');
    if (toolCallProbeEl) toolCallProbeEl.textContent = '自动模式会在首次 Agent 调用中探测端点能力；不支持时自动回退。';
    const scopeEl = document.getElementById('m-scope');
    if (scopeEl) scopeEl.value = 'personal';
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = false;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = false;
    const chatThinkingEnabledEl = document.getElementById('m-chat-thinking-enabled');
    if (chatThinkingEnabledEl) chatThinkingEnabledEl.checked = false;
    const keyInput = document.getElementById('m-key');
    if (keyInput) keyInput.type = 'password';
};

window.Pivot.legacy.updateModelScopeControls = () => {
    const isSuperAdmin = isSuperAdminUser();
    const scopeWrap = document.getElementById('m-scope-wrap');
    const scopeUnitsRow = scopeWrap?.closest('.model-scope-units-row');
    const scopeEl = document.getElementById('m-scope');
    const unitsEl = document.getElementById('m-units');
    if (scopeWrap) scopeWrap.classList.toggle('hidden', !isSuperAdmin);
    if (scopeUnitsRow) scopeUnitsRow.classList.toggle('scope-hidden', !isSuperAdmin);
    if (scopeEl) {
        scopeEl.disabled = !isSuperAdmin;
        if (!isSuperAdmin) scopeEl.value = 'personal';
    }
    const isGlobal = isSuperAdmin && scopeEl?.value === 'global';
    if (unitsEl) {
        unitsEl.disabled = !isGlobal;
        unitsEl.placeholder = isGlobal ? '多个部门用逗号分隔，留空表示全部可见' : '个人模型不需要设置可见部门';
    }
};
