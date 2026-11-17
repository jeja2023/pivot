(function () {
    let sequence = 0, pendingFetch = null, pendingRun = '', pendingFull = false, shell = null;
    const fullViews = new Set();
    function ensureVisible() {
        const modal = document.getElementById('agent-run-detail-modal');
        if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
        return modal;
    }

    function loadingShell(message, retry) {
        shell?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay'; overlay.id = 'agent-run-loading';
        const dialog = document.createElement('section'); dialog.className = 'workspace-modal';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '任务详情');
        const header = document.createElement('div'); header.className = 'workspace-modal-header';
        const title = document.createElement('strong'); title.textContent = '任务详情'; header.append(title);
        const close = document.createElement('button'); close.className = 'btn-secondary'; close.textContent = '关闭';
        close.addEventListener('click', () => { sequence++; overlay.remove(); }); header.append(close);
        overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close.click(); });
        const body = document.createElement('div'); body.className = 'workspace-modal-body';
        const copy = document.createElement('p'); copy.setAttribute('role', 'status'); copy.textContent = message; body.append(copy);
        if (retry) { const button = document.createElement('button'); button.className = 'btn-secondary'; button.textContent = '重试加载'; button.addEventListener('click', retry); body.append(button); }
        dialog.append(header, body); overlay.append(dialog); document.body.append(overlay); shell = overlay; close.focus();
    }

    async function openFromChat(runId) {
        const ticket = ++sequence;
        loadingShell('正在准备任务详情，请稍候…');
        let timer;
        try {
            if (typeof window.Pivot.legacy.openAgentRun !== 'function') await Promise.race([
                window.Pivot.legacy.ensureWorkspaceScripts('agent'),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('详情模块加载超时，请重试或刷新页面。')), 15000); })
            ]);
            if (ticket !== sequence) return null;
            if (typeof window.Pivot.legacy.openAgentRun !== 'function') throw new Error('任务详情模块未就绪，请重试。');
            shell?.remove();
            return await window.Pivot.legacy.openAgentRun(runId);
        } catch (error) {
            if (ticket === sequence) loadingShell(error.message || '任务详情加载失败，请重试。', () => openFromChat(runId));
            return null;
        } finally { clearTimeout(timer); }
    }

    function cancel() { pendingFetch?.abort(); pendingFetch = null; pendingRun = ''; pendingFull = false; }
    function isFullLoading(runId) { return Boolean(pendingFetch && pendingFull && pendingRun === String(runId)); }
    async function read(runId, full = false) {
        cancel();
        const controller = new AbortController(); pendingFetch = controller;
        pendingRun = String(runId); pendingFull = full;
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}${full || fullViews.has(runId) ? '' : '?view=overview'}`, { cache: 'no-store', signal: controller.signal });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '任务详情暂时无法读取，请重试。');
            if (controller.signal.aborted || pendingFetch !== controller) throw new Error('任务详情请求已取消或超过等待时间，请重试。');
            if (full && response.ok) fullViews.add(runId);
            return { response, data };
        } catch (error) {
            if (controller.signal.aborted) throw new Error('任务详情请求已取消或超过等待时间，请重试。');
            throw error;
        } finally { clearTimeout(timer); if (pendingFetch === controller) { pendingFetch = null; pendingRun = ''; pendingFull = false; } }
    }

    function showFailure(container, error, retry, preserve = false, full = false) {
        if (!container) return;
        if (preserve) return setNotice(container, error.message || '任务详情加载失败，请重试。', retry, full ? '重试加载完整记录' : '重试加载');
        const body = document.createElement('div'); body.className = 'empty-state agent-empty-state';
        const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error.message || '任务详情加载失败。';
        const button = document.createElement('button'); button.className = 'btn-secondary'; button.textContent = '重试加载'; button.addEventListener('click', retry);
        body.append(message, button);
        if (container.id === 'agent-tasks-detail-container') {
            document.getElementById('agent-tasks-view')?.classList.add('has-active-detail');
            const pane = document.getElementById('agent-pane-overview');
            document.querySelectorAll('[data-agent-run-pane]').forEach(item => item.classList.toggle('hidden', item !== pane));
            document.querySelectorAll('[data-agent-run-subtab]').forEach(item => { const active = item.dataset.agentRunSubtab === 'overview'; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
            document.getElementById('agent-run-detail-empty')?.classList.add('hidden');
            document.getElementById('agent-detail-header-actions')?.replaceChildren();
            if (pane) pane.replaceChildren(body);
        } else container.replaceChildren(body);
    }

    function showWorkbenchLoading() {
        document.getElementById('agent-tasks-view')?.classList.add('has-active-detail');
        document.getElementById('agent-run-detail-empty')?.classList.add('hidden');
        document.getElementById('agent-detail-header-actions')?.replaceChildren();
        document.getElementById('agent-context-pane-body')?.replaceChildren();
        document.querySelectorAll('[data-agent-run-pane]').forEach(pane => { pane.replaceChildren(); pane.classList.toggle('hidden', pane.dataset.agentRunPane !== 'overview'); });
        document.querySelectorAll('[data-agent-run-subtab]').forEach(tab => { const active = tab.dataset.agentRunSubtab === 'overview'; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
        const pane = document.getElementById('agent-pane-overview');
        if (pane) { const message = document.createElement('div'); message.className = 'empty-state agent-empty-state'; message.setAttribute('role', 'status'); message.textContent = '正在加载任务详情…'; pane.append(message); }
    }

    function clearNotice(container) { container?.querySelectorAll('[data-agent-detail-notice]').forEach(item => item.remove()); }
    function retainNotice(container, runId) {
        if (!container || container.dataset.detailRunId !== String(runId)) return null;
        const notice = container.querySelector(':scope > [data-agent-detail-notice]');
        if (!notice) return null;
        const focused = notice.contains(document.activeElement), scrollTop = container.scrollTop;
        notice.remove();
        return () => { container.prepend(notice); container.scrollTop = scrollTop; if (focused) notice.querySelector('button')?.focus({ preventScroll: true }); };
    }
    function setNotice(container, text, action, label, identity = '') {
        clearNotice(container);
        const notice = document.createElement('div'); notice.className = 'agent-run-detail-notice'; notice.dataset.agentDetailNotice = 'true';
        if (identity) notice.dataset.noticeIdentity = identity;
        const copy = document.createElement('p'); copy.textContent = text; copy.setAttribute('role', 'status');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-secondary'; button.textContent = label;
        button.addEventListener('click', () => {
            button.disabled = true; copy.textContent = '正在加载任务详情…';
            Promise.resolve().then(action).catch(error => {
                if (!notice.isConnected) return;
                copy.textContent = error.message || '任务详情加载失败，请重试。'; button.disabled = false;
            });
        });
        notice.append(copy, button);
        const header = container.querySelector(':scope > .agent-detail-header-bar');
        if (header) header.after(notice); else container.prepend(notice);
    }
    function offerFull(container, runId, data, options = {}) {
        if (!container) return;
        if (!data.diagnosticsDeferred && !data.warnings?.length) { clearNotice(container); return; }
        const copy = data.diagnosticsDeferred ? '已显示任务和最近执行记录，完整日志与诊断按需加载。' : '部分诊断暂时无法加载，已有状态和记录已保留，可重试。';
        const identity = `${runId}:${data.diagnosticsDeferred ? 'overview' : 'partial'}:${options.workflowPreview === true}`;
        if (container.querySelector('[data-agent-detail-notice]')?.dataset.noticeIdentity === identity) return;
        setNotice(container, copy, () => window.Pivot.legacy.openAgentRun(runId, { ...options, full: true, silent: true }), data.diagnosticsDeferred ? '加载完整记录与诊断' : '重试加载完整记录', identity);
    }

    async function readOrShowFailure(runId, options, container, isCurrent) {
        try { return await read(runId, options.full === true); }
        catch (error) { if (isCurrent()) showFailure(container, error, () => window.Pivot.legacy.openAgentRun(runId, options), (options.full === true || options.silent === true) && container?.dataset.detailRunId === String(runId), options.full === true); return null; }
    }

    window.Pivot.exposeModule('agent.detailLoader', { cancel, read, readOrShowFailure, openFromChat, offerFull, showFailure, ensureVisible, clearNotice, isFullLoading, showWorkbenchLoading, retainNotice });
})();
