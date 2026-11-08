(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const stages = { opening: '开场', context: '背景', problem: '问题', evidence: '证据', proposal: '方案', decision: '决策', action: '行动', closing: '收束', content: '内容' };
    const relations = { none: '一般说明', comparison: '比较', sequence: '顺序', hierarchy: '层级', causal: '因果', composition: '构成', timeline: '时间', decision: '决策' };
    const url = (id, task = '') => '/api/apps/presentations/' + encodeURIComponent(id) + '/storyline-tasks' + (task ? '/' + encodeURIComponent(task) : '');
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const title = slide => slide.elements.find(item => item.id === 'title')?.content?.text || slide.elements.find(item => item.type === 'text' && item.style?.fontSize >= 24)?.content?.text || '未命名页面';
    let state, helpers, task = null, taskDocument = '', restoredEpoch = -1, sequence = 0, loading = false, modelSelect;
    function node(tag, className = '', text = '') { const item = document.createElement(tag); item.className = className; if (text) item.textContent = text; return item; }
    function svgIcon(pathData, width = 13, height = 13, stroke = false) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        if (stroke) {
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2.2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
        } else {
            svg.setAttribute('fill', 'currentColor');
        }
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        svg.appendChild(path);
        return svg;
    }
    function field(label, id, value, options) {
        const wrapper = node('label', 'presentation-master-field'), input = node(options ? 'select' : id.endsWith('duration') ? 'input' : 'textarea', 'form-input');
        input.id = id; input.setAttribute('aria-label', label);
        if (options) Object.entries(options).forEach(([val, lbl]) => input.appendChild(new Option(lbl, val)));
        else if (input.tagName === 'INPUT') { input.type = 'number'; input.min = '0'; input.max = '1800'; }
        else { input.rows = 2; input.maxLength = id.endsWith('purpose') ? 600 : 400; }
        input.value = value !== undefined && value !== null ? value : '';
        wrapper.append(node('span', '', label), input);
        return wrapper;
    }
    function save() {
        const panel = byId('presentation-story-panel'), slide = helpers.activeSlide();
        if (!slide || !helpers.canEdit() || panel?.dataset.storyTarget !== state.active.id + ':' + slide.id) return;
        const profile = window.Pivot.moduleApi('apps.presentations.goals').read('presentation-story', state.active.content.metadata?.productionProfile);
        const seconds = Number(byId('presentation-story-page-duration').value);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1800) throw new Error('本页讲解时长请填写0至1800秒。');
        state.active.content.metadata ||= {}; state.active.content.metadata.productionProfile = profile;
        if (slide.review?.status !== 'approved') slide.intent = { ...slide.intent, purpose: byId('presentation-story-page-purpose').value.trim(), takeaway: byId('presentation-story-takeaway').value.trim(),
            stage: byId('presentation-story-stage').value, relation: byId('presentation-story-relation').value, bridgeToNext: byId('presentation-story-bridge').value.trim(), durationSeconds: seconds };
        helpers.recordHistory();
    }
    function render(currentState, currentHelpers) {
        state = currentState; const slide = currentHelpers.activeSlide(), panel = byId('presentation-story-panel');
        if (!panel || !slide) return;
        const target = state.active.id + ':' + slide.id;
        if (panel.dataset.storyTarget === target && panel.contains(document.activeElement)) { renderStatus(); return; }
        const expanded = panel.querySelector('details')?.open || false;
        const scope = byId('presentation-story-scope')?.value || 'deck', instruction = byId('presentation-story-instruction')?.value || '';
        panel.dataset.storyTarget = target;
        panel.replaceChildren();

        // 1. 头部标题
        const head = node('div', 'presentation-story-head');
        const titleGroup = node('div', 'presentation-panel-title-group');
        titleGroup.append(
            node('strong', '', '逐页叙事结构'),
            node('small', 'presentation-story-sub', '规划页面论证定位与前后呼应')
        );
        head.appendChild(titleGroup);
        panel.appendChild(head);

        // 2. 整稿目标折叠卡片
        const profile = state.active.content.metadata?.productionProfile || {}, goals = node('details', 'presentation-native-section presentation-story-goals');
        goals.open = expanded;
        const audienceLabel = profile.audience || '受众待设置';
        const modeLabel = profile.consumptionMode === 'reading' ? '阅读材料' : '现场演示';
        const summary = node('summary', 'presentation-story-goals-summary');
        summary.append(
            svgIcon('M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm0-14a6 6 0 1 0 6 6 6 6 0 0 0-6-6zm0 10a4 4 0 1 1 4-4 4 4 0 0 1-4 4zm0-6a2 2 0 1 0 2 2 2 2 0 0 0-2-2z', 13, 13),
            node('span', 'presentation-story-goals-title', '整稿目标'),
            node('span', 'presentation-story-goals-tags', audienceLabel + ' · ' + modeLabel)
        );
        goals.appendChild(summary);
        const goalFields = node('div', 'presentation-master-form presentation-story-goals-form');
        goals.appendChild(goalFields);
        panel.appendChild(goals);
        window.Pivot.moduleApi('apps.presentations.goals').mount(goalFields, 'presentation-story');
        window.Pivot.moduleApi('apps.presentations.goals').fill('presentation-story', profile);
        goalFields.querySelectorAll('.form-input').forEach(input => { input.disabled = !currentHelpers.canEdit(); });

        // 3. 上下页承接关系指示条
        const index = state.active.content.slides.findIndex(item => item.id === slide.id), slides = state.active.content.slides;
        const prevTitle = slides[index - 1] ? title(slides[index - 1]) : '开篇';
        const nextTitle = slides[index + 1] ? title(slides[index + 1]) : '收束';
        const flowBar = node('div', 'presentation-story-flow-bar');
        const prevNode = node('div', 'presentation-story-flow-node is-prev');
        prevNode.title = '上一页：' + prevTitle;
        prevNode.append(node('span', 'flow-tag', '上页'), node('span', 'flow-text', prevTitle));
        const arrow1 = node('span', 'presentation-story-flow-arrow', '➔');
        const currNode = node('div', 'presentation-story-flow-node is-current');
        currNode.append(node('span', 'flow-tag', '当前 P' + (index + 1)));
        const arrow2 = node('span', 'presentation-story-flow-arrow', '➔');
        const nextNode = node('div', 'presentation-story-flow-node is-next');
        nextNode.title = '下一页：' + nextTitle;
        nextNode.append(node('span', 'flow-tag', '下页'), node('span', 'flow-text', nextTitle));
        flowBar.append(prevNode, arrow1, currNode, arrow2, nextNode);
        panel.appendChild(flowBar);

        // 4. 卡片一：本页叙事定位与表达
        const card1 = node('div', 'presentation-story-card');
        const card1Head = node('div', 'presentation-story-card-head');
        card1Head.append(
            svgIcon('M4 6h16M4 12h16M4 18h10', 13, 13, true),
            node('strong', '', '本页叙事定位')
        );
        card1.appendChild(card1Head);

        const purposeField = field('本页职责', 'presentation-story-page-purpose', slide.intent?.purpose);
        purposeField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        purposeField.querySelector('.form-input').placeholder = '明确本页在整套文稿中的论证使命（如提出痛点、展示架构）';
        card1.appendChild(purposeField);

        const takeawayField = field('本页核心结论', 'presentation-story-takeaway', slide.intent?.takeaway);
        takeawayField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        takeawayField.querySelector('.form-input').placeholder = '一句话传达给受众的核心信息';
        card1.appendChild(takeawayField);

        const row1 = node('div', 'presentation-story-grid-2');
        const stageField = field('故事线阶段', 'presentation-story-stage', slide.intent?.stage || 'content', stages);
        stageField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        const relationField = field('信息关系', 'presentation-story-relation', slide.intent?.relation || 'none', relations);
        relationField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        row1.append(stageField, relationField);
        card1.appendChild(row1);

        const row2 = node('div', 'presentation-story-grid-2');
        const bridgeField = field('与下页衔接', 'presentation-story-bridge', slide.intent?.bridgeToNext);
        bridgeField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        bridgeField.querySelector('.form-input').placeholder = '承上启下逻辑';
        const durationField = field('本页讲解（秒）', 'presentation-story-page-duration', slide.intent?.durationSeconds);
        durationField.querySelector('.form-input').disabled = !currentHelpers.canEdit() || slide.review?.status === 'approved';
        row2.append(bridgeField, durationField);
        card1.appendChild(row2);

        const saveButton = node('button', 'btn-secondary presentation-story-action-btn', '');
        saveButton.type = 'button';
        saveButton.id = 'presentation-story-save';
        saveButton.disabled = !currentHelpers.canEdit();
        saveButton.append(
            svgIcon('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8', 13, 13, true),
            node('span', '', '保存结构')
        );
        card1.appendChild(saveButton);
        panel.appendChild(card1);

        // 5. 卡片二：AI 故事线调整
        const card2 = node('div', 'presentation-story-card is-ai');
        const card2Head = node('div', 'presentation-story-card-head');
        card2Head.append(
            svgIcon('M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z', 13, 13, true),
            node('strong', '', 'AI 故事线调整')
        );
        card2.appendChild(card2Head);

        const tip = node('div', 'presentation-story-tip', '目标与逐页结构随文稿保存。调整前先生成方案并预览。');
        card2.appendChild(tip);

        const rowAi = node('div', 'presentation-story-grid-2');
        const scopeField = field('调整范围', 'presentation-story-scope', scope, { deck: '整套文稿', page: '当前页面' });
        if (!modelSelect) {
            modelSelect = node('select', 'form-input');
            modelSelect.id = 'presentation-story-model';
            modelSelect.setAttribute('aria-label', '故事线调整模型');
        }
        const modelField = node('label', 'presentation-master-field');
        modelField.append(node('span', '', '调整模型'), modelSelect);
        rowAi.append(scopeField, modelField);
        card2.appendChild(rowAi);
        if (!modelSelect.options.length) void window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', modelSelect.id);

        const instField = field('调整要求（可选）', 'presentation-story-instruction', instruction);
        const instInput = instField.querySelector('.form-input');
        instInput.maxLength = 2000;
        instInput.placeholder = '如：强化方案部分对比，弱化技术细节...';
        card2.appendChild(instField);

        const propose = node('button', 'btn-primary presentation-story-propose-btn', '');
        propose.type = 'button';
        propose.id = 'presentation-story-propose';
        propose.disabled = !currentHelpers.canEdit() || loading;
        propose.append(
            svgIcon('M12 3v18m9-9H3', 13, 13, true),
            node('span', '', '按故事线调整')
        );
        card2.appendChild(propose);

        const status = node('div');
        status.id = 'presentation-story-status';
        status.setAttribute('aria-live', 'polite');
        card2.appendChild(status);
        panel.appendChild(card2);
        renderStatus();

        // 6. 全稿叙事大纲
        const outlineSec = node('div', 'presentation-story-outline-section');
        outlineSec.appendChild(node('div', 'presentation-story-section-title', '全稿叙事脉络（共 ' + slides.length + ' 页）'));
        const list = node('ol', 'presentation-story-list');
        for (let i = 0; i < slides.length; i++) {
            const item = slides[i];
            const row = node('li', 'presentation-story-item');
            const button = node('button', 'btn-secondary presentation-story-item-btn' + (item.id === slide.id ? ' is-active' : ''));
            button.type = 'button';
            button.dataset.presentationSlideId = item.id;

            const numBadge = node('span', 'presentation-story-page-num', 'P' + (i + 1));
            const mainWrap = node('div', 'presentation-story-item-main');
            const titleElem = node('strong', 'presentation-story-item-title', title(item));
            const metaElem = node('div', 'presentation-story-item-meta');

            const stageKey = item.intent?.stage || 'content';
            const stageBadge = node('span', 'presentation-story-stage-badge is-' + stageKey, stages[stageKey] || '内容');
            const takeawaySpan = node('span', 'presentation-story-item-takeaway', item.intent?.takeaway || '尚未填写核心结论');

            metaElem.append(stageBadge, takeawaySpan);
            mainWrap.append(titleElem, metaElem);
            button.append(numBadge, mainWrap);
            row.appendChild(button);
            list.appendChild(row);
        }
        outlineSec.appendChild(list);
        panel.appendChild(outlineSec);

        if (helpers && (taskDocument !== state.active.id || restoredEpoch !== state.activeEpoch)) void restore();
    }
    function renderStatus() {
        const panel = byId('presentation-story-status'); if (!panel) return;
        panel.replaceChildren(); if (!task || taskDocument !== state.active?.id) return;
        const pending = ['working', 'input_required'].includes(task.status);
        const message = task.status === 'completed' ? '方案已保存为新版本。' : task.status === 'cancelled' ? '方案已放弃。' : ['failed', 'expired'].includes(task.status) ? task.error?.message || '方案生成失败，请重试。'
            : task.stale ? '文稿已变化，请放弃旧方案后重新生成。' : task.status === 'input_required' ? '方案已生成，预览并确认后才会修改页面。'
            : task.status === 'working' ? task.canResumeApply ? '上次保存未完成，请重新预览并确认，或放弃方案。' : task.phase === 'applying' ? '正在保存确认的方案…' : '正在生成故事线方案…'
                : task.error?.message || '方案生成失败，请重试。';
        panel.appendChild(node('p', 'presentation-empty-note', message));
        if (task.status === 'input_required' || task.canResumeApply) { const view = node('button', 'btn-secondary', '预览调整方案'); view.type = 'button'; view.addEventListener('click', preview); panel.appendChild(view); }
        if (pending && (task.phase !== 'applying' || task.canResumeApply)) { const cancel = node('button', 'btn-secondary', task.status === 'working' && !task.canResumeApply ? '停止生成' : '放弃方案'); cancel.type = 'button'; cancel.addEventListener('click', () => discard().catch(showError)); panel.appendChild(cancel); }
    }
    async function follow(initial, id, token) {
        task = initial; taskDocument = id;
        const owner = window.Pivot?.legacy?.currentUser?.id;
        while (state.active?.id === id && token === sequence && owner === window.Pivot?.legacy?.currentUser?.id) {
            renderStatus(); if (task?.status !== 'working' || task.canResumeApply) return;
            await new Promise(resolve => setTimeout(resolve, 1200));
            const data = await helpers.requestJson(url(id, task.id)); if (token !== sequence || state.active?.id !== id) return; task = data.task;
        }
    }
    async function restore() {
        const id = state.active?.id; if (!id) return; const token = ++sequence; taskDocument = id; restoredEpoch = state.activeEpoch; task = null;
        try { const data = await helpers.requestJson(url(id, 'latest')); if (token === sequence && state.active?.id === id) await follow(data.task, id, token); }
        catch (error) { if (token === sequence) showError(error); }
    }
    async function propose() {
        if (loading || !helpers.canEdit()) return;
        save(); const scope = byId('presentation-story-scope').value, instruction = byId('presentation-story-instruction').value;
        const id = state.active.id, slideId = helpers.activeSlide().id;
        loading = true; byId('presentation-story-propose').disabled = true;
        try {
            await window.Pivot?.legacy?.PivotAppModels?.refresh?.('presentations', 'presentation-story-model');
            const modelId = byId('presentation-story-model')?.value; if (!modelId) throw new Error('请先在模型设置中授权可用的演示模型。');
            if (!await helpers.flush() || state.active?.id !== id) return;
            const data = await helpers.requestJson(url(id), post({ modelId, scope, slideId, instruction }));
            if (state.active?.id === id) { const token = ++sequence; void follow(data.task, id, token).catch(showError); }
        } finally { loading = false; byId('presentation-story-propose')?.toggleAttribute('disabled', !helpers.canEdit()); }
    }
    async function discard() {
        const id = taskDocument, taskId = task?.id; if (!taskId || state.active?.id !== id) return;
        const data = await helpers.requestJson(url(id, taskId) + '/cancel', post());
        if (state.active?.id !== id || taskDocument !== id) return;
        ++sequence; task = data.task; renderStatus(); byId('presentation-story-preview')?.classList.add('hidden');
    }
    function intentText(intent) { return intent ? ['职责：' + intent.purpose, '结论：' + intent.takeaway, '阶段：' + stages[intent.stage], '关系：' + relations[intent.relation], '衔接：' + (intent.bridgeToNext || ''), '讲解：' + intent.durationSeconds + '秒'].join('\n') : '尚未设置'; }
    function preview() {
        if (!task?.preview || taskDocument !== state.active?.id) return;
        let modal = byId('presentation-story-preview'); if (modal) modal.remove();
        modal = node('div', 'modal-overlay'); modal.id = 'presentation-story-preview';
        const dialog = node('section', 'workspace-modal presentation-master-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '故事线调整预览');
        const header = node('header', 'workspace-modal-header'); header.appendChild(node('h3', '', '故事线调整预览'));
        const close = node('button', 'btn-secondary', '关闭'); close.type = 'button'; close.addEventListener('click', () => modal.classList.add('hidden')); header.appendChild(close);
        const body = node('div', 'workspace-modal-body'); body.appendChild(node('p', '', task.preview.summary));
        const warning = node('p', 'presentation-empty-note', task.stale || state.dirty ? '文稿已有变化，请保存并重新生成方案。' : '确认后将保存为新版本，可从版本历史恢复；请核对文字含义与事实。'); body.appendChild(warning);
        const order = node('ol', 'presentation-story-list');
        task.preview.order.forEach(item => order.appendChild(node('li', '', '第' + item.before + '页 → 第' + item.after + '页 · ' + item.title))); body.appendChild(order);
        for (const change of task.preview.changes) {
            body.append(node('h4', '', change.title), node('p', '', change.reason));
            const container = node('div', 'table-container'), table = node('table', 'data-table compact-table'), head = node('thead'), row = node('tr');
            ['调整项', '原内容', '建议内容'].forEach(value => row.appendChild(node('th', '', value))); head.appendChild(row); table.appendChild(head);
            const rows = node('tbody');
            for (const [label, before, after] of [['逐页结构', intentText(change.intentBefore), intentText(change.intentAfter)], ...change.textEdits.map((edit, index) => ['页面文字' + (index + 1), edit.before, edit.after])]) {
                const tr = node('tr'); [label, before, after].forEach(text => tr.appendChild(node('td', 'presentation-story-preview-text', text))); rows.appendChild(tr);
            }
            table.appendChild(rows); container.appendChild(table); body.appendChild(container);
        }
        const apply = node('button', 'btn-primary', '确认应用并保存新版本'); apply.type = 'button'; apply.id = 'presentation-story-apply'; apply.disabled = task.stale || state.dirty || !helpers.canEdit();
        const captured = task, id = taskDocument;
        apply.addEventListener('click', async () => {
            apply.disabled = true;
            try {
                if (state.dirty || state.active?.id !== id || task?.id !== captured.id) throw new Error('文稿已有变化，请保存并重新生成方案。');
                const revision = state.editRevision;
                await helpers.requestJson(url(id, captured.id) + '/apply', post({ confirm: true, planDigest: captured.planDigest }));
                modal.classList.add('hidden');
                if (state.active?.id !== id || taskDocument !== id) return;
                ++sequence; task = { ...captured, status: 'completed', phase: 'applied' };
                if (state.active?.id === id && !state.dirty && state.editRevision === revision) await helpers.openPresentation(id);
                else helpers.toast('方案已保存为新版本，请同步后核对当前本地修改。', 'warning');
                renderStatus();
            } catch (error) { warning.textContent = error.message; showError(error); apply.disabled = false; }
        });
        body.appendChild(apply); dialog.append(header, body); modal.appendChild(dialog); document.body.appendChild(modal); close.focus();
    }
    function showError(error) { helpers.toast(error.message || '故事线方案请求失败，请重试。', 'error'); }
    function bind(currentState, currentHelpers) {
        state = currentState; helpers = currentHelpers; const view = byId('presentations-view'); if (!view || view.dataset.storyBound) return; view.dataset.storyBound = '1';
        view.addEventListener('click', event => { if (event.target.closest('#presentation-story-propose')) void propose().catch(showError); if (event.target.closest('#presentation-story-save')) { try { save(); helpers.toast('已保存逐页结构。'); } catch (error) { showError(error); } } });
        view.addEventListener('change', event => { if (event.target.closest('#presentation-story-panel') && !['presentation-story-scope', 'presentation-story-instruction', 'presentation-story-model'].includes(event.target.id)) { try { save(); } catch (error) { showError(error); } } });
    }
    window.Pivot.exposeModule('apps.presentations.storyline', { render, bind, save });
})();
