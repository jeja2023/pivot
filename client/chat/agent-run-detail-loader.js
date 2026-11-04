(function () {
    let sequence = 0, pendingFetch = null, shell = null;
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

    function cancel() { pendingFetch?.abort(); pendingFetch = null; }
    async function read(runId, full = false) {
        cancel();
        const controller = new AbortController(); pendingFetch = controller;
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}${full || fullViews.has(runId) ? '' : '?view=overview'}`, { cache: 'no-store', signal: controller.signal });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '任务详情暂时无法读取，请重试。');
            if (full && response.ok) fullViews.add(runId);
            return { response, data };
        } catch (error) {
            if (controller.signal.aborted) throw new Error('任务详情请求已取消或超过等待时间，请重试。');
            throw error;
        } finally { clearTimeout(timer); if (pendingFetch === controller) pendingFetch = null; }
    }

    function showFailure(container, error, retry) {
        if (!container) return;
        const body = document.createElement('div'); body.className = 'empty-state agent-empty-state';
        const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error.message || '任务详情加载失败。';
        const button = document.createElement('button'); button.className = 'btn-secondary'; button.textContent = '重试加载'; button.addEventListener('click', retry);
        body.append(message, button); container.replaceChildren(body);
    }

    function offerFull(container, runId, data) {
        if (!container) return;
        if (!data.diagnosticsDeferred && !data.warnings?.length) return;
        const notice = document.createElement('div'); notice.className = 'workspace-notice';
        const copy = document.createElement('p'); copy.textContent = data.diagnosticsDeferred ? '已显示任务和最近执行记录，完整日志与诊断按需加载。' : '部分诊断暂时无法加载，已有状态和记录已保留，可重试。';
        const button = document.createElement('button'); button.className = 'btn-secondary'; button.textContent = '加载完整记录与诊断';
        button.addEventListener('click', () => { button.disabled = true; window.Pivot.legacy.openAgentRun(runId, { full: true }); });
        notice.append(copy, button); container.prepend(notice);
    }

    async function readOrShowFailure(runId, options, container, isCurrent) {
        try { return await read(runId, options.full === true); }
        catch (error) { if (isCurrent()) showFailure(container, error, () => window.Pivot.legacy.openAgentRun(runId, options)); return null; }
    }

    window.Pivot.exposeModule('agent.detailLoader', { cancel, read, readOrShowFailure, openFromChat, offerFull, showFailure, ensureVisible });
})();
