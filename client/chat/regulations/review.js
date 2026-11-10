(function () {
    const API = '/api/apps/regulations/reviews';
    const view = window.Pivot.moduleApi('apps.policyReview.view');
    const state = { epoch: 0, owner: '', selected: new Map(), documents: [], materials: [], task: null, dirty: false, editRevision: 0, page: 1, documentPage: 1, requestKey: '', fingerprint: '', busy: false, operation: 0, policySequence: 0, listSequence: 0, timer: null, detailSequence: 0 };
    const byId = id => document.getElementById(id);
    const owner = () => String(window.Pivot.legacy.currentUser?.id || '');
    function visible() { return !document.hidden && byId('policy-review-overlay') && !byId('policy-review-overlay').classList.contains('hidden'); }
    function capture() {
        if (state.owner !== owner()) { reset(); return () => false; }
        const epoch = state.epoch, account = owner();
        return () => state.epoch === epoch && owner() === account && visible();
    }
    function message(text) { if (byId('policy-review-message')) byId('policy-review-message').textContent = text; }
    async function request(path, body, method = 'POST') {
        const response = await apiFetch(path, body === undefined ? { cache: 'no-store' } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error?.message || data.error || '操作未完成，请稍后重试。'), { status: response.status, code: data.code });
        return data;
    }
    function pagination(id, page, total, limit, action) {
        const host = byId(id), pages = Math.max(1, Math.ceil(total / limit));
        PivotSafeHtml.setHtml(host, `<button type="button" class="btn-secondary btn-xs" data-review-action="${action}-prev"${page <= 1 ? ' disabled' : ''}>上一页</button><span>第${page}/${pages}页 · ${total}项</span><button type="button" class="btn-secondary btn-xs" data-review-action="${action}-next"${page >= pages ? ' disabled' : ''}>下一页</button>`);
    }
    async function loadPolicies() {
        const current = capture(), sequence = ++state.policySequence, page = state.documentPage, query = byId('policy-review-policy-query').value;
        const data = await request(`/api/apps/regulations/documents?limit=10&offset=${(page - 1) * 10}&query=${encodeURIComponent(query)}`);
        if (!current() || sequence !== state.policySequence || page !== state.documentPage || query !== byId('policy-review-policy-query').value) return;
        state.documents = data.data || [];
        PivotSafeHtml.setHtml(byId('policy-review-policies'), view.policyRows(state.documents, state.selected));
        pagination('policy-review-policy-pagination', page, data.total || 0, 10, 'policies');
    }
    function renderMaterials() {
        PivotSafeHtml.setHtml(byId('policy-review-materials'), state.materials.map(item => `<li>${view.esc(item.title)} · ${item.characters}字符 <button type="button" class="btn-secondary btn-xs" data-review-remove-material="${Number(item.id)}">移出本次审查</button></li>`).join(''));
    }
    function selectedText() { byId('policy-review-selected').textContent = `已选择：${[...state.selected.values()].join('、') || '尚未选择制度'}`; }
    async function loadModels() {
        const current = capture(), select = byId('policy-review-model');
        select.disabled = true;
        const { models = [], defaultModelId } = await window.Pivot.legacy.loadSelectableModels();
        if (!current() || byId('policy-review-model') !== select) return;
        PivotSafeHtml.setHtml(select, models.map(model => `<option value="${view.esc(model.id)}">${view.esc(model.name || model.model_name)}</option>`).join('') || '<option value="">暂无可用模型</option>');
        if (models.some(model => String(model.id) === String(defaultModelId))) select.value = String(defaultModelId);
        select.disabled = models.length === 0;
    }
    function poll() {
        clearTimeout(state.timer);
        if (visible()) state.timer = setTimeout(() => { if (state.busy) return poll(); void refresh().catch(error => message(error.message)); }, 4000);
    }
    async function refresh() {
        const current = capture(), sequence = ++state.listSequence, page = state.page;
        const data = await request(`${API}?page=${page}`);
        if (!current() || sequence !== state.listSequence || page !== state.page) return;
        PivotSafeHtml.setHtml(byId('policy-review-tasks'), view.taskRows(data.tasks, data.page));
        pagination('policy-review-task-pagination', page, data.total, data.limit, 'tasks');
        if (state.task && !state.dirty) await loadDetail(state.task.id);
        if (state.task?.status === 'working' || data.tasks.some(item => item.status === 'working')) poll();
    }
    async function loadDetail(id) {
        const current = capture(), sequence = ++state.detailSequence;
        try {
            const { task } = await request(`${API}/${encodeURIComponent(id)}`);
            if (!current() || sequence !== state.detailSequence || state.dirty) return;
            if (state.task?.id === id && (task.version < state.task.version || task.version === state.task.version && task.processed < state.task.processed)) return;
            state.task = task;
            PivotSafeHtml.setHtml(byId('policy-review-detail'), view.detail(task));
        } catch (error) {
            if (!current() || sequence !== state.detailSequence) return;
            if ([403, 404].includes(error.status) || error.code === 'POLICY_REVIEW_SOURCE_CHANGED' || error.code === 'POLICY_REVIEW_VERSION_UNAVAILABLE') {
                state.task = null; state.dirty = false; byId('policy-review-detail').replaceChildren();
            }
            throw error;
        }
    }
    async function perform(action) {
        if (action === 'close') return close();
        if (state.busy) return;
        const current = capture(), operation = ++state.operation; state.busy = true;
        try {
            message('正在处理…');
            if (action === 'search') { state.documentPage = 1; await loadPolicies(); }
            else if (/^(policies|tasks)-(prev|next)$/.test(action)) {
                const [scope, direction] = action.split('-'), key = scope === 'policies' ? 'documentPage' : 'page';
                state[key] += direction === 'next' ? 1 : -1; await (scope === 'policies' ? loadPolicies() : refresh());
            } else if (action === 'refresh') await refresh();
            else if (state.task) {
                const task = state.task;
                if (action === 'save') {
                    const editRevision = state.editRevision;
                    const findings = [...byId('policy-review-detail').querySelectorAll('[data-review-finding]')].map(element => ({ id: element.dataset.reviewFinding,
                        status: element.querySelector('[data-review-field="status"]').value, analysis: element.querySelector('[data-review-field="analysis"]').value,
                        recommendation: element.querySelector('[data-review-field="recommendation"]').value }));
                    const result = await request(`${API}/${task.id}/report`, { version: task.version, findings, notes: byId('policy-review-notes').value }, 'PUT');
                    if (!current() || state.task?.id !== task.id || state.task.version !== task.version) return;
                    state.task = result.task;
                    if (editRevision !== state.editRevision) { message(`已保存版本${result.task.version}，保存期间的新修订仍保留，请再次保存。`); return; }
                    state.dirty = false; PivotSafeHtml.setHtml(byId('policy-review-detail'), view.detail(result.task));
                    message(`已保存报告版本${result.task.version}。`); return;
                }
                if (action === 'export') {
                    if (state.dirty) throw new Error('请先保存修订，再导出对应版本。');
                    const { delivery } = await request(`${API}/${task.id}/export`, { version: task.version });
                    if (!current() || state.task?.id !== task.id || state.task.version !== task.version) return;
                    await window.Pivot.loadScriptOnce('/chat/code-delivery.js');
                    if (!current()) return;
                    await window.Pivot.moduleApi('chat.codeDelivery').downloadRendition({ id: delivery.renditionId, format: 'docx', ready: true }, `${task.title} 第${task.version}版.docx`);
                    message('已下载可编辑Word报告，请复核初审建议后使用。'); return;
                }
                if (['cancel', 'resume', 'withdraw'].includes(action)) {
                    const confirm = window.Pivot.legacy.showConfirm;
                    const isWithdraw = action === 'withdraw';
                    const confirmTitle = isWithdraw ? '撤回审查报告' : '续跑审查';
                    const confirmPrompt = isWithdraw ? '撤回后将停止审查并禁止旧报告继续读取或下载。' : '将从未完成批次继续，累计用量不清零，仍会消耗所选模型用量。';
                    if (action !== 'cancel' && !await confirm(confirmTitle, confirmPrompt)) return;
                    if (!current()) return;
                    await request(`${API}/${task.id}${action === 'withdraw' ? '' : '/' + action}`, {}, action === 'withdraw' ? 'DELETE' : 'POST');
                    if (!current()) return;
                    state.dirty = false;
                    if (action === 'withdraw') { state.task = null; byId('policy-review-detail').replaceChildren(); }
                    else await loadDetail(task.id);
                    await refresh();
                }
            }
            if (current()) message('已更新。');
        } catch (error) { if (current()) message(error.message); }
        finally { if (state.operation === operation) state.busy = false; }
    }
    async function start(event) {
        event.preventDefault();
        if (state.busy) return;
        if (state.dirty) return message('请先保存当前报告修订，再创建另一项审查。');
        const model = byId('policy-review-model');
        if (model.disabled || !model.value) return message('请选择当前账号可用的执行模型。');
        const text = byId('policy-review-material-text').value.trim();
        const body = { title: byId('policy-review-report-title').value, asOf: byId('policy-review-date').value, scope: byId('policy-review-scope').value,
            documentIds: [...state.selected.keys()], materialIds: state.materials.map(item => item.id), materials: text ? [{ title: byId('policy-review-material-title').value, text }] : [], modelId: model.value };
        const fingerprint = JSON.stringify(body);
        if (state.fingerprint !== fingerprint) { state.fingerprint = fingerprint; state.requestKey = window.crypto.randomUUID(); }
        const current = capture(), operation = ++state.operation; state.busy = true; byId('policy-review-start').disabled = true;
        try {
            const { task } = await request(API, { ...body, requestKey: state.requestKey });
            if (!current()) return;
            state.dirty = false; byId('policy-review-composer').open = false;
            await loadDetail(task.id); await refresh(); poll(); message('审查已开始，可在任务中查看进度。');
        } catch (error) { if (current()) { if (error.code === 'POLICY_REVIEW_REQUEST_CONFLICT') state.fingerprint = ''; message(error.message); } }
        finally { if (state.operation === operation) { state.busy = false; if (byId('policy-review-start')) byId('policy-review-start').disabled = false; } }
    }
    async function upload(event) {
        if (state.busy) return;
        const files = [...event.target.files], current = capture();
        if (files.length + state.materials.length > 4) { event.target.value = ''; return message('上传材料最多四份。'); }
        const operation = ++state.operation; state.busy = true;
        try {
            for (const file of files) {
                if (file.size > 8 * 1024 * 1024) throw new Error('每份材料不能超过8MB。');
                const form = new FormData(); form.append('file', file);
                const response = await apiFetch(`${API}/materials`, { method: 'POST', body: form, timeoutMs: 120000 });
                const data = await response.json().catch(() => ({}));
                if (!current()) return;
                if (!response.ok) throw new Error(data.error || '材料提取失败，请检查文件。');
                state.materials.push(data.material); renderMaterials();
            }
            if (current()) message('材料已提取，将完整纳入本次审查。');
        } catch (error) { if (current()) message(error.message); }
        finally { if (state.operation === operation) state.busy = false; event.target.value = ''; }
    }
    function close() {
        clearTimeout(state.timer); state.epoch++; state.detailSequence++;
        byId('policy-review-overlay')?.classList.add('hidden');
        if (state.trigger?.isConnected) state.trigger.focus();
    }
    function reset() {
        close(); state.operation++; state.busy = false; state.owner = ''; state.selected.clear(); state.materials = []; state.task = null; state.dirty = false;
        state.listeners?.abort();
        state.fingerprint = ''; state.requestKey = ''; state.page = 1; state.documentPage = 1;
        byId('policy-review-overlay')?.remove();
    }
    function bind(overlay) {
        state.listeners?.abort(); state.listeners = new AbortController();
        overlay.addEventListener('click', event => {
            if (event.target === overlay) return close();
            const action = event.target.closest('[data-review-action]');
            if (action) { event.preventDefault(); void perform(action.dataset.reviewAction); }
            const remove = event.target.closest('[data-review-remove-material]');
            if (remove && !state.busy) { state.materials = state.materials.filter(item => item.id !== Number(remove.dataset.reviewRemoveMaterial)); renderMaterials(); }
            const open = event.target.closest('[data-review-open]');
            if (open && !state.busy) {
                if (state.dirty) return message('请先保存当前报告修订，再查看其他任务。');
                void loadDetail(open.dataset.reviewOpen).catch(error => message(error.message));
            }
        });
        overlay.addEventListener('change', event => {
            const id = Number(event.target.dataset.reviewDocument);
            if (id) {
                if (event.target.checked && state.selected.size >= 3) { event.target.checked = false; return message('最多选择三份制度。'); }
                if (event.target.checked) state.selected.set(id, state.documents.find(item => Number(item.id) === id)?.title || String(id));
                else state.selected.delete(id);
                selectedText();
            }
        });
        overlay.addEventListener('input', event => {
            if (!event.target.closest('#policy-review-detail')) return;
            state.dirty = true; state.editRevision++; byId('policy-review-save-status').textContent = '有未保存修订，请先保存再导出。';
        });
        byId('policy-review-form').addEventListener('submit', start);
        byId('policy-review-upload').addEventListener('change', upload);
        byId('policy-review-policy-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void perform('search'); } });
        document.addEventListener('keydown', event => {
            if (!visible()) return;
            if (event.key === 'Escape') close();
            if (event.key !== 'Tab') return;
            const nodes = [...overlay.querySelectorAll('button, input, select, textarea, summary')].filter(node => !node.disabled && node.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }, { signal: state.listeners.signal });
        document.addEventListener('visibilitychange', () => { if (!visible()) clearTimeout(state.timer); else void refresh().catch(error => message(error.message)); }, { signal: state.listeners.signal });
    }
    async function open() {
        const account = owner();
        state.trigger = document.activeElement;
        if (state.owner !== account) {
            byId('policy-review-overlay')?.remove(); state.selected.clear(); state.materials = []; state.task = null; state.dirty = false; state.owner = account;
        }
        let overlay = byId('policy-review-overlay');
        if (!overlay) {
            overlay = document.createElement('div'); overlay.id = 'policy-review-overlay'; overlay.className = 'modal-overlay policy-review-overlay';
            PivotSafeHtml.setHtml(overlay, view.shell()); document.body.appendChild(overlay); bind(overlay);
            byId('policy-review-date').value = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        }
        state.epoch++; overlay.classList.remove('hidden');
        byId('policy-review-report-title').focus();
        try { await loadModels(); await loadPolicies(); selectedText(); renderMaterials(); await refresh(); }
        catch (error) { message(error.message); }
    }
    window.Pivot.exposeModule('apps.policyReview', { open, close, reset });
})();
