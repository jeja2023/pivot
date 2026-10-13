/* 拆自 admin-settings.js：长期记忆浮层提示与全局弹窗挂载辅助 */
(function() {
    let memoryTooltipEl = null;
    let memorySearchTimer = null;

    function getMemoryTooltip() {
        if (!memoryTooltipEl) {
            memoryTooltipEl = document.createElement('div');
            memoryTooltipEl.id = 'memory-cell-custom-tooltip';
            memoryTooltipEl.className = 'memory-custom-tooltip hidden';
            memoryTooltipEl.setAttribute('role', 'tooltip');
            document.body.appendChild(memoryTooltipEl);

            memoryTooltipEl.addEventListener('mouseenter', () => {
                memoryTooltipEl.classList.remove('hidden');
            });
            memoryTooltipEl.addEventListener('mouseleave', () => {
                memoryTooltipEl.classList.add('hidden');
            });
        }
        return memoryTooltipEl;
    }

    function ensureMemoryModalsAttached() {
        const editModal = document.getElementById('memory-edit-modal');
        const sourceModal = document.getElementById('memory-source-modal');
        const mergeModal = document.getElementById('memory-merge-modal');
        const evaluationsModal = document.getElementById('memory-evaluations-modal');
        if (editModal && editModal.parentElement !== document.body) {
            document.body.appendChild(editModal);
        }
        if (sourceModal && sourceModal.parentElement !== document.body) {
            document.body.appendChild(sourceModal);
        }
        if (mergeModal && mergeModal.parentElement !== document.body) {
            document.body.appendChild(mergeModal);
        }
        if (evaluationsModal && evaluationsModal.parentElement !== document.body) {
            document.body.appendChild(evaluationsModal);
        }
    }

    function initMemoryContentTooltips() {
        const tableBody = document.getElementById('memory-list-body');
        if (!tableBody || tableBody.__tooltipBound) return;
        tableBody.__tooltipBound = true;

        let hideTimer = null;

        tableBody.addEventListener('mouseover', (e) => {
            const cell = e.target.closest('.memory-content-cell');
            if (!cell) return;
            clearTimeout(hideTimer);
            const text = cell.getAttribute('data-full-content') || cell.textContent.trim();
            if (!text) return;

            const tooltip = getMemoryTooltip();
            if (window.Pivot.legacy.PivotSafeHtml?.setText) {
                window.Pivot.legacy.PivotSafeHtml.setText(tooltip, text);
            } else {
                tooltip.textContent = text;
            }
            tooltip.classList.remove('hidden');

            const rect = cell.getBoundingClientRect();
            const tooltipWidth = Math.min(560, Math.max(260, text.length * 10));
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = rect.left;
            if (left + tooltipWidth > viewportWidth - 20) {
                left = Math.max(10, viewportWidth - tooltipWidth - 20);
            }

            let top = rect.bottom + 6;
            if (top + 160 > viewportHeight && rect.top > 180) {
                top = rect.top - 6;
                tooltip.classList.add('tooltip-top');
            } else {
                tooltip.classList.remove('tooltip-top');
            }

            tooltip.style.left = `${Math.round(left)}px`;
            tooltip.style.top = `${Math.round(top)}px`;
        });

        tableBody.addEventListener('mouseout', (e) => {
            const cell = e.target.closest('.memory-content-cell');
            if (!cell) return;
            hideTimer = setTimeout(() => {
                if (memoryTooltipEl && !memoryTooltipEl.matches(':hover')) {
                    memoryTooltipEl.classList.add('hidden');
                }
            }, 80);
        });
    }


    function callSettingsMemoryAction(name, ...args) {
    const legacyAction = window.Pivot.legacy?.[name];
    if (typeof legacyAction === 'function') return legacyAction(...args);
    const api = window.Pivot.getModule?.('settings.memory');
    const action = api?.[name];
    if (typeof action !== 'function') {
        throw new Error('长期记忆功能仍在加载，请稍后重试。');
    }
    return action(...args);
}
async function reloadSettingsMemories(page = 1) {
    try {
        await callSettingsMemoryAction('loadMemories', page);
    } catch (error) {
        showToast(error.message || '长期记忆刷新失败', 'error');
    }
}



    function bindAdminMemorySettingsEvents() {
        document.getElementById('memory-refresh-btn')?.addEventListener('click', async () => {
    try { await callSettingsMemoryAction('loadMemories'); } catch (error) { showToast(error.message || '长期记忆刷新失败', 'error'); }
});
document.getElementById('long-term-memory-toggle')?.addEventListener('change', async (event) => {
    try {
        await callSettingsMemoryAction('updateLongTermMemoryEnabled', event.target.checked === true);
    } catch (error) {
        event.target.checked = !event.target.checked;
        showToast(error.message || '长期记忆设置保存失败', 'error');
    }
});

document.getElementById('memory-export-btn')?.addEventListener('click', async () => {
    try { await callSettingsMemoryAction('exportMemories'); } catch (error) { showToast(error.message || '长期记忆导出失败', 'error'); }
});
document.getElementById('memory-evaluations-open-btn')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('openMemoryEvaluationsModal'); } catch (error) { showToast(error.message || '检索评测窗口加载失败', 'error'); }
});
document.getElementById('memory-evaluations-close-btn')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('closeMemoryEvaluationsModal'); } catch (_) {}
});
document.getElementById('memory-evaluations-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) { try { callSettingsMemoryAction('closeMemoryEvaluationsModal'); } catch (_) {} }
});
document.getElementById('memory-evaluation-refresh-btn')?.addEventListener('click', async () => {
    try { await callSettingsMemoryAction('loadMemoryEvaluations'); } catch (error) { showToast(error.message || '记忆评测记录加载失败', 'error'); }
});
document.getElementById('memory-evaluation-run-btn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const result = await callSettingsMemoryAction('runMemoryEvaluation');
        const summary = result.run?.summary || {};
        showToast(`记忆评测完成：${Number(summary.passed || 0)}/${Number(summary.cases || 0)} 通过`);
        await callSettingsMemoryAction('loadMemoryEvaluations');
    } catch (error) {
        showToast(error.message || '记忆评测运行失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-evaluation-case-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
        const payload = {
            name: document.getElementById('memory-evaluation-name')?.value,
            query: document.getElementById('memory-evaluation-query')?.value,
            expectedMemoryIds: callSettingsMemoryAction('parseMemoryEvaluationIds', document.getElementById('memory-evaluation-expected')?.value),
            forbiddenMemoryIds: callSettingsMemoryAction('parseMemoryEvaluationIds', document.getElementById('memory-evaluation-forbidden')?.value)
        };
        const id = document.getElementById('memory-evaluation-id')?.value;
        if (id) await callSettingsMemoryAction('updateMemoryEvaluationCase', id, payload);
        else await callSettingsMemoryAction('createMemoryEvaluationCase', payload);
        callSettingsMemoryAction('resetMemoryEvaluationForm');
        showToast(id ? '记忆评测用例已更新' : '记忆评测用例已添加');
        await callSettingsMemoryAction('loadMemoryEvaluations');
    } catch (error) {
        showToast(error.message || '记忆评测用例创建失败', 'error');
    } finally {
        submit.disabled = false;
    }
});
document.getElementById('memory-evaluation-reset-btn')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('resetMemoryEvaluationForm'); } catch (error) { showToast(error.message, 'error'); }
});
document.getElementById('memory-evaluation-cases')?.addEventListener('click', async event => {
    const button = event.target?.closest?.('[data-memory-evaluation-action]');
    if (!button) return;
    const id = button.dataset.memoryEvaluationId;
    const action = button.dataset.memoryEvaluationAction;
    if (action === 'edit') {
        try {
            const item = callSettingsMemoryAction('getMemoryEvaluationCase', id);
            if (item) callSettingsMemoryAction('fillMemoryEvaluationForm', item);
        } catch (error) {
            showToast(error.message || '评测用例加载失败', 'error');
        }
        return;
    }
    button.disabled = true;
    try {
        await callSettingsMemoryAction('deleteMemoryEvaluationCase', id);
        callSettingsMemoryAction('resetMemoryEvaluationForm');
        showToast('记忆评测用例已删除');
        await callSettingsMemoryAction('loadMemoryEvaluations');
    } catch (error) {
        showToast(error.message || '记忆评测用例删除失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-search-input')?.addEventListener('input', () => {
    clearTimeout(memorySearchTimer);
    memorySearchTimer = setTimeout(() => { void reloadSettingsMemories(1); }, 250);
});
document.getElementById('memory-status-filter')?.addEventListener('change', () => { void reloadSettingsMemories(1); });
document.getElementById('memory-type-filter')?.addEventListener('change', () => { void reloadSettingsMemories(1); });
document.getElementById('memory-archive-expired-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const data = await callSettingsMemoryAction('archiveExpiredMemories');
        showToast(`已归档 ${Number(data.archived || 0)} 条过期记忆`);
            await callSettingsMemoryAction('loadMemories');
    } catch (e) {
        showToast(e.message || '过期记忆归档失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-select-all')?.addEventListener('change', (event) => {
    document.querySelectorAll('[data-memory-select]').forEach(input => {
        input.checked = event.target.checked === true;
    });
});
[
    { id: 'memory-bulk-enable-btn', status: 'active', success: '选中记忆已恢复', err: '批量恢复失败' },
    { id: 'memory-bulk-disable-btn', status: 'disabled', success: '选中记忆已禁用', err: '批量禁用失败' },
    { id: 'memory-bulk-delete-btn', status: 'deleted', success: '选中记忆已删除', err: '批量删除失败' }
].forEach(({ id, status, success, err }) => {
    document.getElementById(id)?.addEventListener('click', async (event) => {
        const ids = callSettingsMemoryAction('selectedMemoryIds');
        if (!ids.length) return showToast('请先选择记忆', 'warning');
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await callSettingsMemoryAction('bulkUpdateMemoryStatus', ids, status);
            showToast(success);
            await callSettingsMemoryAction('loadMemories');
        } catch (error) {
            showToast(error.message || err, 'error');
        } finally {
            button.disabled = false;
        }
    });
});
document.getElementById('memory-jobs-panel')?.addEventListener('click', async (event) => {
    const cleanupButton = event.target?.closest?.('#memory-jobs-cleanup-btn');
    if (!cleanupButton) return;
    cleanupButton.disabled = true;
    try {
        const data = await callSettingsMemoryAction('cleanupMemoryJobs');
        showToast(`已清理 ${Number(data.deleted || 0)} 个旧任务`);
        await callSettingsMemoryAction('loadMemories');
    } catch (e) {
        showToast(e.message || '任务维护失败', 'error');
    } finally {
        cleanupButton.disabled = false;
    }
});
document.getElementById('memory-list-body')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-memory-action]');
    if (!button) return;
    const action = button.dataset.memoryAction;
    if (action === 'edit' || action === 'usage') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const memoryId = button.dataset.memoryId;
    button.disabled = true;
    try {
        if (action === 'source') {
            await callSettingsMemoryAction('openMemorySourceModal', memoryId);
        } else if (action === 'disable' || action === 'restore') {
            const isDisable = action === 'disable';
            await callSettingsMemoryAction('updateMemoryStatus', memoryId, isDisable ? 'disabled' : 'active');
            showToast(isDisable ? '长期记忆已禁用' : '长期记忆已恢复');
            await callSettingsMemoryAction('loadMemories');
        } else if (action === 'delete') {
            await callSettingsMemoryAction('deleteMemory', memoryId);
            showToast('长期记忆已删除');
            await callSettingsMemoryAction('loadMemories');
        }
    } catch (e) {
        showToast(e.message || '长期记忆操作失败', 'error');
    } finally {
        button.disabled = false;
    }
}, true);
document.getElementById('memory-edit-cancel')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('closeMemoryEditModal'); } catch (_) {}
});
document.getElementById('memory-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = document.getElementById('memory-edit-save');
    if (saveButton) saveButton.disabled = true;
    const memoryId = document.getElementById('memory-edit-id')?.value;
    try {
        await callSettingsMemoryAction('saveMemory', memoryId, {
            type: document.getElementById('memory-edit-type')?.value,
            content: document.getElementById('memory-edit-content')?.value,
            salience: Number(document.getElementById('memory-edit-salience')?.value),
            confidence: Number(document.getElementById('memory-edit-confidence')?.value),
            scope: document.getElementById('memory-edit-scope')?.value,
            scopeReference: document.getElementById('memory-edit-scope-reference')?.value,
            projectId: document.getElementById('memory-edit-scope')?.value === 'project'
                ? document.getElementById('memory-edit-scope-reference')?.value : '',
            validFrom: document.getElementById('memory-edit-valid-from')?.value || null,
            expiresAt: document.getElementById('memory-edit-expires-at')?.value || null
        });
        showToast('长期记忆已保存');
        callSettingsMemoryAction('closeMemoryEditModal');
        await callSettingsMemoryAction('loadMemories');
    } catch (e) {
        showToast(e.message || '记忆保存失败', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
});
document.getElementById('memory-source-close')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('closeMemorySourceModal'); } catch (_) {}
});
document.getElementById('memory-merge-close')?.addEventListener('click', () => {
    try { callSettingsMemoryAction('closeMemoryMergeModal'); } catch (_) {}
});
document.getElementById('memory-merge-body')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-memory-merge-target]');
    if (!button) return;
    button.disabled = true;
    try {
        await callSettingsMemoryAction('mergeMemoryPair', button.dataset.memoryMergeTarget, button.dataset.memoryMergeSource);
        showToast('长期记忆已合并');
        await callSettingsMemoryAction('loadMemories');
        await callSettingsMemoryAction('openMemoryMergeSuggestionsModal');
    } catch (e) {
        showToast(e.message || '记忆合并失败', 'error');
    } finally {
        button.disabled = false;
    }
});
['memory-edit-modal', 'memory-source-modal'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', (event) => {
        if (event.target?.id === id) {
            if (id === 'memory-edit-modal') { try { callSettingsMemoryAction('closeMemoryEditModal'); } catch (_) {} }
            else if (id === 'memory-source-modal') { try { callSettingsMemoryAction('closeMemorySourceModal'); } catch (_) {} }
        }
    });
});

    }

    window.Pivot?.exposeModule?.('settings.memoryUi', {
        bindAdminMemorySettingsEvents,
        ensureMemoryModalsAttached,
        initMemoryContentTooltips
    });
})();
