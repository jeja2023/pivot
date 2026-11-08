(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling, { esc } = app;
    const byId = id => document.getElementById(id);
    const labels = { receiving: '待上传', queued: '等待执行', retry_wait: '等待重试', running: '正在导入', cancelling: '正在取消', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
    let rows = [], selected = null, timer = null, controller = null, activeSession = '', serial = 0, dialogOwner = '';
    function opened(userId) {
        if (dialogOwner !== m.owner() && byId('ingestion-task-table')) { clearTimeout(timer); controller?.abort(); rows = []; selected = null; m.closeDialog(); return false; }
        return m.owner() === userId && dialogOwner === userId && !byId('data-analysis-modeling-dialog')?.classList.contains('hidden') && Boolean(byId('ingestion-task-table'));
    }
    const field = (form, name) => form.elements.namedItem(`ingestion_${name}`);

    async function csvHeaders(file) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const text = decoder.decode(await file.slice(0, 65536).arrayBuffer(), { stream: true }).replace(/^\uFEFF/, '');
        const headers = []; let value = '', quoted = false, closed = false;
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (quoted) {
                if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
                else if (char === '"') { quoted = false; closed = true; }
                else value += char;
            } else if (char === '"' && !value && !closed) quoted = true;
            else if (char === ',' || char === '\n' || char === '\r') {
                headers.push(value); value = ''; closed = false;
                if (char !== ',') return headers;
            } else {
                if (closed) throw new Error('CSV 表头引号后出现额外字符，请整理表头。');
                value += char;
            }
        }
        throw new Error('未在文件开头找到完整 CSV 表头，请使用带表头的 UTF-8 CSV。');
    }

    function renderTasks() {
        const box = byId('ingestion-task-table');
        if (!box) return;
        m.html(box, m.table(['数据集', '上传', '状态', '操作'], rows.map(row => `<tr><td title="${esc(row.originalName)}">${esc(row.name)}</td><td>${esc(Math.round(row.receivedBytes / row.expectedBytes * 100))}%</td><td title="${esc(row.lastError)}">${esc(labels[row.status] || row.status)}${row.lastError ? '（请查看详情）' : ''}</td><td>${row.status === 'receiving' ? `<button class="btn-secondary" type="button" data-ingestion-resume="${esc(row.id)}">继续上传</button>` : ''}${['receiving', 'queued', 'running', 'retry_wait'].includes(row.status) ? `<button class="btn-secondary" type="button" data-ingestion-cancel="${esc(row.id)}">取消</button>` : ''}${row.status === 'succeeded' && row.datasetId ? `<button class="btn-secondary" type="button" data-ingestion-open="${esc(row.datasetId)}">查看数据集</button>` : ''}${row.lastError ? `<button class="btn-secondary" type="button" data-ingestion-detail="${esc(row.id)}">详情</button>` : ''}</td></tr>`), '暂无后台分批导入任务'));
    }

    async function refreshTasks(userId, generation) {
        const data = await m.request('/ingestions');
        if (generation !== serial || !opened(userId)) return;
        rows = data.ingestions; renderTasks();
        clearTimeout(timer);
        if (!document.hidden && rows.some(row => ['queued', 'running', 'retry_wait', 'cancelling'].includes(row.status))) timer = setTimeout(() => { void refreshTasks(userId, generation).catch(error => { if (opened(userId)) app.toast(error.message, 'error'); }); }, 2000);
    }

    async function upload(form, userId, generation) {
        const file = field(form, 'file')?.files?.[0];
        if (!file || !/\.csv$/i.test(file.name) || file.size < 1 || file.size > 2 * 1024 ** 3) throw new Error('请选择不超过 2 GiB 的 UTF-8 CSV 文件。');
        const headers = await csvHeaders(file);
        const alive = () => generation === serial && opened(userId);
        if (!alive()) return;
        controller = new AbortController();
        const signal = controller.signal;
        const progress = message => { if (alive()) byId('ingestion-upload-progress').textContent = message; };
        try {
            let session = selected;
            if (session) {
                if (file.name !== session.originalName || file.size !== session.expectedBytes || JSON.stringify(headers) !== JSON.stringify(session.headers)) throw new Error('续传文件名、大小或字段与原文件不一致，请重新选择原文件。');
            } else {
                const expected = field(form, 'rows').value.trim();
                const data = await m.request('/ingestions', m.json({ name: field(form, 'name').value || file.name.replace(/\.csv$/i, ''), originalName: file.name, role: field(form, 'role').value, headers, expectedBytes: file.size, expectedRows: expected ? Number(expected) : null, sourceMetadata: app.sourceMetadata.read(form, 'ingestion_source'), requestKey: m.key() }));
                session = data.ingestion;
            }
            if (!alive()) return;
            selected = session; activeSession = session.id;
            await refreshTasks(userId, generation);
            const accepted = new Map(session.chunks.map(chunk => [chunk.index, chunk.digest]));
            for (let index = 0; index < session.expectedChunks; index++) {
                if (!alive() || signal.aborted) return;
                const bytes = await file.slice(index * session.chunkBytes, Math.min(file.size, (index + 1) * session.chunkBytes)).arrayBuffer();
                const hash = Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
                if (!alive() || signal.aborted) return;
                if (accepted.has(index)) {
                    if (accepted.get(index) !== hash) throw new Error('原文件内容已变化，不能覆盖已确认分块。');
                } else await m.request(`/ingestions/${encodeURIComponent(session.id)}/chunks/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': hash }, body: bytes, signal, timeoutMs: 120000 });
                progress(`已确认 ${index + 1} / ${session.expectedChunks} 块。关闭此窗口会停止后续上传，可选择原文件继续。`);
            }
            if (!alive() || signal.aborted) return;
            await m.request(`/ingestions/${encodeURIComponent(session.id)}/submit`, m.json({}));
            if (!alive()) return;
            selected = null; app.toast('文件已完整到齐，已提交后台导入；可在后台分批导入中查看状态。', 'success');
        } finally { activeSession = ''; controller = null; }
    }

    function openIngestion() {
        clearTimeout(timer); controller?.abort(); selected = null; rows = [];
        const userId = m.owner(), generation = ++serial;
        dialogOwner = userId;
        m.dialog('后台分批导入 CSV', `<p class="text-muted">使用带表头的 UTF-8 CSV。事实明细最多一百万行，维度数据最多两百万行，文件最多 2 GiB、一百二十列。完整接收文件后按声明登记业务覆盖范围；单元格预览最多 256 字，完整值保留在数据中。</p><label>CSV 文件<input class="form-input" type="file" name="ingestion_file" accept=".csv" required></label><label>数据集名称<input class="form-input" name="ingestion_name" maxlength="120"></label><label>用途<select class="form-input" name="ingestion_role"><option value="fact">事实明细</option><option value="dimension">维度数据</option></select></label><label>预期数据行数（可选，用于完整性核对）<input class="form-input" name="ingestion_rows" type="number" min="1" max="2000000"></label>${app.sourceMetadata.markup('ingestion_source')}<p id="ingestion-upload-progress" role="status" aria-live="polite">选择文件后开始上传；网络中断时已确认分块保留一天。</p><h4>最近后台导入</h4><div id="ingestion-task-table" aria-live="polite"></div>`, form => upload(form, userId, generation));
        byId('modeling-dialog-form').querySelector('[type="submit"]').textContent = '上传并开始导入';
        void refreshTasks(userId, generation).catch(error => { if (opened(userId)) app.toast(error.message, 'error'); });
    }

    function mountAction() {
        const toolbar = document.querySelector('#data-analysis-view .data-analysis-toolbar-actions');
        if (!toolbar || toolbar.dataset.toolbarTab !== 'overview' || byId('data-analysis-controlled-ingestion')) return;
        const button = document.createElement('button'); button.type = 'button'; button.id = 'data-analysis-controlled-ingestion'; button.className = 'btn-secondary'; button.textContent = '后台分批导入 CSV'; toolbar.appendChild(button);
    }
    const header = app.renderHeader;
    app.renderHeader = function (...args) { const value = header(...args); mountAction(); return value; };
    const onTab = app.onDataAnalysisTabActivated;
    app.onDataAnalysisTabActivated = function (tab) { onTab?.(tab); if (tab === 'overview') mountAction(); };
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(timer);
        else if (byId('ingestion-task-table') && opened(m.owner())) void refreshTasks(m.owner(), serial).catch(() => {});
    });
    document.addEventListener('click', event => {
        if (event.target.closest('#data-analysis-controlled-ingestion')) { openIngestion(); return; }
        if (event.target.closest('[data-ingestion-resume],[data-ingestion-cancel],[data-ingestion-open],[data-ingestion-detail]') && !opened(dialogOwner)) return;
        const resume = event.target.closest('[data-ingestion-resume]');
        if (resume) {
            selected = rows.find(row => row.id === resume.dataset.ingestionResume);
            if (selected) { byId('ingestion-upload-progress').textContent = `继续上传「${selected.originalName}」：请选择同一个原文件。`; const form = byId('modeling-dialog-form'); field(form, 'name').value = selected.name; field(form, 'role').value = selected.role; field(form, 'rows').value = selected.expectedRows || ''; app.sourceMetadata.fill(form, 'ingestion_source', selected.sourceMetadata); field(form, 'file').focus(); }
            return;
        }
        const detail = event.target.closest('[data-ingestion-detail]');
        if (detail) { byId('ingestion-upload-progress').textContent = rows.find(row => row.id === detail.dataset.ingestionDetail)?.lastError || '暂无错误详情。'; return; }
        const cancel = event.target.closest('[data-ingestion-cancel]');
        if (cancel) {
            const userId = m.owner(), generation = serial;
            if (activeSession === cancel.dataset.ingestionCancel) controller?.abort();
            void m.request(`/ingestions/${encodeURIComponent(cancel.dataset.ingestionCancel)}/cancel`, m.json({})).then(() => refreshTasks(userId, generation)).catch(error => { if (opened(userId)) app.toast(error.message, 'error'); });
            return;
        }
        const open = event.target.closest('[data-ingestion-open]');
        if (open) {
            const userId = m.owner(); m.closeDialog();
            void app.loadDatasets().then(() => { if (m.owner() === userId) return app.loadDatasetDetail(open.dataset.ingestionOpen); }).catch(error => { if (m.owner() === userId) app.toast(error.message, 'error'); });
        }
    });
})();
