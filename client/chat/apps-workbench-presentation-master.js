(function () {
    'use strict';
    const API = '/api/apps/presentations/master';
    let bound = false, state, helpers, task = null, epoch = 0, selectedTemplate = null, preparation = null, returnFocus = null;
    const byId = id => document.getElementById(id);
    function node(tag, className = '', value = '') { const item = document.createElement(tag); item.className = className; item.textContent = value; return item; }
    function closeModal() {
        preparation?.abort(); ++epoch;
        byId('presentation-master-modal').classList.add('hidden'); returnFocus?.focus();
    }
    function post(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
    function ensureModal() {
        if (byId('presentation-master-modal')) return;
        const modal = node('div', 'modal-overlay hidden'); modal.id = 'presentation-master-modal';
        const dialog = node('section', 'workspace-modal presentation-master-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '完整演示制作');
        const header = node('header', 'workspace-modal-header'); header.appendChild(node('h3', '', '完整演示制作'));
        const close = node('button', 'btn-secondary workspace-modal-close', '关闭'); close.type = 'button'; close.addEventListener('click', closeModal); header.appendChild(close);
        const body = node('div', 'workspace-modal-body');
        const templateNote = node('p', 'presentation-master-template-note'); templateNote.id = 'presentation-master-template-note'; body.appendChild(templateNote);
        const form = window.Pivot.moduleApi('apps.presentations.masterForm').mount();
        const submit = node('button', 'btn-primary', '开始制作'); submit.type = 'button'; submit.id = 'presentation-master-start'; submit.addEventListener('click', () => start().catch(showError));
        const status = node('div', 'presentation-evidence-card'); status.id = 'presentation-master-status'; status.setAttribute('aria-live', 'polite');
        const footer = node('footer', 'presentation-master-footer');
        footer.append(node('p', 'presentation-master-hint', '生成可编辑演示文件和项目源包，制作过程消耗所选模型额度。'), submit);
        body.append(form, status); dialog.append(header, body, footer); modal.appendChild(dialog); document.body.appendChild(modal);
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
            if (event.key !== 'Tab') return;
            const controls = [...dialog.querySelectorAll('button,input,select,textarea,summary')].filter(element => !element.disabled && element.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        });
        byId('presentation-master-operation').addEventListener('change', event => {
            const profile = byId('presentation-master-profile'); profile.disabled = event.target.value !== 'generate'; if (profile.disabled) profile.value = 'default';
            selectedTemplate = null; byId('presentation-master-template-note').textContent = '未指定固定模板，按当前要求设计。';
        });
    }
    function errorText(error) { const message = String(error?.message || ''); return /[\u3400-\u9fff]/u.test(message) ? message : '处理未完成，请检查文件、网络或服务连接后重试。'; }
    function showError(error) { if (error.name === 'AbortError') return; const status = byId('presentation-master-status'); status.replaceChildren(node('p', '', errorText(error))); status.scrollIntoView?.({ block: 'nearest' }); }
    async function open(options = {}) {
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-goals.js');
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-master-form.js');
        preparation?.abort(); ++epoch; returnFocus = document.activeElement;
        ensureModal(); byId('presentation-master-modal').classList.remove('hidden');
        const actor = String(window.Pivot.legacy?.currentUser?.id || ''), ownerModal = byId('presentation-master-modal');
        if (ownerModal.dataset.owner !== actor) {
            for (const key of ['title', 'instruction', 'material']) byId('presentation-master-' + key).value = '';
            window.Pivot.moduleApi('apps.presentations.masterForm').resetFiles();
            delete ownerModal.dataset.goalTarget; ownerModal.dataset.owner = actor; task = null; selectedTemplate = null;
        }
        byId('presentation-master-title').focus();
        const goalTarget = state.active?.id || 'new', goalProfile = state.active?.content?.metadata?.productionProfile, modal = byId('presentation-master-modal');
        if (modal.dataset.goalTarget !== goalTarget || goalProfile && modal.dataset.goalSource !== JSON.stringify(goalProfile)) {
            window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-master', goalProfile || {});
            modal.dataset.goalTarget = goalTarget; modal.dataset.goalSource = JSON.stringify(goalProfile || {}); modal.dataset.goalTask = '';
        }
        if (options.operation) {
            byId('presentation-master-operation').value = options.operation;
            byId('presentation-master-profile').value = options.profile || 'default';
            byId('presentation-master-profile').disabled = options.operation !== 'generate' || Boolean(options.template);
            selectedTemplate = options.template || null;
            if (selectedTemplate) {
                byId('presentation-master-operation').disabled = true;
                window.Pivot.moduleApi('apps.presentations.masterForm').resetFiles('source');
            } else byId('presentation-master-operation').disabled = false;
        }
        byId('presentation-master-template-note').textContent = selectedTemplate ? `制作模板：${selectedTemplate.name || '所选模板'}${selectedTemplate.version ? ' · 版本' + selectedTemplate.version : ''}` : '未指定固定模板，将按主题和材料自由设计。';
        await window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', 'presentation-master-model');
        if (!byId('presentation-master-title').value) byId('presentation-master-title').value = state.active?.title || '演示文稿';
        const { engine } = await helpers.requestJson(API + '/info');
        byId('presentation-master-start').disabled = !engine.enabled;
        if (!engine.enabled) {
            const fallback = node('button', 'btn-secondary', '使用标准演示制作'); fallback.type = 'button';
            fallback.addEventListener('click', () => { const profile = window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master'); closeModal(); helpers.openCreateModal(); window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-create', profile); });
            byId('presentation-master-status').replaceChildren(node('p', '', '完整制作服务未连接或暂不可用，标准演示创建、编辑和导出继续可用。'), fallback);
        }
        else if (task && task.request?.presentationId === (state.active?.id || '')) await poll(task.id, ++epoch);
        else {
            task = null;
            const data = await helpers.requestJson(API + '/tasks/latest?presentationId=' + encodeURIComponent(state.active?.id || ''));
            if (data.task) { task = data.task; await poll(task.id, ++epoch); }
            else byId('presentation-master-status').replaceChildren(node('p', '', '完整制作引擎已登记，开始后将显示实际制作进度。'));
        }
    }
    async function start() {
        if (preparation) return;
        const button = byId('presentation-master-start'); button.disabled = true;
        const controller = preparation = new AbortController(), sequence = ++epoch, owner = window.Pivot.legacy?.currentUser?.id, active = state.active;
        const ensureCurrent = () => { if (controller.signal.aborted || sequence !== epoch || owner !== window.Pivot.legacy?.currentUser?.id || active !== state.active) throw Object.assign(new Error('制作准备已取消'), { name: 'AbortError' }); };
        try {
            const title = byId('presentation-master-title').value.trim(), instruction = byId('presentation-master-instruction').value.trim(), modelId = byId('presentation-master-model').value;
            if (!title || !instruction || !modelId) throw new Error('请填写名称和制作要求，并选择模型。');
            const files = [...(byId('presentation-master-source').files || [])];
            if (files.length > 21) throw new Error('单次最多提供21个原稿和补充素材。');
            const form = window.Pivot.moduleApi('apps.presentations.masterForm'), snapshot = form.snapshot(), template = selectedTemplate;
            const currentMaterial = active?.content ? { title: active.title || '当前文稿', text: JSON.stringify(active.content) } : null;
            const request = { title, instruction, modelId, operation: byId('presentation-master-operation').value,
                productionProfile: window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master', active?.content?.metadata?.productionProfile || {}),
                profile: byId('presentation-master-profile').value, pageCount: Number(byId('presentation-master-pages').value), tokenBudget: Number(byId('presentation-master-budget').value),
                maxSteps: Number(byId('presentation-master-steps').value), presentationId: active?.id || '',
                ...(template ? { template: { type: template.type, id: template.id, ...(template.version ? { version: template.version } : {}) } } : {}) };
            button.textContent = snapshot.files.length ? '正在读取材料…' : '正在准备制作…';
            const materials = await form.extract(snapshot, helpers.requestJson, { signal: controller.signal, ensureCurrent });
            if (currentMaterial) materials.push(currentMaterial);
            ensureCurrent();
            files.sort((a, b) => Number(/\.pptx$/i.test(b.name)) - Number(/\.pptx$/i.test(a.name)));
            let sourceAssetId; const assetIds = [];
            for (const file of files) {
                const assetType = /\.pptx$/i.test(file.name) ? 'attachment' : /\.(?:wav|mp3|ogg)$/i.test(file.name) ? 'audio' : /\.mp4$/i.test(file.name) ? 'video' : 'image';
                const body = new FormData(); body.append('file', file); body.append('assetType', assetType);
                ensureCurrent();
                const data = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body, signal: controller.signal });
                ensureCurrent();
                if (!template && !sourceAssetId && ['attachment', 'image'].includes(assetType)) sourceAssetId = String(data.asset.id); else assetIds.push(String(data.asset.id));
            }
            const data = await helpers.requestJson(API + '/tasks', { ...post({ ...request, materials, assetIds, ...(sourceAssetId ? { sourceAssetId } : {}) }), signal: controller.signal });
            ensureCurrent();
            task = data.task; await poll(task.id, ++epoch);
            if (!byId('presentation-master-modal').classList.contains('hidden')) byId('presentation-master-status').scrollIntoView({ block: 'nearest' });
        } finally { if (preparation === controller) { preparation = null; button.disabled = false; button.textContent = '开始制作'; } }
    }
    async function poll(id, sequence) {
        const data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(id));
        if (sequence !== epoch) return;
        task = data.task; renderTask(task);
        if (['working'].includes(task.status) && !byId('presentation-master-modal').classList.contains('hidden')) window.setTimeout(() => poll(id, sequence).catch(showError), 1500);
    }
    function renderTask(value) {
        const modal = byId('presentation-master-modal');
        if (!state.active?.content?.metadata?.productionProfile && value.request?.productionProfile && String(value.request.presentationId || '') === (state.active?.id || '') && modal.dataset.goalTask !== value.id) {
            window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-master', value.request.productionProfile); modal.dataset.goalTask = value.id;
        }
        const panel = byId('presentation-master-status'); panel.replaceChildren();
        panel.appendChild(node('strong', '', ({ working: '正在制作', input_required: '需要确认', completed: '制作完成', failed: '制作未完成', cancelled: '已取消', expired: '任务已过期' })[value.status] || '制作任务'));
        panel.appendChild(node('p', '', value.error?.message ? errorText(value.error) : value.result?.message || value.progress?.message || '正在准备。'));
        panel.appendChild(node('p', 'presentation-empty-note', `步骤 ${value.steps || 0}；累计模型用量约 ${value.usedTokens || 0} 令牌。`));
        if (['working', 'input_required'].includes(value.status)) {
            const cancel = node('button', 'btn-secondary', '停止制作'); cancel.type = 'button';
            cancel.addEventListener('click', async () => { cancel.disabled = true; try { const data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/cancel', post({})); task = data.task; renderTask(task); } catch (error) { showError(error); } }); panel.appendChild(cancel);
        }
        if (value.status === 'input_required') {
            panel.appendChild(node('p', '', value.inputRequest.question)); panel.appendChild(node('pre', 'presentation-empty-note', value.inputRequest.context || ''));
            const answer = node('textarea', 'form-input'); answer.rows = 4; answer.maxLength = 12000; answer.setAttribute('aria-label', '对制作方案的实际答复');
            const submit = node('button', 'btn-primary', '确认并继续'); submit.type = 'button';
            submit.addEventListener('click', async () => { if (!answer.value.trim()) return; submit.disabled = true; try { await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/respond', post({ answer: answer.value })); await poll(value.id, ++epoch); } catch (error) { showError(error); } });
            panel.append(answer, submit);
        }
        if (value.recoverable) {
            const resume = node('button', 'btn-secondary', '从检查点继续'); resume.type = 'button';
            resume.addEventListener('click', async () => { resume.disabled = true; try {
                await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/resume', post({
                    tokenBudget: Math.max(Number(byId('presentation-master-budget').value), Number(value.request?.tokenBudget || 0)),
                    maxSteps: Math.max(Number(byId('presentation-master-steps').value), Number(value.request?.maxSteps || 0))
                }));
                await poll(value.id, ++epoch);
            } catch (error) { showError(error); } }); panel.appendChild(resume);
        }
        for (const file of value.result?.files || []) {
            const download = node('button', 'btn-secondary', file.format === 'pptx' ? '下载演示文件（.pptx）' : '下载完整项目源包'); download.type = 'button';
            download.addEventListener('click', async () => {
                try { const data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
                    const url = '/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token);
                    const link = node('a'); link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
                } catch (error) { showError(error); }
            }); panel.appendChild(download);
            if (file.format === 'pptx') {
                const edit = node('button', 'btn-secondary', '在浏览器编辑原生对象'); edit.type = 'button';
                edit.addEventListener('click', () => {
                    byId('presentation-master-modal').classList.add('hidden');
                    window.Pivot.moduleApi('apps.presentations.native').open({ sourceRenditionId: String(file.renditionId), title: value.request?.title || '完整制作结果' }).catch(showError);
                }); panel.appendChild(edit);
            }
        }
    }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers;
        if (bound) return; bound = true;
        document.addEventListener('click', event => { if (event.target.closest?.('[data-presentation-master-open]')) void open().catch(showError); });
    }
    window.Pivot.exposeModule('apps.presentations.master', { bind, open });
})();
