(function () {
    'use strict';
    const API = '/api/apps/presentations/master';
    let bound = false, state, helpers, task = null, epoch = 0, selectedTemplate = null;
    const byId = id => document.getElementById(id);
    function node(tag, className = '', value = '') { const item = document.createElement(tag); item.className = className; item.textContent = value; return item; }
    function field(label, id, type = 'text', values = null) {
        const wrapper = node('label', 'presentation-master-field'), input = node(values ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'form-input');
        input.id = id;
        if (values) Object.entries(values).forEach(([key, label]) => input.appendChild(new Option(label, key)));
        else if (type === 'textarea') input.rows = 4;
        else input.type = type;
        wrapper.append(node('span', '', label), input); return wrapper;
    }
    function post(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
    function ensureModal() {
        if (byId('presentation-master-modal')) return;
        const modal = node('div', 'modal-overlay hidden'); modal.id = 'presentation-master-modal';
        const dialog = node('section', 'workspace-modal presentation-master-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '完整演示制作');
        const header = node('header', 'workspace-modal-header'); header.appendChild(node('h3', '', '完整演示制作'));
        const close = node('button', 'btn-secondary workspace-modal-close', '关闭'); close.type = 'button'; close.addEventListener('click', () => modal.classList.add('hidden')); header.appendChild(close);
        const body = node('div', 'workspace-modal-body');
        const templateNote = node('p', 'presentation-empty-note'); templateNote.id = 'presentation-master-template-note'; body.appendChild(templateNote);
        body.appendChild(node('p', 'presentation-empty-note', '使用完整制作流程生成原生PPTX和项目源包；复杂对象在PowerPoint或上游项目中继续编辑。制作过程可能需要确认设计方案，并消耗所选模型额度。'));
        const form = node('div', 'presentation-master-form');
        window.Pivot.moduleApi('apps.presentations.goals').mount(form, 'presentation-master');
        form.append(field('文稿名称', 'presentation-master-title'), field('制作模型', 'presentation-master-model', 'text', {}),
            field('工作方式', 'presentation-master-operation', 'text', { generate: '生成完整演示', create_template: '创建可复用模板', edit_native: '保留原稿设计并编辑' }),
            field('生成方式', 'presentation-master-profile', 'text', { default: '先确认方案再制作', quick: '快速制作（明确跳过方案确认）', beautify: '美化已有内容', image_to_pptx: '根据图片重建' }),
            field('目标页数（1至40）', 'presentation-master-pages', 'number'), field('累计模型预算（令牌）', 'presentation-master-budget', 'number'),
            field('执行轮次上限（5至160）', 'presentation-master-steps', 'number'),
            field('制作要求', 'presentation-master-instruction', 'textarea'), field('事实材料（可留空，缺少依据时会提示）', 'presentation-master-material', 'textarea'),
            field('原稿及补充图片/音视频（最多21个文件）', 'presentation-master-source', 'file'));
        const submit = node('button', 'btn-primary', '开始制作'); submit.type = 'button'; submit.id = 'presentation-master-start'; submit.addEventListener('click', () => start().catch(showError));
        const status = node('div', 'presentation-evidence-card'); status.id = 'presentation-master-status'; status.setAttribute('aria-live', 'polite');
        body.append(form, submit, status); dialog.append(header, body); modal.appendChild(dialog); document.body.appendChild(modal);
        byId('presentation-master-pages').value = '8'; byId('presentation-master-budget').value = '400000';
        byId('presentation-master-steps').value = '80';
        byId('presentation-master-source').accept = '.pptx,.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.mp4'; byId('presentation-master-source').multiple = true;
        byId('presentation-master-operation').addEventListener('change', event => {
            const profile = byId('presentation-master-profile'); profile.disabled = event.target.value !== 'generate'; if (profile.disabled) profile.value = 'default';
            selectedTemplate = null; byId('presentation-master-template-note').textContent = '未指定固定模板，按当前要求设计。';
        });
    }
    function showError(error) { const status = byId('presentation-master-status'); status.replaceChildren(node('p', '', error.message || '制作请求失败，请检查后重试。')); }
    async function open(options = {}) {
        ensureModal(); byId('presentation-master-modal').classList.remove('hidden');
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
                byId('presentation-master-source').value = '';
            } else byId('presentation-master-operation').disabled = false;
        }
        byId('presentation-master-template-note').textContent = selectedTemplate ? `已选择：${selectedTemplate.name || selectedTemplate.id}${selectedTemplate.version ? ' · 版本' + selectedTemplate.version : ''}。模板由当前账号授权读取，制作中保留选择。` : '未指定固定模板，可按主题和材料自由设计；也可从统一模板库选择用途或单位模板。';
        await window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', 'presentation-master-model');
        if (!byId('presentation-master-title').value) byId('presentation-master-title').value = state.active?.title || '演示文稿';
        const { engine } = await helpers.requestJson(API + '/info');
        byId('presentation-master-start').disabled = !engine.enabled;
        if (!engine.enabled) {
            const fallback = node('button', 'btn-secondary', '使用标准PPT制作'); fallback.type = 'button';
            fallback.addEventListener('click', () => { const profile = window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master'); byId('presentation-master-modal').classList.add('hidden'); helpers.openCreateModal(); window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-create', profile); });
            byId('presentation-master-status').replaceChildren(node('p', '', '完整制作服务未连接或暂不可用，标准PPT创建、编辑和导出继续可用。'), fallback);
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
        const button = byId('presentation-master-start'); button.disabled = true;
        try {
            const title = byId('presentation-master-title').value.trim(), instruction = byId('presentation-master-instruction').value.trim(), modelId = byId('presentation-master-model').value;
            if (!title || !instruction || !modelId) throw new Error('请填写名称和制作要求，并选择模型。');
            const files = [...(byId('presentation-master-source').files || [])];
            if (files.length > 21) throw new Error('单次最多提供21个原稿和补充素材。');
            files.sort((a, b) => Number(/\.pptx$/i.test(b.name)) - Number(/\.pptx$/i.test(a.name)));
            let sourceAssetId; const assetIds = [];
            for (const file of files) {
                const assetType = /\.pptx$/i.test(file.name) ? 'attachment' : /\.(?:wav|mp3|ogg)$/i.test(file.name) ? 'audio' : /\.mp4$/i.test(file.name) ? 'video' : 'image';
                const body = new FormData(); body.append('file', file); body.append('assetType', assetType);
                const data = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body });
                if (!selectedTemplate && !sourceAssetId && ['attachment', 'image'].includes(assetType)) sourceAssetId = String(data.asset.id); else assetIds.push(String(data.asset.id));
            }
            const material = byId('presentation-master-material').value;
            const materials = material.trim() ? [{ title: '本次事实材料', text: material }] : [];
            if (state.active?.content) materials.push({ title: state.active.title || '当前文稿', text: JSON.stringify(state.active.content) });
            const data = await helpers.requestJson(API + '/tasks', post({ title, instruction, modelId, operation: byId('presentation-master-operation').value,
                productionProfile: window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master', state.active?.content?.metadata?.productionProfile || {}),
                profile: byId('presentation-master-profile').value, pageCount: Number(byId('presentation-master-pages').value), tokenBudget: Number(byId('presentation-master-budget').value),
                maxSteps: Number(byId('presentation-master-steps').value),
                presentationId: state.active?.id || '', materials, assetIds, ...(selectedTemplate ? { template: { type: selectedTemplate.type, id: selectedTemplate.id, ...(selectedTemplate.version ? { version: selectedTemplate.version } : {}) } } : {}), ...(sourceAssetId ? { sourceAssetId } : {}) }));
            task = data.task; await poll(task.id, ++epoch);
        } finally { button.disabled = false; }
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
        panel.appendChild(node('p', '', value.error?.message || value.result?.message || value.progress?.message || '正在准备。'));
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
            const download = node('button', 'btn-secondary', file.format === 'pptx' ? '下载原生PPTX' : '下载完整项目源包'); download.type = 'button';
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
