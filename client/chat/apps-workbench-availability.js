(function () {
    let owner = '';
    let catalog = null;
    let pending = null;
    let sequence = 0;
    let checkedAt = 0;
    let errorMessage = '';
    const saving = new Set();
    const identity = () => String(window.Pivot.legacy.currentUser?.id || '');

    function syncOwner() {
        const current = identity();
        if (owner !== current) {
            owner = current;
            catalog = null;
            pending = null;
            checkedAt = 0;
            errorMessage = '';
            saving.clear();
            sequence += 1;
        }
        return current;
    }

    function isEnabled(id) {
        syncOwner();
        return Boolean(catalog?.apps.some(app => app.id === id && app.enabled));
    }

    function visibleApps(apps) {
        syncOwner();
        return apps.filter(app => catalog?.apps.some(item => item.id === app.id));
    }

    function render(apps) {
        syncOwner();
        const grid = document.getElementById('apps-grid');
        const empty = document.getElementById('apps-empty');
        if (!grid || !empty) return;
        const focused = document.activeElement;
        const focusId = grid.contains(focused) ? focused.dataset.appToggle || focused.dataset.appId : '';
        const focusAttribute = focused?.dataset.appToggle ? 'appToggle' : 'appId';
        const visible = visibleApps(apps);
        empty.classList.toggle('hidden', visible.length > 0);
        if (!visible.length) {
            PivotSafeHtml.setHtml(grid, '');
            PivotSafeHtml.setHtml(empty, errorMessage
                ? `${escapeAppsHtml(errorMessage)} <button class="btn-secondary" type="button" data-app-catalog-retry>重试</button>`
                : catalog ? '暂无已开启的应用，请联系系统 admin。' : '正在加载应用…');
            return;
        }
        PivotSafeHtml.setHtml(grid, visible.map(app => {
            const enabled = isEnabled(app.id);
            const busy = saving.has(app.id);
            return `<article class="app-card ${catalog.canManage ? 'has-management' : ''} ${enabled ? 'is-enabled' : 'is-disabled'}">
                ${catalog.canManage ? `<div class="app-card-management">
                    <button class="app-card-switch ${enabled ? 'is-enabled' : 'is-disabled'} btn-pill" type="button" role="switch" aria-checked="${enabled}" data-app-toggle="${escapeAppsHtml(app.id)}" aria-label="${enabled ? '关闭' : '开启'}${escapeAppsHtml(app.name)}" ${busy ? 'disabled aria-busy="true"' : ''} title="${enabled ? '点击关闭应用' : '点击开启应用'}">
                        <span class="app-card-switch-track" aria-hidden="true"><span class="app-card-switch-thumb"></span></span>
                        <span class="app-card-switch-label">${busy ? '保存中…' : enabled ? '关闭' : '开启'}</span>
                    </button>
                </div>` : ''}
                <button class="btn-secondary app-card-open" type="button" data-app-id="${escapeAppsHtml(app.id)}" aria-label="打开${escapeAppsHtml(app.name)}" ${enabled ? '' : 'disabled'}>
                    <span class="app-card-head">
                        <span class="app-card-icon app-card-icon-${escapeAppsHtml(app.id)}">${getAppIconSvg(app.icon)}</span>
                        <span class="app-card-badges">
                            <span class="app-card-category">${escapeAppsHtml(app.category)}</span>
                            <em class="app-card-status">${enabled ? (app.status === 'available' ? '可用' : '规划中') : '已关闭'}</em>
                        </span>
                    </span>
                    <span class="app-card-main">
                        <strong class="app-card-title">${escapeAppsHtml(app.name)}</strong>
                        <span class="app-card-desc">${escapeAppsHtml(app.description)}</span>
                        <span class="app-card-tags">${(app.tags || []).map(tag => `<span class="app-card-tag">${escapeAppsHtml(tag)}</span>`).join('')}</span>
                    </span>
                </button>
            </article>`;
        }).join(''));
        if (focusId) {
            const replacement = Array.from(grid.querySelectorAll('button')).find(button => button.dataset[focusAttribute] === focusId && !button.disabled);
            replacement?.focus();
        }
    }

    function syncRelatedEntrances() {
        document.querySelectorAll('[data-data-analysis-tab]').forEach(button => {
            const id = button.dataset.dataAnalysisTab === 'modeling' ? 'data-modeling' : 'data-analysis';
            button.classList.toggle('hidden', !isEnabled(id));
        });
    }

    async function refresh() {
        const requestOwner = syncOwner();
        if (!requestOwner) return false;
        if (pending) return pending;
        const requestSequence = ++sequence;
        pending = (async () => {
            try {
                const response = await apiFetch(`${API_BASE}/apps/catalog`);
                const data = await response.json();
                if (!response.ok || !Array.isArray(data.apps)) throw new Error('应用列表加载失败，请重试。');
                if (identity() !== requestOwner || sequence !== requestSequence) return false;
                catalog = data;
                checkedAt = Date.now();
                errorMessage = '';
                syncRelatedEntrances();
                const modelingVisible = !document.getElementById('data-analysis-view')?.classList.contains('hidden')
                    && document.querySelector('.data-analysis-panel')?.classList.contains('is-modeling-immersive');
                const active = modelingVisible ? 'data-modeling' : getStoredAppsActiveApp();
                if (active && !isEnabled(active)) {
                    showAppsHome();
                    showToast('该应用已关闭，已返回应用中心。', 'warning');
                }
                return true;
            } catch (_error) {
                if (identity() === requestOwner && sequence === requestSequence) {
                    catalog = null;
                    checkedAt = 0;
                    errorMessage = '应用列表加载失败，请重试。';
                }
                return false;
            } finally {
                if (identity() === requestOwner && sequence === requestSequence) {
                    pending = null;
                    renderAppsGrid();
                }
            }
        })();
        return pending;
    }

    async function ensureEnabled(id) {
        syncOwner();
        if (Date.now() - checkedAt > 1000 && !await refresh()) throw new Error('无法确认应用状态，请返回应用中心重试。');
        if (!isEnabled(id)) throw new Error('该应用已关闭，请联系系统 admin 开启。');
    }

    async function toggle(id) {
        const requestOwner = syncOwner();
        if (!catalog?.canManage || saving.has(id)) return;
        const app = catalog.apps.find(item => item.id === id);
        if (!app) return;
        saving.add(id);
        renderAppsGrid();
        try {
            const response = await apiFetch(`${API_BASE}/apps/${encodeURIComponent(id)}/availability`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !app.enabled })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || '应用状态保存失败，请重试。');
            if (identity() !== requestOwner) return;
            // 写入确认后重新读取，避免覆盖其他 admin 会话刚保存的状态。
            if (pending) await pending;
            await refresh();
            if (identity() === requestOwner) showToast(`${app.name}已${data.app.enabled ? '开启' : '关闭'}`);
        } catch (error) {
            if (identity() === requestOwner) showToast(error.message || '应用状态保存失败，请重试。', 'error');
        } finally {
            if (identity() === requestOwner) {
                saving.delete(id);
                renderAppsGrid();
                document.querySelector(`[data-app-toggle="${id}"]`)?.focus();
            }
        }
    }

    document.addEventListener('click', event => {
        const toggleButton = event.target.closest('[data-app-toggle]');
        if (toggleButton) { void toggle(toggleButton.dataset.appToggle); return; }
        if (event.target.closest('[data-app-catalog-retry]')) void refresh();
    });
    setInterval(() => {
        const panel = document.getElementById('apps-workbench-modal');
        if (!document.hidden && panel && !panel.classList.contains('hidden')) void refresh();
    }, 15000);
    window.Pivot.exposeModule('apps.availability', { render, refresh, isEnabled, visibleApps, ensureEnabled, syncRelatedEntrances });
})();
