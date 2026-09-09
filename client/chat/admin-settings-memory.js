/* 长期记忆工作区：从 admin-settings.js 拆出，保留原有 Pivot 兼容 API。 */

async function updateMemoryStatus(memoryId, status) {
    const res = await apiFetch(`${API_BASE}/memories/${memoryId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆状态更新失败');
    document.dispatchEvent(new globalThis.CustomEvent('pivot:memory-changed'));
    return data;
}

async function deleteMemory(memoryId) {
    const res = await apiFetch(`${API_BASE}/memories/${memoryId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆删除失败');
    document.dispatchEvent(new globalThis.CustomEvent('pivot:memory-changed'));
    return data;
}

let currentLongTermMemories = [];
const ENHANCED_MEMORY_TYPE_LABELS = {
    preference: '用户偏好',
    fact: '项目事实',
    decision: '长期决策',
    episode: '历史片段'
};
const MEMORY_STATUS_LABELS = {
    active: '活跃',
    disabled: '禁用',
    deleted: '已删除'
};

function formatMemoryStatusLabel(status) {
    const normalized = String(status || 'active').trim();
    return MEMORY_STATUS_LABELS[normalized] || '未知状态';
}

function getCurrentMemory(memoryId) {
    return currentLongTermMemories.find(memory => String(memory.id) === String(memoryId)) || null;
}

function renderEnhancedMemorySummary(summary = {}) {
    const grid = document.getElementById('memory-summary-grid');
    if (!grid) return;
    const byType = summary.byType || {};
    const items = [
        ['启用状态', summary.enabled ? '已启用' : '已关闭'],
        ['活跃记忆', Number(summary.active || 0)],
        ['用户偏好', Number(byType.preference || 0)],
        ['项目事实', Number(byType.fact || 0)],
        ['长期决策', Number(byType.decision || 0)],
        ['历史片段', Number(byType.episode || 0)]
    ];
    PivotSafeHtml.setHtml(grid, items.map(([label, value]) => `
        <div class="memory-summary-card">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
        </div>
    `).join(''));
}

window.Pivot.legacy.updateLongTermMemoryEnabled = async function(enabled) {
    const toggle = document.getElementById('long-term-memory-toggle');
    if (toggle) toggle.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/memories/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '长期记忆设置保存失败');
        if (toggle) toggle.checked = data.enabled !== false;
        renderEnhancedMemorySummary(data.summary);
        showToast(data.enabled ? '长期记忆已启用' : '长期记忆已关闭');
    } catch (e) {
        if (toggle) toggle.checked = !enabled;
        showToast(e.message || '长期记忆设置保存失败', 'error');
    } finally {
        if (toggle) toggle.disabled = false;
    }
};

async function saveMemory(memoryId, payload) {
    const res = await apiFetch(`${API_BASE}/memories/${memoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆保存失败');
    document.dispatchEvent(new globalThis.CustomEvent('pivot:memory-changed'));
    return data;
}

async function fetchMemorySource(memoryId) {
    const res = await apiFetch(`${API_BASE}/memories/${memoryId}/source`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆来源加载失败');
    return data;
}

async function fetchMemoryUsage(memoryId) {
    const res = await apiFetch(`${API_BASE}/memories/${memoryId}/usage`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆使用说明加载失败');
    return data.usage || {};
}

async function fetchMemoryMergeSuggestions() {
    const res = await apiFetch(`${API_BASE}/memories/merge-suggestions?limit=20`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '合并建议加载失败');
    return data.suggestions || [];
}

async function mergeMemoryPair(targetId, sourceId) {
    const res = await apiFetch(`${API_BASE}/memories/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, sourceId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆合并失败');
    return data;
}

window.Pivot.legacy.openMemoryEditModal = function(memory) {
    window.Pivot?.getModule?.('settings.memoryUi')?.ensureMemoryModalsAttached?.();
    const modal = document.getElementById('memory-edit-modal');
    const idInput = document.getElementById('memory-edit-id');
    const typeInput = document.getElementById('memory-edit-type');
    const contentInput = document.getElementById('memory-edit-content');
    const salienceInput = document.getElementById('memory-edit-salience');
    const confidenceInput = document.getElementById('memory-edit-confidence');
    if (!modal || !idInput || !typeInput || !contentInput || !salienceInput || !confidenceInput) {
        return showToast('记忆编辑窗口加载异常，请刷新后重试', 'error');
    }
    if (!memory) return showToast('记忆数据已刷新，请重新加载后再编辑', 'error');
    idInput.value = memory.id;
    typeInput.value = memory.type || 'episode';
    contentInput.value = memory.content || '';
    salienceInput.value = Number(memory.salience || 0).toFixed(2);
    confidenceInput.value = Number(memory.confidence || 0).toFixed(2);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    contentInput.focus();
};

window.Pivot.legacy.closeMemoryEditModal = function() {
    const modal = document.getElementById('memory-edit-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
};

function renderMemorySource(data = {}) {
    const body = document.getElementById('memory-source-body');
    if (!body) return;
    const session = data.session || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    PivotSafeHtml.setHtml(body, `
        <div class="memory-source-meta">
            <strong>${escapeHtml(session.title || session.id || '-')}</strong>
            <span>${escapeHtml(session.updatedAt || session.createdAt || '')}</span>
        </div>
        <div class="memory-source-list">
            ${messages.length ? messages.map(message => `
                <article class="memory-source-message">
                    <div>
                        <strong>${escapeHtml(message.role || '')}</strong>
                        <span>#${escapeHtml(String(message.id || ''))}</span>
                    </div>
                    <pre>${escapeHtml(message.content || '')}</pre>
                </article>
            `).join('') : '<p class="muted">暂无可追溯消息</p>'}
        </div>
    `);
}

window.Pivot.legacy.openMemorySourceModal = async function(memoryId) {
    window.Pivot?.getModule?.('settings.memoryUi')?.ensureMemoryModalsAttached?.();
    const modal = document.getElementById('memory-source-modal');
    if (!modal) return;
    const body = document.getElementById('memory-source-body');
    if (body) PivotSafeHtml.setHtml(body, '<p class="muted">正在加载...</p>');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    try {
        const data = await fetchMemorySource(memoryId);
        renderMemorySource(data);
    } catch (e) {
        if (body) PivotSafeHtml.setHtml(body, `<p class="muted">${escapeHtml(e.message || '记忆来源加载失败')}</p>`);
        showToast(e.message || '记忆来源加载失败', 'error');
    }
};

async function openMemoryUsageModal(memoryId) {
    window.Pivot?.getModule?.('settings.memoryUi')?.ensureMemoryModalsAttached?.();
    const modal = document.getElementById('memory-source-modal');
    const body = document.getElementById('memory-source-body');
    if (!modal || !body) return;
    PivotSafeHtml.setHtml(body, '<p class="muted">正在加载使用说明...</p>');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    try {
        const usage = await fetchMemoryUsage(memoryId);
        PivotSafeHtml.setHtml(body, `<div class="memory-source-meta"><strong>为何使用这条记忆</strong><span>记忆 #${escapeHtml(String(usage.memoryId || memoryId))}</span></div><div class="memory-source-message"><pre>${escapeHtml(usage.reason || '该记忆与当前任务相关。')}</pre></div>`);
    } catch (error) {
        PivotSafeHtml.setHtml(body, `<p class="muted">${escapeHtml(error.message || '记忆使用说明加载失败')}</p>`);
    }
};

window.Pivot.legacy.closeMemorySourceModal = function() {
    const modal = document.getElementById('memory-source-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
};

function renderMemoryMergeSuggestions(suggestions = []) {
    const panel = document.getElementById('memory-merge-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    if (!suggestions.length) {
        PivotSafeHtml.setHtml(panel, '<div class="memory-merge-empty">暂无合并建议</div>');
        return;
    }
    PivotSafeHtml.setHtml(panel, suggestions.map(item => `
        <div class="memory-merge-row">
            <div class="memory-merge-copy">
                <span>${escapeHtml(ENHANCED_MEMORY_TYPE_LABELS[item.primary?.type] || item.primary?.type || '记忆')}</span>
                <strong>${Math.round(Number(item.score || 0) * 100)}%</strong>
                <p>${escapeHtml(item.primary?.content || '')}</p>
                <p>${escapeHtml(item.duplicate?.content || '')}</p>
            </div>
            <button class="btn-primary" data-memory-merge-target="${item.primary?.id}" data-memory-merge-source="${item.duplicate?.id}">合并</button>
        </div>
    `).join(''));
}

window.Pivot.legacy.loadMemoryMergeSuggestions = async function() {
    const button = document.getElementById('memory-merge-suggestions-btn');
    if (button) button.disabled = true;
    try {
        renderMemoryMergeSuggestions(await fetchMemoryMergeSuggestions());
    } catch (e) {
        showToast(e.message || '合并建议加载失败', 'error');
    } finally {
        if (button) button.disabled = false;
    }
};

function memoryQueryParams(page = pageState.memories || 1) {
    const params = new URLSearchParams();
    const limit = Number(pageState.limit || 15);
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    params.set('status', document.getElementById('memory-status-filter')?.value || 'active');
    params.set('limit', String(limit));
    params.set('offset', String((currentPage - 1) * limit));
    const type = document.getElementById('memory-type-filter')?.value || '';
    const search = document.getElementById('memory-search-input')?.value?.trim?.() || '';
    if (type) params.set('type', type);
    if (search) params.set('search', search);
    return params;
}

function selectedMemoryIds() {
    return Array.from(document.querySelectorAll('[data-memory-select]:checked'))
        .map(input => Number(input.value))
        .filter(Number.isSafeInteger);
}

function renderMemoryQualityPanel(summary = {}) {
    const panel = document.getElementById('memory-quality-panel');
    if (!panel) return;
    const quality = summary.quality || {};
    const jobs = quality.jobSummary || {};
    const statusLabel = quality.status === 'healthy' ? '健康' : quality.status === 'attention' ? '需关注' : '待复核';
    const items = [
        ['质量状态', statusLabel],
        ['重复建议', Number(quality.duplicateSuggestions || 0)],
        ['低置信', Number(quality.lowConfidence || 0)],
        ['过期', Number(quality.expired || 0)],
        ['任务积压', Number(jobs.queued || 0) + Number(jobs.running || 0)],
        ['失败任务', Number(jobs.failed || 0)]
    ];
    PivotSafeHtml.setHtml(panel, items.map(([label, value]) => `
        <div class="memory-quality-card">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
        </div>
    `).join(''));
}

function renderMemoryJobsPanel(jobsData = {}) {
    const panel = document.getElementById('memory-jobs-panel');
    if (!panel) return;
    const summary = jobsData.summary || {};
    const running = Number(summary.running || 0);
    const queued = Number(summary.queued || 0);
    const failed = Number(summary.failed || 0);
    PivotSafeHtml.setHtml(panel, `
        <div class="memory-jobs-line">
            <span>抽取任务</span>
            <strong>${queued} 排队 / ${running} 执行 / ${failed} 失败</strong>
            <button id="memory-jobs-retry-btn" class="btn-secondary" type="button" ${failed ? '' : 'disabled'}>重试失败</button>
            <button id="memory-jobs-cleanup-btn" class="btn-secondary" type="button">清理旧任务</button>
        </div>
    `);
}

function renderProductMemoryRows(memories = []) {
    const body = document.getElementById('memory-list-body');
    if (!body) return;
    const colspan = 8;
    if (!memories.length) {
        PivotSafeHtml.setHtml(body, `<tr><td colspan="${colspan}" class="text-center muted">暂无长期记忆</td></tr>`);
        return;
    }
    PivotSafeHtml.setHtml(body, memories.map(memory => `
        <tr>
            <td><input type="checkbox" data-memory-select value="${memory.id}"></td>
            <td><span class="memory-type-badge">${escapeHtml(ENHANCED_MEMORY_TYPE_LABELS[memory.type] || memory.type || '记忆')}</span></td>
            <td class="memory-content-cell" data-full-content="${escapeHtml(memory.content || '')}">${escapeHtml(memory.content || '')}</td>
            <td>${Number(memory.salience || 0).toFixed(2)}</td>
            <td>${Number(memory.confidence || 0).toFixed(2)}</td>
            <td>${escapeHtml(formatMemoryStatusLabel(memory.status))}</td>
            <td>${escapeHtml(memory.lastUsedAt || memory.updatedAt || '-')}</td>
            <td class="text-center memory-action-cell">
                <div class="memory-action-buttons">
                    <button class="btn-secondary memory-source-btn" data-memory-action="source" data-memory-id="${memory.id}" ${memory.sourceMessageIds?.length ? '' : 'disabled'}>来源</button>
                    <button class="btn-secondary" data-memory-action="edit" data-memory-id="${memory.id}">编辑</button>
                    ${memory.status === 'active'
                        ? `<button class="btn-secondary" data-memory-action="disable" data-memory-id="${memory.id}">禁用</button>`
                        : `<button class="btn-secondary" data-memory-action="restore" data-memory-id="${memory.id}">恢复</button>`}
                    <button class="btn-danger" data-memory-action="delete" data-memory-id="${memory.id}">删除</button>
                </div>
            </td>
        </tr>
    `).join(''));
    window.Pivot?.getModule?.('settings.memoryUi')?.initMemoryContentTooltips?.();
}

async function fetchMemoryQuality() {
    const res = await apiFetch(`${API_BASE}/memories/quality`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆质量摘要加载失败');
    return data.summary || {};
}

async function fetchMemoryJobs() {
    const res = await apiFetch(`${API_BASE}/memories/jobs?limit=20`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '记忆任务加载失败');
    return data;
}

async function bulkUpdateMemoryStatus(ids, status) {
    const res = await apiFetch(`${API_BASE}/memories/status/bulk`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '批量更新失败');
    return data;
}

async function retryMemoryJobs() {
    const res = await apiFetch(`${API_BASE}/memories/jobs/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务重试失败');
    return data;
}

async function cleanupMemoryJobs() {
    const res = await apiFetch(`${API_BASE}/memories/jobs/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 30 }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务清理失败');
    return data;
}

async function archiveExpiredMemories() {
    const res = await apiFetch(`${API_BASE}/memories/maintenance/archive-expired`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '过期记忆归档失败');
    return data;
}

function renderMemoryPagination(tab, total, currentPage) {
    const container = document.getElementById(`pagination-${tab}`);
    if (!container) return;
    const renderWorkspacePagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
    renderWorkspacePagination?.(container, {
        total,
        limit: pageState.limit,
        page: currentPage,
        onPageChange: targetPage => window.Pivot.legacy.loadMemories?.(targetPage)
    });
}

window.Pivot.legacy.loadMemories = async function(page = pageState.memories || 1) {
    const toggle = document.getElementById('long-term-memory-toggle');
    const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    pageState.memories = requestedPage;
    try {
        const [memoriesRes, qualitySummary, jobsData] = await Promise.all([
            apiFetch(`${API_BASE}/memories?${memoryQueryParams(requestedPage).toString()}`),
            fetchMemoryQuality().catch(() => ({})),
            fetchMemoryJobs().catch(() => ({}))
        ]);
        const data = await memoriesRes.json();
        if (!memoriesRes.ok) throw new Error(data.error || '长期记忆加载失败');
        if (toggle) toggle.checked = data.enabled !== false;
        const total = Number(data.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / Number(pageState.limit || 15)));
        if (total > 0 && requestedPage > totalPages) {
            await window.Pivot.legacy.loadMemories(totalPages);
            return;
        }
        currentLongTermMemories = Array.isArray(data.memories) ? data.memories : [];
        renderEnhancedMemorySummary(data.summary);
        renderProductMemoryRows(currentLongTermMemories);
        renderMemoryPagination('memories', total, requestedPage);
        renderMemoryQualityPanel(qualitySummary);
        renderMemoryJobsPanel(jobsData);
    } catch (e) {
        renderMemoryPagination('memories', 0, 1);
        showToast(e.message || '长期记忆加载失败', 'error');
    }
};

window.Pivot.legacy.exportMemories = async function() {
    try {
        const res = await apiFetch(`${API_BASE}/memories/export?${memoryQueryParams().toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '长期记忆导出失败');
        const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `pivot-memories-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showToast('长期记忆已导出');
    } catch (e) {
        showToast(e.message || '长期记忆导出失败', 'error');
    }
};


window.Pivot?.exposeModule?.('settings.memory', {
    archiveExpiredMemories,
    bulkUpdateMemoryStatus,
    cleanupMemoryJobs,
    deleteMemory,
    getCurrentMemory,
    mergeMemoryPair,
    openMemoryUsageModal,
    retryMemoryJobs,
    saveMemory,
    selectedMemoryIds,
    updateMemoryStatus
});
