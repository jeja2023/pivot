(function () {
    'use strict';
    const API = '/api/apps/presentations/master';
    let bound = false, state, helpers, epoch = 0, selectedTemplate = null, preparation = null, returnFocus = null, processReturnFocus = null;
    let historySession = null;
    const byId = id => document.getElementById(id);
    const actorId = () => String(window.Pivot.legacy?.currentUser?.id || '');
    const presentationId = () => String(state.active?.id || '');
    function isCurrent(sequence) {
        const modal = byId('presentation-master-modal');
        return sequence === epoch && modal && !modal.classList.contains('hidden')
            && modal.dataset.owner === actorId() && modal.dataset.presentationId === presentationId();
    }
    function isProcessCurrent(sequence) {
        const processModal = byId('presentation-master-process-modal');
        return sequence === epoch && processModal && !processModal.classList.contains('hidden')
            && processModal.dataset.owner === actorId() && processModal.dataset.presentationId === presentationId();
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
    function setFormModalInert(inactive) {
        const modal = byId('presentation-master-modal');
        if (!modal) return;
        if (inactive) modal.setAttribute('aria-hidden', 'true');
        else modal.removeAttribute('aria-hidden');
        if ('inert' in modal) modal.inert = Boolean(inactive);
    }
    function closeProcessModal({ restoreFocus = true, resetEpoch = true } = {}) {
        if (resetEpoch) ++epoch;
        historySession = null;
        preparation?.abort(); preparation = null;
        window.Pivot.moduleApi('apps.presentations.masterPageReview')?.closeUsageModal?.({ restoreFocus: false });
        const processModal = byId('presentation-master-process-modal');
        const panel = byId('presentation-master-status');
        if (panel) {
            panel.replaceChildren();
            delete panel.dataset.taskId;
        }
        const modal = byId('presentation-master-modal');
        if (modal) {
            delete modal.dataset.modelTask;
            const startButton = byId('presentation-master-start');
            const historyButton = byId('presentation-master-history');
            const activeButton = byId('presentation-master-active');
            const activeForm = !modal.classList.contains('hidden');
            if (startButton) { startButton.textContent = '开始制作'; startButton.disabled = !activeForm || modal.dataset.engineEnabled !== 'true'; }
            if (historyButton) historyButton.disabled = !activeForm;
            if (activeButton) activeButton.disabled = !activeForm;
        }
        setFormModalInert(false);
        if (processModal && !processModal.classList.contains('hidden')) processModal.classList.add('hidden');
        const focus = processReturnFocus; processReturnFocus = null;
        if (restoreFocus && focus?.isConnected) focus.focus();
    }
    function exitProcessView() {
        if (historySession?.detail && isProcessCurrent(epoch)) {
            void showHistory();
            return;
        }
        closeProcessModal();
    }
    function closeModal({ preserveForm = false } = {}) {
        ++epoch;
        closeProcessModal({ restoreFocus: false, resetEpoch: false });
        const modal = byId('presentation-master-modal');
        const processModal = byId('presentation-master-process-modal');
        if (preserveForm) {
            modal?.classList.add('hidden');
            const formError = byId('presentation-master-form-error');
            if (formError) formError.textContent = '';
        } else {
            window.Pivot.moduleApi('apps.presentations.masterPageReview')?.removeUsageModal?.();
            processModal?.remove();
            modal?.remove();
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
            headerRow.append(title, badge);
            if (selectedTemplate.version) headerRow.append(node('span', 'presentation-version-badge', 'v' + selectedTemplate.version));

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
        const headerIcon = node('span', 'presentation-master-header-icon');
        headerIcon.appendChild(svgIcon([['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2', ry: '2' }], ['line', { x1: '8', y1: '21', x2: '16', y2: '21' }], ['line', { x1: '12', y1: '17', x2: '12', y2: '21' }]], 17));
        const headerTitleRow = node('div', 'presentation-master-header-title-row');
        headerTitleRow.append(
            headerIcon,
            node('h3', '', '完整演示制作')
        );
        const headerSubtitle = node('p', 'presentation-master-header-subtitle', '多模态高保真 PPT 引擎 · 原生矢量可编辑交付');
        headerInfo.append(headerTitleRow, headerSubtitle);

        const close = node('button', 'btn-secondary workspace-modal-close', '关闭'); close.type = 'button'; close.addEventListener('click', () => closeModal());
        header.append(headerInfo, close);

        const body = node('div', 'workspace-modal-body');
        const templateNote = node('div', 'presentation-master-template-note presentation-master-hero'); templateNote.id = 'presentation-master-template-note';
        body.appendChild(templateNote);

        const form = window.Pivot.moduleApi('apps.presentations.masterForm').mount();
        const submit = node('button', 'btn-primary presentation-master-start-btn', '开始制作'); submit.type = 'button'; submit.id = 'presentation-master-start'; submit.disabled = true;
        submit.addEventListener('click', start);

        const engineState = node('div', 'presentation-master-engine-state'); engineState.id = 'presentation-master-engine-state'; engineState.setAttribute('aria-live', 'polite');
        const history = node('button', 'btn-secondary', '查看最近制作'); history.type = 'button'; history.id = 'presentation-master-history';
        history.addEventListener('click', () => loadTask(history, '/tasks/latest?presentationId=' + encodeURIComponent(presentationId())));
        const activeTask = node('button', 'btn-secondary', '查看进行中的制作'); activeTask.type = 'button'; activeTask.id = 'presentation-master-active';
        activeTask.addEventListener('click', () => loadTask(activeTask, '/tasks/active', true));

        const formError = node('p', 'presentation-master-task-feedback presentation-master-form-error'); formError.id = 'presentation-master-form-error'; formError.setAttribute('role', 'alert');

        const footer = node('footer', 'presentation-master-footer');
        const footerBar = node('div', 'presentation-master-footer-bar');
        const footerActions = node('div', 'presentation-master-footer-actions');
        footerActions.append(history, activeTask, submit);
        footerBar.append(engineState, footerActions);
        footer.append(formError, footerBar);

        body.appendChild(form); dialog.append(header, body, footer); modal.appendChild(dialog); document.body.appendChild(modal);
        modal.addEventListener('keydown', event => {
            const processModal = byId('presentation-master-process-modal');
            if (processModal && !processModal.classList.contains('hidden')) return;
            if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
            window.Pivot.moduleApi('apps.presentations.masterPageReview')?.trapDialogFocus?.(dialog, event);
        });
        byId('presentation-master-operation').addEventListener('change', event => {
            const profile = byId('presentation-master-profile'); profile.disabled = event.target.value !== 'generate'; if (profile.disabled) profile.value = 'default';
            selectedTemplate = null;
            window.Pivot.moduleApi('apps.presentations.masterForm')?.updateTemplateLock(false);
            renderTemplateCard();
        });
    }
    function ensureProcessModal() {
        if (byId('presentation-master-process-modal')) return byId('presentation-master-process-modal');
        const processModal = node('div', 'modal-overlay presentation-master-process-overlay hidden');
        processModal.id = 'presentation-master-process-modal';
        const dialog = node('section', 'workspace-modal presentation-master-process-dialog');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '完整制作过程');

        const header = node('header', 'workspace-modal-header presentation-master-header');
        const headerInfo = node('div', 'presentation-master-header-info');
        const headerTitleRow = node('div', 'presentation-master-header-title-row');
        const headerIcon = node('span', 'presentation-master-header-icon');
        headerIcon.appendChild(svgIcon([['polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' }]], 16));
        headerTitleRow.append(
            headerIcon,
            node('h3', '', '完整制作过程')
        );
        const headerSubtitle = node('p', 'presentation-master-header-subtitle', '实时展示模型预检、材料读取、分阶段确认与产物交付');
        headerInfo.append(headerTitleRow, headerSubtitle);
        const closeBtn = node('button', 'btn-secondary workspace-modal-close', '关闭'); closeBtn.type = 'button';
        closeBtn.addEventListener('click', exitProcessView);
        header.append(headerInfo, closeBtn);

        const body = node('div', 'workspace-modal-body presentation-master-process-body');
        const status = node('div', 'presentation-master-status-card');
        status.id = 'presentation-master-status'; status.setAttribute('aria-live', 'polite');
        body.appendChild(status);

        const footer = node('footer', 'presentation-master-footer presentation-master-process-footer');
        const footerHint = node('div', 'presentation-master-footer-hint');
        const processHintText = node('p', 'presentation-master-hint', '点击右上角「关闭」或按 Esc 返回配置页面，后台任务将继续运行；如需取消请点击「停止制作」。');
        processHintText.id = 'presentation-master-process-hint';
        footerHint.append(
            svgIcon([['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '16', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '8', x2: '12.01', y2: '8' }]], 15),
            processHintText
        );
        footer.appendChild(footerHint);

        dialog.append(header, body, footer); processModal.appendChild(dialog); document.body.appendChild(processModal);
        processModal.addEventListener('click', event => { if (event.target === processModal) exitProcessView(); });
        processModal.addEventListener('keydown', event => {
            const usageModal = byId('presentation-master-usage-modal');
            if (usageModal && !usageModal.classList.contains('hidden')) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exitProcessView(); return; }
            window.Pivot.moduleApi('apps.presentations.masterPageReview')?.trapDialogFocus?.(dialog, event);
        });
        return processModal;
    }
    function openProcessModal({ trigger = null, initialMessage = '' } = {}) {
        const processModal = ensureProcessModal();
        if (processModal.classList.contains('hidden')) processReturnFocus = trigger || document.activeElement;
        processModal.dataset.owner = actorId();
        processModal.dataset.presentationId = presentationId();
        setFormModalInert(true);
        processModal.classList.remove('hidden');
        const panel = byId('presentation-master-status');
        if (initialMessage) panel.replaceChildren(node('p', 'presentation-master-task-message', initialMessage));
        panel.closest('.workspace-modal-body').scrollTop = 0;
        updateProcessHeader();
        processModal.querySelector('.workspace-modal-close')?.focus();
    }
    function updateProcessHeader() {
        const processModal = byId('presentation-master-process-modal'), dialog = processModal.querySelector('[role="dialog"]');
        const list = historySession && !historySession.detail;
        const title = list ? '完整制作记录' : '完整制作过程';
        dialog.setAttribute('aria-label', title);
        dialog.querySelector('h3').textContent = title;
        dialog.querySelector('.presentation-master-header-subtitle').hidden = Boolean(list);
        byId('presentation-master-process-hint').textContent = list ? '选择一条记录查看任务详情。'
            : historySession ? '点击「关闭」或按 Esc 返回完整制作记录。后台任务会继续运行。'
                : '点击「关闭」或按 Esc 返回配置页面。后台任务会继续运行，如需取消请点击「停止制作」。';
    }
    function errorText(error) { const message = String(error?.message || ''); return /[\u3400-\u9fff]/u.test(message) ? message : '处理未完成，请检查文件、网络或服务连接后重试。'; }
    function clearFormError() {
        const formError = byId('presentation-master-form-error');
        if (formError) formError.textContent = '';
    }
    function showFormError(message) {
        const formError = byId('presentation-master-form-error');
        if (!formError) return;
        formError.textContent = message;
        formError.scrollIntoView?.({ block: 'nearest' });
    }
    function showError(error, sequence) {
        if ((!isCurrent(sequence) && !isProcessCurrent(sequence)) || error.name === 'AbortError') return;
        const text = errorText(error);
        const processModal = byId('presentation-master-process-modal');
        if (processModal && !processModal.classList.contains('hidden')) {
            const status = byId('presentation-master-status'), message = node('p', 'presentation-master-task-feedback', text);
            message.setAttribute('role', 'alert');
            status.replaceChildren(message);
            status.scrollIntoView?.({ block: 'nearest' });
            return;
        }
        showFormError(text);
    }

    function renderEngineReady() {
        const panel = byId('presentation-master-engine-state');
        if (!panel) return;
        panel.replaceChildren();
        const row = node('div', 'presentation-master-ready-row');
        const dot = node('span', 'presentation-master-ready-dot');
        const text = node('span', 'presentation-master-ready-text', '完整制作引擎已登记，交付原生矢量文稿与项目源包');
        const badge = node('span', 'presentation-master-ready-badge', '服务就绪');
        row.append(dot, text, badge);
        panel.appendChild(row);
    }

    async function open(options = {}) {
        const sequence = ++epoch, actor = actorId(), target = presentationId(), focus = document.activeElement;
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-goals.js');
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-master-form.js');
        await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-master-page-review.js');
        if (sequence !== epoch || actor !== actorId() || target !== presentationId()) return;
        closeProcessModal({ restoreFocus: false, resetEpoch: false });
        const previous = byId('presentation-master-modal');
        if (previous && (!previous.classList.contains('hidden') || previous.dataset.owner !== actor || previous.dataset.presentationId !== target)) {
            byId('presentation-master-process-modal')?.remove();
            previous.remove();
            selectedTemplate = null;
        }
        returnFocus = focus;
        ensureModal();
        const modal = byId('presentation-master-modal');
        modal.dataset.owner = actor; modal.dataset.presentationId = target;
        modal.dataset.engineEnabled = 'false';
        modal.classList.remove('hidden');
        clearFormError();
        const startButton = byId('presentation-master-start');
        startButton.disabled = true;
        startButton.textContent = '开始制作';
        byId('presentation-master-history').disabled = true;
        byId('presentation-master-active').disabled = true;
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
            modal.dataset.engineEnabled = engine.enabled ? 'true' : 'false';
            startButton.disabled = !engine.enabled;
            if (engine.enabled) renderEngineReady();
            else {
                const fallback = node('button', 'btn-secondary', '使用标准演示制作'); fallback.type = 'button';
                fallback.addEventListener('click', () => { const profile = window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master'); closeModal(); helpers.openCreateModal(); window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-create', profile); });
                byId('presentation-master-engine-state').replaceChildren(node('p', 'presentation-master-task-message', '完整制作服务未连接或暂不可用，标准演示创建、编辑和导出继续可用。'), fallback);
            }
        } catch (error) { showError(error, sequence); }
        finally { if (isCurrent(sequence)) { byId('presentation-master-history').disabled = false; byId('presentation-master-active').disabled = false; } }
    }

    async function openHistory(trigger) {
        if (byId('presentation-master-modal') && isCurrent(epoch)) closeModal();
        const sequence = ++epoch, actor = actorId(), target = presentationId();
        try {
            await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-presentation-master-page-review.js');
            if (sequence !== epoch || actor !== actorId() || target !== presentationId()) return;
            closeProcessModal({ restoreFocus: false, resetEpoch: false });
            historySession = { detail: false, tasks: null, selectedId: '', scrollTop: 0 };
            openProcessModal({ trigger, initialMessage: '正在读取完整制作记录…' });
            await showHistory();
        } catch (error) {
            if (sequence === epoch && actor === actorId() && target === presentationId()) helpers.toast(errorText(error), 'error');
        }
    }

    async function showHistory() {
        const sequence = ++epoch, history = historySession, panel = byId('presentation-master-status');
        const body = panel.closest('.workspace-modal-body'), close = body.parentElement.querySelector('.workspace-modal-close');
        history.detail = false;
        delete panel.dataset.taskId;
        updateProcessHeader();
        close.focus();
        const render = (tasks, restoreRow) => {
            window.Pivot.moduleApi('apps.presentations.masterPageReview').mountHistory(panel, tasks, node, id => {
                if (!isProcessCurrent(sequence)) return;
                history.detail = true;
                history.selectedId = id;
                history.scrollTop = body.scrollTop;
                const detailSequence = ++epoch;
                openProcessModal({ initialMessage: '正在读取任务详情…' });
                void poll(id, detailSequence).catch(error => showError(error, detailSequence));
            });
            body.scrollTop = history.scrollTop;
            if (restoreRow) {
                const selected = [...panel.querySelectorAll('[data-history-task-id]')].find(button => button.dataset.historyTaskId === history.selectedId);
                (selected || close).focus({ preventScroll: true });
            }
        };
        try {
            if (history.tasks) render(history.tasks, true);
            const { tasks } = await helpers.requestJson(API + '/tasks/recent');
            if (!isProcessCurrent(sequence)) return;
            const focusedId = document.activeElement?.dataset.historyTaskId;
            if (focusedId) history.selectedId = focusedId;
            history.scrollTop = body.scrollTop;
            history.tasks = tasks;
            render(tasks, Boolean(focusedId));
        } catch (error) {
            if (!isProcessCurrent(sequence)) return;
            if (!history.tasks) showError(error, sequence);
        }
    }

    async function loadTask(button, route, showAccountTask = false) {
        if (preparation) return;
        const sequence = ++epoch;
        clearFormError();
        button.disabled = true;
        openProcessModal({ trigger: button, initialMessage: '正在查询制作进度…' });
        try {
            const { task } = await helpers.requestJson(API + route);
            if (!isProcessCurrent(sequence)) return;
            if (task) {
                if (showAccountTask) renderTask(task);
                if (!showAccountTask || task.request && task.status === 'working') await poll(task.id, sequence);
            } else byId('presentation-master-status').replaceChildren(node('p', 'presentation-master-task-message', showAccountTask ? '当前账号暂无进行中的制作任务。' : '暂无制作记录。'));
        } catch (error) { showError(error, sequence); }
        finally { if (isCurrent(sequence) || !byId('presentation-master-modal')?.classList.contains('hidden')) button.disabled = false; }
    }
    function readTokenBudget(input = byId('presentation-master-budget')) {
        const budget = Number(input.value);
        if (!input.validity.valid || !Number.isSafeInteger(budget) || (budget !== 0 && budget < 10000)) {
            throw new Error('累计模型预算请填写 0（不限）或不小于 10000 的整数。');
        }
        return input.value === '' ? undefined : budget;
    }
    async function start() {
        if (preparation) return;
        clearFormError();
        const button = byId('presentation-master-start'), history = byId('presentation-master-history'), activeButton = byId('presentation-master-active');
        let title, instruction, modelId, tokenBudget, files, form, snapshot;
        try {
            title = byId('presentation-master-title').value.trim();
            instruction = byId('presentation-master-instruction').value.trim();
            modelId = byId('presentation-master-model').value;
            if (!title || !instruction || !modelId) throw new Error('请填写名称和制作要求，并选择模型。');
            tokenBudget = readTokenBudget();
            files = [...(byId('presentation-master-source').files || [])];
            if (files.length > 21) throw new Error('单次最多提供21个原稿和补充素材。');
            form = window.Pivot.moduleApi('apps.presentations.masterForm');
            snapshot = form.snapshot();
        } catch (error) {
            showFormError(errorText(error));
            return;
        }
        button.disabled = true; history.disabled = true; if (activeButton) activeButton.disabled = true;
        const controller = preparation = new AbortController(), sequence = ++epoch, active = state.active;
        const ensureCurrent = () => { if (controller.signal.aborted || !isProcessCurrent(sequence) || active !== state.active) throw Object.assign(new Error('制作准备已取消'), { name: 'AbortError' }); };
        openProcessModal({ trigger: button, initialMessage: '正在预检模型…' });
        try {
            const template = selectedTemplate;
            const currentMaterial = active?.content ? { title: active.title || '当前文稿', text: JSON.stringify(active.content) } : null;
            const request = { title, instruction, modelId, operation: byId('presentation-master-operation').value,
                productionProfile: window.Pivot.moduleApi('apps.presentations.goals').read('presentation-master', active?.content?.metadata?.productionProfile || {}),
                profile: byId('presentation-master-profile').value, pageCount: Number(byId('presentation-master-pages').value), tokenBudget,
                maxSteps: Number(byId('presentation-master-steps').value), presentationId: active?.id || '',
                ...(template ? { template: { type: template.type, id: template.id, ...(template.version ? { version: template.version } : {}) } } : {}) };
            button.textContent = '正在预检模型…';
            await helpers.requestJson(API + '/model-preflight', { ...post({ modelId, operation: request.operation, profile: request.profile,
                visionRequired: files.some(file => /\.(?:png|jpe?g|webp)$/i.test(file.name)) }), signal: controller.signal });
            ensureCurrent();
            button.textContent = snapshot.files.length ? '正在读取材料…' : '正在准备制作…';
            byId('presentation-master-status').replaceChildren(node('p', 'presentation-master-task-message', snapshot.files.length ? '正在读取材料…' : '正在准备制作…'));
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
        } catch (error) { showError(error, sequence); }
        finally {
            if (preparation === controller) {
                preparation = null;
                button.disabled = !isCurrent(epoch);
                history.disabled = button.disabled;
                if (activeButton) activeButton.disabled = button.disabled;
                button.textContent = '开始制作';
            }
        }
    }
    async function poll(id, sequence, failures = 0) {
        if (!isProcessCurrent(sequence)) return;
        let data;
        try { data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(id)); }
        catch (error) {
            if (!isProcessCurrent(sequence)) return;
            const panel = byId('presentation-master-status');
            let warning = panel.querySelector('[data-master-poll-error]');
            if (!warning) { warning = node('div', 'presentation-master-task-feedback'); warning.dataset.masterPollError = 'true'; warning.setAttribute('role', 'alert'); panel.appendChild(warning); }
            warning.replaceChildren(node('p', '', '状态暂时无法更新，后台任务可能仍在运行。'));
            const retry = node('button', 'btn-secondary', '重新查询状态'); retry.type = 'button';
            retry.addEventListener('click', () => { retry.disabled = true; const retrySequence = ++epoch; void poll(id, retrySequence).catch(error => showError(error, retrySequence)); }); warning.appendChild(retry);
            if (failures < 3) window.setTimeout(() => poll(id, sequence, failures + 1).catch(error => showError(error, sequence)), 3000);
            return;
        }
        if (!isProcessCurrent(sequence)) return;
        renderTask(data.task);
        if (data.task.status === 'working') window.setTimeout(() => poll(id, sequence).catch(error => showError(error, sequence)), 1500);
    }
    function renderTask(value) {
        const panel = byId('presentation-master-status');
        const scroll = panel.closest('.workspace-modal-body')?.scrollTop || 0;
        panel.dataset.taskId = String(value.id); panel.replaceChildren();
        const feedback = node('p', 'presentation-master-task-feedback'); feedback.setAttribute('role', 'alert');
        const head = node('div', 'presentation-master-task-head');
        const headMeta = node('div', 'presentation-master-task-head-meta');
        const statusBadge = node('strong', 'presentation-master-task-badge ' + (value.status || ''), ({ working: '正在制作中', input_required: '需要人工确认', completed: '制作完成', failed: '制作未完成', cancelled: '已取消', expired: '任务已过期' })[value.status] || '制作任务');
        headMeta.appendChild(statusBadge);
        if (value.request?.title) headMeta.appendChild(node('span', 'presentation-master-task-title', value.request.title));
        head.appendChild(headMeta);
        panel.appendChild(head);
        if (!value.inputRequest) {
            if (value.status === 'failed' || value.error?.message) {
                const errorBanner = node('div', 'presentation-master-error-banner');
                const errorHead = node('div', 'presentation-master-error-head');
                const errIcon = svgIcon([['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '12', y1: '8', x2: '12', y2: '12' }], ['line', { x1: '12', y1: '16', x2: '12.01', y2: '16' }]], 15);
                errIcon.setAttribute('aria-hidden', 'true');
                errorHead.append(errIcon, node('p', 'presentation-master-task-message', value.error?.message ? errorText(value.error) : value.progress?.message || '制作未完成。'));
                errorBanner.appendChild(errorHead);
                if (value.status === 'failed' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value.error?.code || '')) {
                    errorBanner.appendChild(node('span', 'presentation-master-error-code', '错误代码 ' + value.error.code));
                }
                panel.appendChild(errorBanner);
            } else {
                panel.appendChild(node('p', 'presentation-master-task-message', value.result?.message || value.progress?.message || '正在准备。'));
            }
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
        const modal = historySession ? null : byId('presentation-master-modal');
        if (modal && (value.recoverable || value.status === 'input_required') && modal.dataset.modelTask !== String(value.id) && value.request?.modelId) {
            const model = byId('presentation-master-model'); if ([...model.options].some(option => option.value === String(value.request.modelId))) model.value = String(value.request.modelId);
            modal.dataset.modelTask = String(value.id);
        }
        window.Pivot.moduleApi('apps.presentations.masterPageReview')?.mountUsageButton?.(panel, value.usageDiagnostics);
        if (['working', 'input_required'].includes(value.status)) {
            const cancel = node('button', 'btn-danger-outline presentation-master-stop-btn'); cancel.type = 'button';
            const stopIcon = svgIcon([['rect', { x: '6', y: '6', width: '12', height: '12', rx: '2' }]], 12);
            stopIcon.setAttribute('aria-hidden', 'true');
            cancel.append(stopIcon, node('span', '', '停止制作'));
            cancel.addEventListener('click', async () => { cancel.disabled = true; const sequence = ++epoch; try { const data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/cancel', post({})); if (isProcessCurrent(sequence)) renderTask(data.task); } catch (error) { if (isProcessCurrent(sequence)) { cancel.disabled = false; feedback.textContent = errorText(error); window.setTimeout(() => poll(value.id, sequence).catch(failure => showError(failure, sequence)), 3000); } } });
            head.appendChild(cancel);
        }
        if (value.inputRequest) {
            const request = value.inputRequest || {}, confirmation = request.kind === 'confirmation';
            const reviewBox = node('div', 'presentation-master-review-panel');
            if (request.stage) {
                const stages = { direction: '确认沟通方向', design: '确认最终页面与关键数据清单', template: '确认模板制作方案' };
                if (stages[request.stage]) {
                    const stageHead = node('div', 'presentation-master-review-stage');
                    const stageIcon = svgIcon([['path', { d: 'M9 11l3 3L22 4' }], ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }]], 14);
                    stageIcon.setAttribute('aria-hidden', 'true');
                    stageHead.append(stageIcon, node('span', '', stages[request.stage]));
                    reviewBox.appendChild(stageHead);
                }
            }
            reviewBox.appendChild(node('p', 'presentation-master-task-question', request.question || '请提供继续制作所需的答复。'));
            if (request.context) reviewBox.appendChild(node('div', 'presentation-master-task-context', request.context));
            if (request.plan?.templateUse) {
                const { page, visibleText, rule } = request.plan.templateUse;
                reviewBox.appendChild(node('p', 'presentation-master-task-context', `第 ${page} 页「${visibleText}」采用的模板规范：${rule}`));
            }
            if (request.plan?.pages?.length) {
                const details = node('details', 'presentation-master-plan-checklist'), pages = node('ol', 'presentation-master-plan-pages');
                details.open = true;
                details.appendChild(node('summary', '', `已拟定 ${request.plan.pages.length} 页，请逐页核对`));
                let pageIndex = 0;
                for (const page of request.plan.pages) {
                    pageIndex++;
                    const item = node('li', 'presentation-master-plan-page');
                    const titleRow = node('div', 'presentation-master-plan-page-head');
                    titleRow.append(node('span', 'presentation-master-plan-num', String(pageIndex)), node('span', 'presentation-master-plan-title', page.title));
                    item.appendChild(titleRow);
                    const facts = node('ul', 'presentation-master-plan-facts');
                    for (const fact of page.values || []) {
                        const chart = fact.chart ? `（图表 ${fact.chart.series} / ${fact.chart.category} 为 ${fact.chart.number}）` : '';
                        const factLi = node('li', 'presentation-master-plan-fact');
                        factLi.append(node('span', 'presentation-master-plan-fact-text', fact.text + chart));
                        if (fact.previousText) factLi.append(node('span', 'presentation-master-plan-source', '已按原文更正，原拟为「' + fact.previousText + '」。'));
                        if (fact.source) {
                            const source = window.Pivot.moduleApi('apps.presentations.masterPageReview').citationSourceName(fact.source.path);
                            factLi.append(node('span', 'presentation-master-plan-source', `（${source}，引文 ${fact.source.quote}）`));
                        }
                        facts.appendChild(factLi);
                    }
                    if (facts.children.length) item.appendChild(facts);
                    pages.appendChild(item);
                }
                details.appendChild(pages); reviewBox.appendChild(details);
            }
            const answer = node('textarea', 'form-input presentation-master-task-answer'); answer.rows = 2; answer.maxLength = 12000; answer.setAttribute('aria-label', '对制作方案的实际答复');
            answer.placeholder = confirmation ? '如需调整方案，请在此输入修改意见，再点击「提交修改意见」；无须调整可直接点击「确认并继续」。' : '请填写具体答复后继续。';
            const submit = node('button', 'btn-primary presentation-master-confirm-btn'); submit.type = 'button';
            const confirmIcon = svgIcon([['polyline', { points: '20 6 9 17 4 12' }]], 14);
            confirmIcon.setAttribute('aria-hidden', 'true');
            submit.append(confirmIcon, node('span', '', confirmation ? '确认并继续' : '提交答复并继续'));
            const actions = node('div', 'presentation-master-task-actions presentation-master-confirm-actions');
            const revise = confirmation ? node('button', 'btn-secondary presentation-master-revise-btn') : null;
            if (revise) {
                revise.type = 'button';
                const editIcon = svgIcon([['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z' }]], 13);
                editIcon.setAttribute('aria-hidden', 'true');
                revise.append(editIcon, node('span', '', '提交修改意见'));
                actions.appendChild(revise);
            }
            actions.appendChild(submit);
            const syncActionState = () => actions.classList.toggle('has-draft-reply', Boolean(answer.value.trim()));
            answer.addEventListener('input', syncActionState);
            syncActionState();
            async function respond(decision) {
                const response = answer.value.trim();
                if (decision !== 'approve' && !response) { feedback.textContent = '请先填写具体答复，再继续制作。'; answer.focus(); return; }
                if (decision === 'approve' && response) { feedback.textContent = '请提交已填写的修改意见，或清空意见后确认。'; answer.focus(); return; }
                feedback.textContent = ''; submit.disabled = true; if (revise) revise.disabled = true;
                const sequence = ++epoch;
                try {
                    await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/respond', post({ answer: response, decision, promptId: request.promptId }));
                    await poll(value.id, sequence);
                } catch (error) { if (isProcessCurrent(sequence)) { submit.disabled = false; if (revise) revise.disabled = false; feedback.textContent = errorText(error); } }
            }
            submit.addEventListener('click', () => respond(confirmation ? 'approve' : 'clarify'));
            revise?.addEventListener('click', () => respond('revise'));
            reviewBox.append(answer, actions);
            panel.appendChild(reviewBox);
        }
        if (value.recoverable) {
            const resumePanel = node('div', 'presentation-master-resume-panel');
            const resumeHead = node('div', 'presentation-master-resume-head');
            const resumeHeadIcon = node('span', 'presentation-master-resume-icon');
            const cpIcon = svgIcon([['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }], ['polyline', { points: '3 3 3 8 8 8' }]], 15);
            cpIcon.setAttribute('aria-hidden', 'true');
            resumeHeadIcon.appendChild(cpIcon);
            const resumeHeadText = node('div', 'presentation-master-resume-head-text');
            resumeHeadText.append(
                node('strong', 'presentation-master-resume-title', '从检查点恢复'),
                node('p', 'presentation-master-resume-subtitle', '已保存任务检查点；继续前会核对现有文件和权限。')
            );
            resumeHead.append(resumeHeadIcon, resumeHeadText);
            resumePanel.appendChild(resumeHead);
            if (value.error?.code === 'PPT_MASTER_BUDGET_EXHAUSTED') {
                resumePanel.appendChild(node('p', 'presentation-master-resume-tip', `本任务累计预算为 ${budgetText}。请在下方提高续跑累计预算或填 0 取消累计上限，再点击“从检查点继续”。`));
            }
            const resumeFields = node('div', 'presentation-master-resume-fields');
            const budgetWrap = node('label', 'modal-form-field' + (value.error?.code === 'PPT_MASTER_BUDGET_EXHAUSTED' ? ' is-highlighted' : ''));
            budgetWrap.appendChild(node('span', 'modal-form-label', '续跑累计预算（令牌，0 为不限）'));
            const resumeBudget = node('input', 'form-input'); resumeBudget.type = 'number'; resumeBudget.id = 'presentation-master-resume-budget';
            resumeBudget.min = '0'; resumeBudget.step = '1'; resumeBudget.placeholder = '留空沿用原预算，0 改为不限';
            const formBudget = modal && byId('presentation-master-budget');
            resumeBudget.value = formBudget?.value || '';
            resumeBudget.addEventListener('input', () => { if (formBudget) formBudget.value = resumeBudget.value; });
            budgetWrap.appendChild(resumeBudget);

            const stepsWrap = node('label', 'modal-form-field');
            stepsWrap.appendChild(node('span', 'modal-form-label', '执行轮次上限（5至160）'));
            const resumeSteps = node('input', 'form-input'); resumeSteps.type = 'number'; resumeSteps.id = 'presentation-master-resume-steps';
            resumeSteps.min = '5'; resumeSteps.max = '160'; resumeSteps.step = '1';
            const formSteps = modal && byId('presentation-master-steps');
            resumeSteps.value = formSteps?.value || String(value.request?.maxSteps || 80);
            resumeSteps.addEventListener('input', () => { if (formSteps) formSteps.value = resumeSteps.value; });
            stepsWrap.appendChild(resumeSteps);

            const modelWrap = node('label', 'modal-form-field');
            modelWrap.appendChild(node('span', 'modal-form-label', '制作模型'));
            const resumeModel = node('select', 'form-input'); resumeModel.id = 'presentation-master-resume-model';
            const formModel = modal && byId('presentation-master-model');
            if (formModel) {
                for (const option of formModel.options) resumeModel.appendChild(option.cloneNode(true));
                resumeModel.value = formModel.value;
                resumeModel.addEventListener('change', () => { formModel.value = resumeModel.value; });
            }
            modelWrap.appendChild(resumeModel);
            resumeFields.append(budgetWrap, stepsWrap, modelWrap);
            resumePanel.appendChild(resumeFields);

            const resumeActions = node('div', 'presentation-master-task-actions presentation-master-resume-actions');
            const resume = node('button', 'btn-primary presentation-master-resume-btn'); resume.type = 'button';
            const review = window.Pivot.moduleApi('apps.presentations.masterPageReview');
            const readRepair = review.mount(resumePanel, value, node);
            const readNote = !readRepair && review.mountResumeNote(resumePanel, value, node);
            const playIcon = svgIcon([['polygon', { points: '6 4 20 12 6 20 6 4' }]], 13);
            playIcon.setAttribute('aria-hidden', 'true');
            resume.append(playIcon, node('span', '', readRepair ? '仅修复所选页面' : '从检查点继续'));
            if (historySession) {
                const original = String(value.request?.modelId || '');
                resumeModel.appendChild(new Option(original ? '沿用原制作模型' : '正在加载可用模型…', original));
                resume.disabled = !original;
                const sequence = epoch;
                void window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', resumeModel, {
                    isCurrent: () => isProcessCurrent(sequence) && resumeModel.isConnected
                }).then(() => {
                    if (!isProcessCurrent(sequence) || !resumeModel.isConnected) return;
                    if (original && !resumeModel.value) resumeModel.appendChild(new Option('沿用原制作模型', original, true, true));
                    resume.disabled = !resumeModel.value;
                });
            }
            resume.addEventListener('click', async () => { const sequence = ++epoch; resume.disabled = true; feedback.textContent = ''; try {
                const tokenBudget = readTokenBudget(resumeBudget);
                if (currentBudget === 0 && tokenBudget > 0) throw new Error('本任务累计模型预算为不限，请清空预算或填写 0 后继续。');
                if (value.error?.code === 'PPT_MASTER_BUDGET_EXHAUSTED' && tokenBudget !== 0 && (tokenBudget ?? currentBudget) <= currentBudget) {
                    resumeBudget.focus();
                    throw new Error('请先提高续跑累计模型预算，或填 0 取消累计上限。');
                }
                await helpers.requestJson(API + '/tasks/' + encodeURIComponent(value.id) + '/resume', post({
                    tokenBudget: tokenBudget > 0 ? Math.max(tokenBudget, currentBudget ?? 0) : tokenBudget,
                    maxSteps: Math.max(Number(resumeSteps.value), Number(value.request?.maxSteps || 0)),
                    modelId: resumeModel.value || formModel?.value || '',
                    ...(readRepair ? readRepair() : readNote())
                }));
                await poll(value.id, sequence);
            } catch (error) { if (isProcessCurrent(sequence)) { resume.disabled = false; feedback.textContent = errorText(error); } } });
            resumeActions.appendChild(resume);
            resumePanel.appendChild(resumeActions);
            panel.appendChild(resumePanel);
        }
        const actionRow = node('div', 'presentation-master-task-actions');
        const openNative = source => {
            closeModal();
            return window.Pivot.moduleApi('apps.presentations.native').open(source).catch(error => helpers.toast(errorText(error), 'error'));
        };
        window.Pivot.moduleApi('apps.presentations.masterPageReview').mountActions(actionRow, panel, value, {
            node, getEpoch: () => epoch, isCurrent: isProcessCurrent, showError: errorText, feedback,
            requestJson: helpers.requestJson, openNative,
            async restart(id, regenerate) {
                const sequence = ++epoch;
                if (!regenerate) return poll(id, sequence).catch(error => showError(error, sequence));
                regenerate.disabled = true;
                try {
                    const data = await helpers.requestJson(API + '/tasks/' + encodeURIComponent(id) + '/regenerate', post({}));
                    if (isProcessCurrent(sequence)) await poll(data.task.id, sequence);
                } catch (error) {
                    if (isProcessCurrent(sequence)) { feedback.textContent = errorText(error); regenerate.disabled = false; }
                }
            }
        });
        for (const file of value.result?.files || []) {
            const download = node('button', 'btn-secondary', file.format === 'pptx' ? '下载演示文件（.pptx）' : '下载完整项目源包'); download.type = 'button';
            download.addEventListener('click', async () => {
                const sequence = epoch;
                try { const data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
                    if (!isProcessCurrent(sequence)) return;
                    const url = '/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token);
                    const link = node('a'); link.href = url; link.download = file.filename; document.body.appendChild(link); link.click(); link.remove();
                } catch (error) { showError(error, sequence); }
            }); actionRow.appendChild(download);
            if (file.format === 'pptx') {
                const edit = node('button', 'btn-secondary', '编辑已生成页面'); edit.type = 'button';
                edit.addEventListener('click', () => openNative({ sourceRenditionId: String(file.renditionId), title: value.request?.title || '完整制作结果' }));
                actionRow.appendChild(edit);
            }
        }
        if (actionRow.children.length) panel.appendChild(actionRow);
        panel.appendChild(feedback);
        if (panel.closest('.workspace-modal-body')) panel.closest('.workspace-modal-body').scrollTop = scroll;
    }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers;
        if (bound) return; bound = true;
        document.addEventListener('click', event => {
            const history = event.target.closest?.('[data-presentation-master-history]');
            if (history) { void openHistory(history); return; }
            if (!event.target.closest?.('[data-presentation-master-open]')) return;
            const opening = open(), sequence = epoch;
            void opening.catch(error => showError(error, sequence));
        });
    }
    window.Pivot.exposeModule('apps.presentations.master', { bind, open });
})();
