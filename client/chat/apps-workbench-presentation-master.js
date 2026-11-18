(function () {
    'use strict';
    const API = '/api/apps/presentations/master';
    let bound = false, state, helpers, epoch = 0, selectedTemplate = null, preparation = null, returnFocus = null;
    const byId = id => document.getElementById(id);
    const actorId = () => String(window.Pivot.legacy?.currentUser?.id || '');
    const presentationId = () => String(state.active?.id || '');
    function isCurrent(sequence) {
        const modal = byId('presentation-master-modal');
        return sequence === epoch && modal && !modal.classList.contains('hidden')
            && modal.dataset.owner === actorId() && modal.dataset.presentationId === presentationId();
    }
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
    function closeModal({ preserveForm = false } = {}) {
        ++epoch;
        preparation?.abort(); preparation = null;
        const modal = byId('presentation-master-modal');
        if (preserveForm) {
            modal.classList.add('hidden');
            const panel = byId('presentation-master-status');
            panel.replaceChildren();
            delete panel.dataset.taskId;
            delete modal.dataset.modelTask;
            byId('presentation-master-start').textContent = '开始制作';
        } else {
            modal.remove();
            selectedTemplate = null;
        }
        const focus = returnFocus; returnFocus = null; focus?.focus();
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
                closeModal({ preserveForm: true });
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
                closeModal({ preserveForm: true });
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

        const close = node('button', 'btn-secondary workspace-modal-close', '关闭'); close.type = 'button'; close.addEventListener('click', () => closeModal());
        header.append(headerInfo, close);

        const body = node('div', 'workspace-modal-body');
        const templateNote = node('div', 'presentation-master-template-note presentation-master-hero'); templateNote.id = 'presentation-master-template-note';
        body.appendChild(templateNote);

        const form = window.Pivot.moduleApi('apps.presentations.masterForm').mount();
        const submit = node('button', 'btn-primary presentation-master-start-btn', '开始制作'); submit.type = 'button'; submit.id = 'presentation-master-start'; submit.disabled = true;
        submit.addEventListener('click', start);

        const status = node('div', 'presentation-evidence-card presentation-master-status-card'); status.id = 'presentation-master-status'; status.setAttribute('aria-live', 'polite');
        const history = node('button', 'btn-secondary', '查看最近制作'); history.type = 'button'; history.id = 'presentation-master-history';
        history.addEventListener('click', () => loadTask(history, '/tasks/latest?presentationId=' + encodeURIComponent(presentationId())));
        const activeTask = node('button', 'btn-secondary', '查看进行中的制作'); activeTask.type = 'button';
        activeTask.addEventListener('click', () => loadTask(activeTask, '/tasks/active', true));
        const historyActions = node('div', 'presentation-master-task-actions'); historyActions.append(history, activeTask);

        const footer = node('footer', 'presentation-master-footer');
        const footerHint = node('div', 'presentation-master-footer-hint');
        footerHint.append(
            svgIcon([['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '16', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '8', x2: '12.01', y2: '8' }]], 15),
            node('p', 'presentation-master-hint', '生成可编辑演示文件和项目源包，制作过程消耗所选模型额度。')
        );
        footer.append(footerHint, submit);

        body.append(form, historyActions, status); dialog.append(header, body, footer); modal.appendChild(dialog); document.body.appendChild(modal);
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
    function showError(error, sequence) { if (!isCurrent(sequence) || error.name === 'AbortError') return; const status = byId('presentation-master-status'), message = node('p', 'presentation-master-task-feedback', errorText(error)); message.setAttribute('role', 'alert'); status.replaceChildren(message); status.scrollIntoView?.({ block: 'nearest' }); }

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
        const sequence = ++epoch, actor = actorId(), target = presentationId(), focus = document.activeElement;
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-goals.js');
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-master-form.js');
        if (sequence !== epoch || actor !== actorId() || target !== presentationId()) return;
        preparation?.abort(); preparation = null;
        const previous = byId('presentation-master-modal');
        if (previous && (!previous.classList.contains('hidden') || previous.dataset.owner !== actor || previous.dataset.presentationId !== target)) {
            previous.remove();
            selectedTemplate = null;
        }
        returnFocus = focus;
        ensureModal();
        const modal = byId('presentation-master-modal');
        modal.dataset.owner = actor; modal.dataset.presentationId = target;
        modal.classList.remove('hidden');
        const startButton = byId('presentation-master-start');
        startButton.disabled = true;
        startButton.textContent = '开始制作';
        byId('presentation-master-history').disabled = true;
        byId('presentation-master-title').focus();
        const goalProfile = state.active?.content?.metadata?.productionProfile;
        if (modal.dataset.goalSource !== JSON.stringify(goalProfile || {})) {
            window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-master', goalProfile || {});
            modal.dataset.goalSource = JSON.stringify(goalProfile || {});
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

        try {
            await window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', byId('presentation-master-model'), { isCurrent: () => isCurrent(sequence) });
            if (!isCurrent(sequence)) return;
            const { engine } = await helpers.requestJson(API + '/info');
            if (!isCurrent(sequence)) return;
            startButton.disabled = !engine.enabled;
            if (engine.enabled) renderEngineReady();
            else {
                const fallback = node('button', 'btn-secondary', '使用标准演示制作'); fallback.type = 'button';
                fallback.addEventListener('click', () => { const profile = window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master'); closeModal(); helpers.openCreateModal(); window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-create', profile); });
                byId('presentation-master-status').replaceChildren(node('p', '', '完整制作服务未连接或暂不可用，标准演示创建、编辑和导出继续可用。'), fallback);
            }
        } catch (error) { showError(error, sequence); }
        finally { if (isCurrent(sequence)) byId('presentation-master-history').disabled = false; }
    }

    async function loadTask(button, route, showAccountTask = false) {
        if (preparation) return;
        const sequence = ++epoch;
        button.disabled = true;
        try {
            const { task } = await helpers.requestJson(API + route);
            if (!isCurrent(sequence)) return;
            if (task) {
                if (showAccountTask) renderTask(task);
                if (!showAccountTask || task.request && task.status === 'working') await poll(task.id, sequence);
            } else byId('presentation-master-status').replaceChildren(node('p', 'presentation-master-task-message', showAccountTask ? '当前账号暂无进行中的制作任务。' : '暂无制作记录。'));
        } catch (error) { showError(error, sequence); }
        finally { button.disabled = false; }
    }
    function readTokenBudget() {
        const input = byId('presentation-master-budget');
        const budget = Number(input.value);
        if (!input.validity.valid || !Number.isSafeInteger(budget) || (budget !== 0 && budget < 10000)) {
            throw new Error('累计模型预算请填写 0（不限）或不小于 10000 的整数。');
        }
        return input.value === '' ? undefined : budget;
    }
    async function start() {
        if (preparation) return;
        const button = byId('presentation-master-start'), history = byId('presentation-master-history');
        button.disabled = true; history.disabled = true;
        const controller = preparation = new AbortController(), sequence = ++epoch, active = state.active;
        const ensureCurrent = () => { if (controller.signal.aborted || !isCurrent(sequence) || active !== state.active) throw Object.assign(new Error('制作准备已取消'), { name: 'AbortError' }); };
        try {
            const title = byId('presentation-master-title').value.trim(), instruction = byId('presentation-master-instruction').value.trim(), modelId = byId('presentation-master-model').value;
            if (!title || !instruction || !modelId) throw new Error('请填写名称和制作要求，并选择模型。');
            const tokenBudget = readTokenBudget();
            const files = [...(byId('presentation-master-source').files || [])];
            if (files.length > 21) throw new Error('单次最多提供21个原稿和补充素材。');
            const form = window.Pivot.moduleApi('apps.presentations.masterForm'), snapshot = form.snapshot(), template = selectedTemplate;
            const currentMaterial = active?.content ? { title: active.title || '当前文稿', text: JSON.stringify(active.content) } : null;
            const request = { title, instruction, modelId, operation: byId('presentation-master-operation').value,
                productionProfile: window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master', active?.content?.metadata?.productionProfile || {}),
                profile: byId('presentation-master-profile').value, pageCount: Number(byId('presentation-master-pages').value), tokenBudget,
                maxSteps: Number(byId('presentation-master-steps').value), presentationId: active?.id || '',
                ...(template ? { template: { type: template.type, id: template.id, ...(template.version ? { version: template.version } : {}) } } : {}) };
            button.textContent = '正在预检模型…';
            byId('presentation-master-status').replaceChildren(node('p', 'presentation-master-task-message', '正在预检模型…'));
            await helpers.requestJson(API + '/model-preflight', { ...post({ modelId, operation: request.operation, profile: request.profile,
                visionRequired: files.some(file => /\.(?:png|jpe?g|webp)$/i.test(file.name)) }), signal: controller.signal });
            ensureCurrent();
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
            await poll(data.task.id, sequence);
            if (isCurrent(sequence)) byId('presentation-master-status').scrollIntoView({ block: 'nearest' });
        } catch (error) { showError(error, sequence); }
        finally {
            if (preparation === controller) {
                preparation = null;
                button.disabled = !isCurrent(epoch);
                history.disabled = button.disabled;
                button.textContent = '开始制作';
            }
        }
    }
    async function poll(id, sequence, failures = 0) {
        if (!isCurrent(sequence)) return;
        let data;
        try { data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(id)); }
        catch (error) {
            if (!isCurrent(sequence)) return;
            const panel = byId('presentation-master-status');
            let warning = panel.querySelector('[data-master-poll-error]');
            if (!warning) { warning = node('div', 'presentation-master-task-feedback'); warning.dataset.masterPollError = 'true'; warning.setAttribute('role', 'alert'); panel.appendChild(warning); }
            warning.replaceChildren(node('p', '', '状态暂时无法更新，后台任务可能仍在运行。'));
            const retry = node('button', 'btn-secondary', '重新查询状态'); retry.type = 'button';
            retry.addEventListener('click', () => { retry.disabled = true; const retrySequence = ++epoch; void poll(id, retrySequence).catch(error => showError(error, retrySequence)); }); warning.appendChild(retry);
            if (failures < 3) window.setTimeout(() => poll(id, sequence, failures + 1).catch(error => showError(error, sequence)), 3000);
            return;
        }
        if (!isCurrent(sequence)) return;
        renderTask(data.task);
        if (data.task.status === 'working') window.setTimeout(() => poll(id, sequence).catch(error => showError(error, sequence)), 1500);
    }
    function renderTask(value) {
        const panel = byId('presentation-master-status'), previous = panel.querySelector('.presentation-master-usage');
        const sameTask = panel.dataset.taskId === String(value.id), wasOpen = sameTask && previous?.open, wasFocused = sameTask && previous?.contains(document.activeElement);
        const scroll = panel.closest('.workspace-modal-body')?.scrollTop || 0;
        panel.dataset.taskId = String(value.id); panel.replaceChildren();
        const feedback = node('p', 'presentation-master-task-feedback'); feedback.setAttribute('role', 'alert');
        const head = node('div', 'presentation-master-task-head');
        const statusBadge = node('strong', 'presentation-master-task-badge ' + (value.status || ''), ({ working: '正在制作中', input_required: '需要人工确认', completed: '制作完成', failed: '制作未完成', cancelled: '已取消', expired: '任务已过期' })[value.status] || '制作任务');
        head.appendChild(statusBadge);
        if (value.request?.title) head.appendChild(node('span', '', value.request.title));
        panel.appendChild(head);
        if (!value.inputRequest) panel.appendChild(node('p', 'presentation-master-task-message', value.error?.message ? errorText(value.error) : value.result?.message || value.progress?.message || '正在准备。'));
        if (value.status === 'failed' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value.error?.code || '')) {
            panel.appendChild(node('p', 'presentation-master-task-summary', '错误代码 ' + value.error.code));
        }
        const currentBudget = value.request?.tokenBudget;
        const budgetText = currentBudget === 0 ? '不限' : Number.isSafeInteger(currentBudget) ? `${currentBudget.toLocaleString('zh-CN')} 令牌` : '未记录';
        panel.appendChild(node('p', 'presentation-master-task-summary', `步骤 ${value.steps || 0}。已用约 ${Number(value.usedTokens || 0).toLocaleString('zh-CN')} 令牌。本任务累计预算 ${budgetText}。`));
        if (value.imageCoverage?.total) panel.appendChild(node('p', 'presentation-master-task-summary', `已发送 ${value.imageCoverage.read} / ${value.imageCoverage.total} 张图片给模型。`));
        if (value.actionRetries) panel.appendChild(node('p', 'presentation-master-task-summary', `已修正模型动作 ${value.actionRetries} 次。`));
        const audit = value.result?.checks;
        if (audit?.checklistDigest) panel.appendChild(node('p', 'presentation-master-task-summary', `交付已按批准清单核对 ${audit.checkedPages} 页及 ${audit.checkedValues} 项关键数据。`));
        const actions = value.actionSummary;
        if (actions && value.steps > 0) {
            const writeText = actions.writes ? `已确认直接写入 ${actions.writes} 次。最近写入 ${actions.lastWrittenPath}。` : '当前检查点暂无直接写入回执。';
            const labels = { read: '读取任务文件', read_runtime: '读取指引', read_history: '回读历史', read_images: '分页读取图片', list: '列出文件', write: '写入文件',
                run: '执行工具', copy: '复制文件', copy_template: '复制模板', validate_template: '校验模板', pending: '待确认的操作' };
            const recent = (actions.lastActions || []).map(item => labels[item.action] && labels[item.action] + (item.failed ? '未完成' : '')).filter(Boolean);
            panel.appendChild(node('p', 'presentation-master-task-summary', writeText + (actions.failedWrites ? `写入失败 ${actions.failedWrites} 次。` : '') +
                (actions.runtimeReads ? `已读取指引 ${actions.runtimeReads} 次。` : '') +
                (recent.length ? '最近工具动作包括' + recent.join('、') + '。' : '')));
        }
        if (value.modelRequest) {
            const { contextWindow, configuredInputLimit, inputEstimate, outputLimit, timeoutSeconds } = value.modelRequest;
            const parts = [contextWindow && `单轮窗口 ${contextWindow.toLocaleString('zh-CN')}`,
                configuredInputLimit && `配置输入上限 ${configuredInputLimit.toLocaleString('zh-CN')}`,
                `预计输入 ${Number(inputEstimate || 0).toLocaleString('zh-CN')}`, outputLimit && `本轮输出上限 ${outputLimit.toLocaleString('zh-CN')}`].filter(Boolean);
            panel.appendChild(node('p', 'presentation-master-task-summary', parts.join('，') + ' 令牌。' +
                (timeoutSeconds ? `请求时限 ${timeoutSeconds} 秒。` : '')));
        }
        if (value.milestones && Object.keys(value.milestones).length) {
            const labels = { firstPlan: '首次提交方案', firstApproval: '首次方案确认', firstWrite: '首次写入回执', firstPageWrite: '首次页面写入', delivered: '交付登记' };
            const milestones = Object.entries(labels).filter(([key]) => value.milestones[key]).map(([key, label]) => {
                const stage = value.milestones[key];
                return `${label}（第 ${stage.steps} 步，用时 ${Math.ceil(stage.elapsedMs / 1000)} 秒，累计 ${stage.usedTokens.toLocaleString('zh-CN')} 令牌）`;
            });
            panel.appendChild(node('p', 'presentation-master-task-summary', milestones.join('，') + '。'));
        }
        const modal = byId('presentation-master-modal');
        if ((value.recoverable || value.status === 'input_required') && modal.dataset.modelTask !== String(value.id) && value.request?.modelId) {
            const model = byId('presentation-master-model'); if ([...model.options].some(option => option.value === String(value.request.modelId))) model.value = String(value.request.modelId);
            modal.dataset.modelTask = String(value.id);
        }
        if (Array.isArray(value.usageDiagnostics) && value.usageDiagnostics.length) {
            const details = node('details', 'presentation-master-usage'), list = node('ol');
            details.open = Boolean(wasOpen);
            details.appendChild(node('summary', '', '查看每轮模型用量'));
            for (const item of value.usageDiagnostics) {
                const parts = item.breakdown ? `（初始指引及任务 ${item.breakdown.initial}，历史消息 ${item.breakdown.history}，工具结果 ${item.breakdown.toolResults || 0}，图片 ${item.breakdown.images}）` : '';
                list.appendChild(node('li', '', `第 ${item.call || item.step} 次模型调用（步骤 ${item.step}）：输入 ${item.inputTokens}${item.inputEstimated ? '（估算）' : ''}，输出 ${item.outputTokens}${item.outputEstimated ? '（估算）' : ''}，累计 ${item.cumulativeTokens}；预计输入 ${item.inputEstimate}${parts}，收敛前预计 ${item.originalEstimate}，已收敛 ${item.compactedWrites} 条文件写入正文。`));
            }
            details.appendChild(list); panel.appendChild(details);
            if (wasFocused) details.querySelector('summary')?.focus({ preventScroll: true });
        }
        if (value.recoverable && value.error?.code === 'PPT_MASTER_BUDGET_EXHAUSTED') {
            const budget = byId('presentation-master-budget');
            budget.closest('details').open = true;
            panel.appendChild(node('p', 'presentation-master-task-message', `本任务累计预算为 ${budgetText}。请在“高级设置”中提高预算或填 0 取消累计上限，再点击“从检查点继续”。`));
        }
        if (['working', 'input_required'].includes(value.status)) {
            const cancel = node('button', 'btn-secondary', '停止制作'); cancel.type = 'button';
            cancel.addEventListener('click', async () => { cancel.disabled = true; const sequence = ++epoch; try { const data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/cancel', post({})); if (isCurrent(sequence)) renderTask(data.task); } catch (error) { if (isCurrent(sequence)) { cancel.disabled = false; feedback.textContent = errorText(error); window.setTimeout(() => poll(value.id, sequence).catch(failure => showError(failure, sequence)), 3000); } } });
            head.appendChild(cancel);
        }
        if (value.inputRequest) {
            const request = value.inputRequest || {}, confirmation = request.kind === 'confirmation';
            if (request.stage) {
                const stages = { direction: '确认沟通方向', design: '确认最终页面与关键数据清单', template: '确认模板制作方案' };
                if (stages[request.stage]) panel.appendChild(node('strong', '', stages[request.stage]));
            }
            panel.appendChild(node('p', 'presentation-master-task-question', request.question || '请提供继续制作所需的答复。'));
            if (request.context) panel.appendChild(node('div', 'presentation-master-task-context', request.context));
            if (request.plan?.pages?.length) {
                const details = node('details', 'presentation-master-usage'), pages = node('ol');
                details.open = true;
                details.appendChild(node('summary', '', `已拟定 ${request.plan.pages.length} 页，请逐页核对`));
                for (const page of request.plan.pages) {
                    const item = node('li', '', page.title), facts = node('ul');
                    for (const fact of page.values || []) {
                        const chart = fact.chart ? `（图表 ${fact.chart.series} / ${fact.chart.category} 为 ${fact.chart.number}）` : '';
                        facts.appendChild(node('li', '', fact.text + chart + (fact.source ? `（${fact.source.path === 'instruction' ? '制作要求' : fact.source.path}，引文 ${fact.source.quote}）` : '')));
                    }
                    if (facts.children.length) item.appendChild(facts);
                    pages.appendChild(item);
                }
                details.appendChild(pages); panel.appendChild(details);
            }
            const answer = node('textarea', 'form-input presentation-master-task-answer'); answer.rows = 2; answer.maxLength = 12000; answer.setAttribute('aria-label', '对制作方案的实际答复');
            answer.placeholder = confirmation ? '如需调整方案，请填写并提交修改意见。' : '请填写具体答复后继续。';
            const submit = node('button', 'btn-primary', confirmation ? '确认并继续' : '提交答复并继续'); submit.type = 'button';
            const actions = node('div', 'presentation-master-task-actions'); actions.appendChild(submit);
            const revise = confirmation ? node('button', 'btn-secondary', '提交修改意见') : null;
            if (revise) { revise.type = 'button'; actions.appendChild(revise); }
            async function respond(decision) {
                const response = answer.value.trim();
                if (decision !== 'approve' && !response) { feedback.textContent = '请先填写具体答复，再继续制作。'; answer.focus(); return; }
                if (decision === 'approve' && response) { feedback.textContent = '请提交已填写的修改意见，或清空意见后确认。'; answer.focus(); return; }
                feedback.textContent = ''; submit.disabled = true; if (revise) revise.disabled = true;
                const sequence = ++epoch;
                try {
                    await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/respond', post({ answer: response, decision, promptId: request.promptId }));
                    await poll(value.id, sequence);
                } catch (error) { if (isCurrent(sequence)) { submit.disabled = false; if (revise) revise.disabled = false; feedback.textContent = errorText(error); } }
            }
            submit.addEventListener('click', () => respond(confirmation ? 'approve' : 'clarify'));
            revise?.addEventListener('click', () => respond('revise'));
            panel.append(answer, actions);
        }
        if (value.recoverable) {
            panel.appendChild(node('p', 'presentation-master-task-message', '已保存任务检查点；继续前会核对现有文件和权限。'));
            const resume = node('button', 'btn-secondary', '从检查点继续'); resume.type = 'button';
            resume.addEventListener('click', async () => { const sequence = ++epoch; resume.disabled = true; feedback.textContent = ''; try {
                const tokenBudget = readTokenBudget();
                if (currentBudget === 0 && tokenBudget > 0) throw new Error('本任务累计模型预算为不限，请清空预算或填写 0 后继续。');
                if (value.error?.code === 'PPT_MASTER_BUDGET_EXHAUSTED' && tokenBudget !== 0 && (tokenBudget ?? currentBudget) <= currentBudget) {
                    throw new Error('请先在高级设置中增加累计模型预算，或填 0 取消累计上限。');
                }
                await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/resume', post({
                    tokenBudget: tokenBudget > 0 ? Math.max(tokenBudget, currentBudget ?? 0) : tokenBudget,
                    maxSteps: Math.max(Number(byId('presentation-master-steps').value), Number(value.request?.maxSteps || 0)),
                    modelId: byId('presentation-master-model').value
                }));
                await poll(value.id, sequence);
            } catch (error) { if (isCurrent(sequence)) { resume.disabled = false; feedback.textContent = errorText(error); } } }); panel.appendChild(resume);
        }
        const actionRow = node('div', 'presentation-master-task-actions');
        for (const file of value.result?.files || []) {
            const download = node('button', 'btn-secondary', file.format === 'pptx' ? '下载演示文件（.pptx）' : '下载完整项目源包'); download.type = 'button';
            download.addEventListener('click', async () => {
                const sequence = epoch;
                try { const data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
                    if (!isCurrent(sequence)) return;
                    const url = '/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token);
                    const link = node('a'); link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
                } catch (error) { showError(error, sequence); }
            }); actionRow.appendChild(download);
            if (file.format === 'pptx') {
                const edit = node('button', 'btn-secondary', '在浏览器编辑原生对象'); edit.type = 'button';
                edit.addEventListener('click', () => {
                    closeModal();
                    window.Pivot.moduleApi('apps.presentations.native').open({ sourceRenditionId: String(file.renditionId), title: value.request?.title || '完整制作结果' })
                    .catch(error => helpers.toast(errorText(error), 'error'));
                }); actionRow.appendChild(edit);
            }
        }
        if (actionRow.children.length) panel.appendChild(actionRow);
        panel.appendChild(feedback);
        if (sameTask && panel.closest('.workspace-modal-body')) panel.closest('.workspace-modal-body').scrollTop = scroll;
    }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers;
        if (bound) return; bound = true;
        document.addEventListener('click', event => {
            if (!event.target.closest?.('[data-presentation-master-open]')) return;
            const opening = open(), sequence = epoch;
            void opening.catch(error => showError(error, sequence));
        });
    }
    window.Pivot.exposeModule('apps.presentations.master', { bind, open });
})();
