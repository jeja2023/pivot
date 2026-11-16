(function () {
    'use strict';
    const API = '/api/apps/presentations/master';
    let bound = false, state, helpers, task = null, epoch = 0, selectedTemplate = null, preparation = null, returnFocus = null;
    const byId = id => document.getElementById(id);
    function node(tag, className = '', value = '') { const item = document.createElement(tag); if (className) item.className = className; if (value) item.textContent = value; return item; }
    function svgIcon(paths, size = 16) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
        el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
        for (const [tag, attrs] of paths) {
            const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
            el.appendChild(child);
        }
        return el;
    }
    function closeModal() {
        preparation?.abort(); ++epoch;
        byId('presentation-master-modal').classList.add('hidden'); returnFocus?.focus();
    }
    function post(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

    function renderTemplateCard() {
        const card = byId('presentation-master-template-note');
        if (!card) return;
        card.replaceChildren();

        const content = node('div', 'presentation-master-hero-content');
        const iconWrap = node('div', 'presentation-master-hero-icon');
        const textWrap = node('div', 'presentation-master-hero-text');
        const headerRow = node('div', 'presentation-master-hero-header-row');
        const actions = node('div', 'presentation-master-hero-actions');

        if (selectedTemplate) {
            card.classList.add('is-template-active');
            iconWrap.appendChild(svgIcon([['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2', ry: '2' }], ['line', { x1: '8', y1: '21', x2: '16', y2: '21' }], ['line', { x1: '12', y1: '17', x2: '12', y2: '21' }]], 22));

            const title = node('strong', 'presentation-master-hero-title', `制作模板：${selectedTemplate.name || '所选模板'}`);
            const badge = node('span', 'presentation-source-badge is-engine', 'PPT Master 官方模板');
            const versionBadge = node('span', 'presentation-version-badge', selectedTemplate.version ? 'v' + selectedTemplate.version : 'v6.8.0');
            headerRow.append(title, badge, versionBadge);

            const descText = selectedTemplate.description || '结论先行，以证据支持决策；内置结构化版式与论证骨架。';
            const desc = node('p', 'presentation-master-hero-desc', descText);
            textWrap.append(headerRow, desc);

            const changeBtn = node('button', 'btn-secondary presentation-master-hero-btn', '更换模板');
            changeBtn.type = 'button';
            changeBtn.addEventListener('click', () => {
                closeModal();
                window.Pivot.moduleApi('apps.presentations.catalog')?.open('engine');
            });

            const clearBtn = node('button', 'btn-secondary presentation-master-hero-btn', '改用自由设计');
            clearBtn.type = 'button';
            clearBtn.addEventListener('click', () => {
                selectedTemplate = null;
                const op = byId('presentation-master-operation'), prof = byId('presentation-master-profile');
                if (op) op.disabled = false;
                if (prof) { prof.disabled = false; prof.value = 'default'; }
                window.Pivot.moduleApi('apps.presentations.masterForm')?.updateTemplateLock(false);
                renderTemplateCard();
            });

            actions.append(changeBtn, clearBtn);
        } else {
            card.classList.remove('is-template-active');
            iconWrap.appendChild(svgIcon([['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]], 22));

            const title = node('strong', 'presentation-master-hero-title', '未指定固定模板，将按主题和材料自由设计。');
            const badge = node('span', 'presentation-source-badge is-system', 'AI 自适应排版');
            headerRow.append(title, badge);

            const desc = node('p', 'presentation-master-hero-desc', '大模型根据您的文稿主题、核心论据与材料自适应推导全套视觉风格、内容逻辑与版式层次。');
            textWrap.append(headerRow, desc);

            const pickBtn = node('button', 'btn-secondary presentation-master-hero-btn', '从模板库挑选模板');
            pickBtn.type = 'button';
            pickBtn.addEventListener('click', () => {
                closeModal();
                window.Pivot.moduleApi('apps.presentations.catalog')?.open('engine');
            });
            actions.append(pickBtn);
        }

        content.append(iconWrap, textWrap);
        card.append(content, actions);
    }

    function ensureModal() {
        if (byId('presentation-master-modal')) return;
        const modal = node('div', 'modal-overlay hidden'); modal.id = 'presentation-master-modal';
        const dialog = node('section', 'workspace-modal presentation-master-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '完整演示制作');

        const header = node('header', 'workspace-modal-header presentation-master-header');
        const headerInfo = node('div', 'presentation-master-header-info');
        const headerTitleRow = node('div', 'presentation-master-header-title-row');
        headerTitleRow.append(
            svgIcon([['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2', ry: '2' }], ['line', { x1: '8', y1: '21', x2: '16', y2: '21' }], ['line', { x1: '12', y1: '17', x2: '12', y2: '21' }]], 20),
            node('h3', '', '完整演示制作')
        );
        const headerSubtitle = node('p', 'presentation-master-header-subtitle', '基于多模态大模型的工业级高保真 PPT 制作引擎 · 交付原生矢量可编辑演示文稿');
        headerInfo.append(headerTitleRow, headerSubtitle);

        const close = node('button', 'btn-secondary workspace-modal-close', '关闭'); close.type = 'button'; close.addEventListener('click', closeModal);
        header.append(headerInfo, close);

        const body = node('div', 'workspace-modal-body');
        const templateNote = node('div', 'presentation-master-template-note presentation-master-hero'); templateNote.id = 'presentation-master-template-note';
        body.appendChild(templateNote);

        const form = window.Pivot.moduleApi('apps.presentations.masterForm').mount();
        const submit = node('button', 'btn-primary presentation-master-start-btn', '开始制作'); submit.type = 'button'; submit.id = 'presentation-master-start';
        submit.addEventListener('click', () => start().catch(showError));

        const status = node('div', 'presentation-evidence-card presentation-master-status-card'); status.id = 'presentation-master-status'; status.setAttribute('aria-live', 'polite');

        const footer = node('footer', 'presentation-master-footer');
        const footerHint = node('div', 'presentation-master-footer-hint');
        footerHint.append(
            svgIcon([['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '16', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '8', x2: '12.01', y2: '8' }]], 15),
            node('p', 'presentation-master-hint', '生成可编辑演示文件和项目源包，制作过程消耗所选模型额度。')
        );
        footer.append(footerHint, submit);

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
            selectedTemplate = null;
            window.Pivot.moduleApi('apps.presentations.masterForm')?.updateTemplateLock(false);
            renderTemplateCard();
        });
    }
    function errorText(error) { const message = String(error?.message || ''); return /[\u3400-\u9fff]/u.test(message) ? message : '处理未完成，请检查文件、网络或服务连接后重试。'; }
    function showError(error) { if (error.name === 'AbortError') return; const status = byId('presentation-master-status'); status.replaceChildren(node('p', '', errorText(error))); status.scrollIntoView?.({ block: 'nearest' }); }

    function renderEngineReady() {
        const panel = byId('presentation-master-status');
        if (!panel) return;
        panel.replaceChildren();
        const row = node('div', 'presentation-master-ready-row');
        const dot = node('span', 'presentation-master-ready-dot');
        const text = node('span', 'presentation-master-ready-text', '完整制作引擎已登记，开始后将显示实际制作进度。');
        const badge = node('span', 'presentation-master-ready-badge', '服务就绪');
        row.append(dot, text, badge);
        panel.appendChild(row);
    }

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
        } else if (options.template) {
            selectedTemplate = options.template;
            byId('presentation-master-operation').disabled = true;
            byId('presentation-master-profile').disabled = true;
            byId('presentation-master-profile').value = 'default';
        }
        window.Pivot.moduleApi('apps.presentations.masterForm')?.updateTemplateLock(Boolean(selectedTemplate));
        renderTemplateCard();

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
            else renderEngineReady();
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
        const head = node('div', 'presentation-master-task-head');
        const statusBadge = node('strong', 'presentation-master-task-badge ' + (value.status || ''), ({ working: '正在制作中', input_required: '需要人工确认', completed: '制作完成', failed: '制作未完成', cancelled: '已取消', expired: '任务已过期' })[value.status] || '制作任务');
        head.appendChild(statusBadge);
        panel.appendChild(head);
        panel.appendChild(node('p', 'presentation-master-task-message', value.error?.message ? errorText(value.error) : value.result?.message || value.progress?.message || '正在准备。'));
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
        const actionRow = node('div', 'presentation-master-task-actions');
        for (const file of value.result?.files || []) {
            const download = node('button', 'btn-secondary', file.format === 'pptx' ? '下载演示文件（.pptx）' : '下载完整项目源包'); download.type = 'button';
            download.addEventListener('click', async () => {
                try { const data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
                    const url = '/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token);
                    const link = node('a'); link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
                } catch (error) { showError(error); }
            }); actionRow.appendChild(download);
            if (file.format === 'pptx') {
                const edit = node('button', 'btn-secondary', '在浏览器编辑原生对象'); edit.type = 'button';
                edit.addEventListener('click', () => {
                    byId('presentation-master-modal').classList.add('hidden');
                    window.Pivot.moduleApi('apps.presentations.native').open({ sourceRenditionId: String(file.renditionId), title: value.request?.title || '完整制作结果' }).catch(showError);
                }); actionRow.appendChild(edit);
            }
        }
        if (actionRow.children.length) panel.appendChild(actionRow);
    }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers;
        if (bound) return; bound = true;
        document.addEventListener('click', event => { if (event.target.closest?.('[data-presentation-master-open]')) void open().catch(showError); });
    }
    window.Pivot.exposeModule('apps.presentations.master', { bind, open });
})();
