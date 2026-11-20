(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.design')?.ready) return;
    function reviewMessage(state) {
        const review = state.active?.validation?.visualReview;
        if (!review || review.status === 'not_requested') return '尚未进行视觉模型复核。';
        if (review.localRevision !== state.editRevision || review.localVersion !== state.active.version) return '文稿已变化，之前的视觉复核结果仅供参考，请重新复核。';
        return review.message;
    }
    function generationMessage(proposal = {}) {
        const pages = proposal.generatedPages || proposal.presentation?.slides?.length || 0;
        const split = proposal.plannedPages && pages > proposal.plannedPages ? `（大纲 ${proposal.plannedPages} 页，已完整保留内容拆页）` : '';
        const warnings = Array.isArray(proposal.warnings) ? proposal.warnings.filter(Boolean).length : 0;
        return `AI 初稿已生成，共 ${pages} 页${split}。${warnings ? `另有 ${warnings} 项提示，请在画布中核对。` : '可继续在画布中编辑。'}`;
    }
    function renderDesignIssues(state) {
        const list = document.getElementById('presentation-issues-list'); if (!list) return;
        list.replaceChildren(); const issues = state.active?.validation?.issues || [];
        const note = document.createElement('div'); note.className = 'presentation-empty-note'; note.textContent = reviewMessage(state); list.appendChild(note);
        const production = state.active?.validation?.productionReview;
        if (production) {
            const summary = document.createElement('div'); summary.className = 'presentation-evidence-card';
            const current = production.localRevision === state.editRevision && production.localVersion === state.active.version;
            summary.textContent = current ? `交付检查：${production.summary.blocking}项阻断、${production.summary.warnings}项建议；原生文件${production.checks.native.status === 'passed' ? '核验通过' : '尚未通过'}。${production.scope}` : '文稿已变化，交付检查报告仅对应旧版本，请重新检查。';
            list.appendChild(summary);
        }
        if (!issues.length) { const empty = document.createElement('div'); empty.className = 'presentation-empty-note'; empty.textContent = '暂无问题。导出前仍可再次执行质量检查。'; list.appendChild(empty); return; }
        for (const issue of issues) {
            const item = document.createElement('button'); item.type = 'button'; item.className = `presentation-issue is-${issue.level || 'info'}`;
            item.dataset.presentationIssueSlide = issue.slideId || ''; item.dataset.presentationIssueElement = issue.elementId || '';
            const title = document.createElement('strong'); title.textContent = issue.message;
            const tip = document.createElement('span'); tip.textContent = issue.suggestion || '';
            item.append(title, tip); list.appendChild(item);
        }
    }
    async function runVisualReview(state, helpers) {
        const { requirePresentationAiModel, beginAiRequest, endAiRequest, saveActive, activeContent, requestJson, aiJsonOptions, switchPanel, renderIssues, toast, isAiAbort } = helpers;
        if (!state.active?.id) return;
        const model = requirePresentationAiModel(); if (!model) return;
        const controller = beginAiRequest(), button = document.getElementById('presentation-visual-review-btn');
        button?.setAttribute('disabled', 'disabled');
        try {
            if (state.dirty) await saveActive();
            const activeId = state.active.id, revision = state.editRevision;
            const slideIndex = activeContent().slides.findIndex(slide => slide.id === state.selectedSlideId);
            const data = await requestJson(`/api/apps/presentations/${encodeURIComponent(activeId)}/visual-review`, aiJsonOptions({ model, slideIndex }, controller));
            if (state.active?.id !== activeId || state.editRevision !== revision) { toast('文稿已变化，请重新复核当前内容。', 'warning'); return; }
            const previous = state.active.validation || { issues: [] };
            state.active.validation = { ...previous, visualReview: { ...data.review, localRevision: state.editRevision, localVersion: state.active.version }, issues: [...(previous.issues || []).filter(issue => !(String(issue.code).startsWith('VISUAL_') && issue.slideId === data.review.slideId)), ...(data.review.issues || [])] };
            const toastType = data.review.status === 'passed' ? 'success' : 'warning';
            switchPanel('issues'); renderIssues(); toast(data.review.message, toastType);
        } catch (error) { if (!isAiAbort(error, controller)) throw error; }
        finally { endAiRequest(controller); button?.removeAttribute('disabled'); }
    }
    const running = task => ['working', 'input_required'].includes(task?.status);
    const taskUrl = (id, taskId = '') => `/api/apps/presentations/${encodeURIComponent(id)}/design-tasks${taskId ? '/' + encodeURIComponent(taskId) : ''}`;
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const STATUS_LABELS = { passed: '已通过', warning: '有建议', blocked: '未通过', not_checked: '未检查', stale: '已过期', incomplete: '未完成' };
    const STATUS_TONES = { passed: 'passed', warning: 'warning', blocked: 'blocked', not_checked: 'muted', stale: 'warning', incomplete: 'warning' };
    function el(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }
    function slideLabel(state, slideId) {
        if (!slideId) return '整稿';
        const slides = state.active?.content?.slides || [];
        const index = slides.findIndex(slide => slide.id === slideId);
        return index >= 0 ? `第 ${index + 1} 页` : '指定页面';
    }
    function formatReportTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
    function deckTaskBadge(task) {
        if (task.stale) return { text: '已过期', tone: 'warning' };
        if (running(task)) return { text: '检查中', tone: 'working' };
        if (task.status === 'cancelled') return { text: '已取消', tone: 'muted' };
        if (task.status === 'failed' || task.error) return { text: '未完成', tone: 'blocked' };
        const production = task.result?.productionReview;
        if (production?.summary) {
            if (production.summary.blocking > 0) return { text: `${production.summary.blocking} 项阻断`, tone: 'blocked' };
            if (production.summary.warnings > 0) return { text: `${production.summary.warnings} 项建议`, tone: 'warning' };
            return { text: '核验通过', tone: 'passed' };
        }
        if (task.result?.proposal) return { text: '有优化建议', tone: 'working' };
        const visualStatus = task.result?.visualStatus;
        if (visualStatus) return { text: STATUS_LABELS[visualStatus] || '已完成', tone: STATUS_TONES[visualStatus] || 'muted' };
        return { text: '已完成', tone: 'passed' };
    }
    function openDeckReportModal(task, state, helpers) {
        if (!document.body) { helpers.switchPanel?.('issues'); return; }
        document.getElementById('presentation-deck-report-modal')?.remove();
        const production = task.result?.productionReview || null;
        const reviews = Array.isArray(task.result?.reviews) ? task.result.reviews : [];
        const allIssues = production?.issues || reviews.flatMap(review => review.issues || []) || state.active?.validation?.issues || [];
        const blockingCount = production?.summary?.blocking ?? allIssues.filter(item => item.level === 'blocking').length;
        const warningCount = production?.summary?.warnings ?? allIssues.filter(item => item.level === 'warning').length;
        const slideCount = production?.summary?.slides ?? (reviews.length || state.active?.content?.slides?.length || 0);

        const overlay = el('div', 'modal-overlay presentation-deck-report-overlay');
        overlay.id = 'presentation-deck-report-modal';
        const dialog = el('section', 'workspace-modal presentation-deck-report-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', '整稿检查结果');

        const close = () => {
            document.removeEventListener('keydown', onKeydown);
            overlay.remove();
        };
        const onKeydown = event => { if (event.key === 'Escape') close(); };
        document.addEventListener('keydown', onKeydown);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });

        const head = el('div', 'presentation-create-dialog-head presentation-deck-report-head');
        const titleRow = el('div', 'presentation-create-dialog-title-row');
        const titleGroup = el('div', 'presentation-create-dialog-title-group');
        const checkedTime = formatReportTime(production?.checkedAt || task.completedAt || task.updatedAt);
        titleGroup.append(
            el('h3', '', production ? '整稿交付检查报告' : '整稿视觉复核报告'),
            el('p', '', checkedTime ? `检查时间：${checkedTime}${production?.scope ? ` · ${production.scope}` : ''}` : (production?.scope || task.result?.message || '查看本次整稿检查的各维度状态与问题明细。'))
        );
        const closeTopBtn = el('button', 'btn-secondary workspace-modal-close', '关闭');
        closeTopBtn.type = 'button';
        closeTopBtn.addEventListener('click', close);
        titleRow.append(titleGroup, closeTopBtn);
        head.appendChild(titleRow);

        const body = el('div', 'workspace-modal-body presentation-deck-report-body');

        // 概览指标
        const stats = el('div', 'presentation-deck-report-stats');
        const conclusion = blockingCount > 0 ? { text: '存在阻断', tone: 'blocked' } : warningCount > 0 ? { text: '存在建议', tone: 'warning' } : { text: '核验通过', tone: 'passed' };
        for (const [label, value, tone] of [
            ['检查页数', `${slideCount} 页`, 'muted'],
            ['阻断项', `${blockingCount} 项`, blockingCount > 0 ? 'blocked' : 'passed'],
            ['优化建议', `${warningCount} 项`, warningCount > 0 ? 'warning' : 'passed'],
            ['整体结论', conclusion.text, conclusion.tone]
        ]) {
            const card = el('div', `presentation-deck-report-stat is-${tone}`);
            card.append(el('span', 'presentation-deck-report-stat-label', label), el('strong', 'presentation-deck-report-stat-val', value));
            stats.appendChild(card);
        }
        body.appendChild(stats);

        // 交付检查维度明细
        if (production?.checks) {
            const section = el('section', 'presentation-deck-report-section');
            section.appendChild(el('h4', 'presentation-deck-report-section-title', '核验范围与维度状态'));
            const grid = el('div', 'presentation-deck-report-checks');
            const checks = production.checks;
            const missingAssets = (checks.assets || []).filter(item => item.status !== 'available').length;
            const rows = [
                {
                    name: '结构与字体测量',
                    status: checks.layout?.status || 'passed',
                    detail: checks.layout?.textMeasurement === 'measured' ? '已完成真实字体与版面容量测量' : '已完成基础版面与结构检查'
                },
                {
                    name: '原生 PPTX 回读核验',
                    status: checks.native?.status || 'not_checked',
                    detail: checks.native?.message || (checks.native?.status === 'passed' ? '导出 PPTX 内部对象与结构核验通过' : '原生导出文件存在阻断项，请核对下方明细')
                },
                {
                    name: '视觉模型复核',
                    status: checks.visual?.status || 'not_checked',
                    detail: checks.visual?.status === 'not_checked'
                        ? '尚未执行整稿视觉模型复核'
                        : checks.visual?.status === 'stale'
                            ? '文稿已修改，之前的视觉复核已过期'
                            : `已复核 ${checks.visual?.checkedSlides || 0} / ${slideCount} 页`
                },
                {
                    name: '独立 Office 渲染',
                    status: checks.office?.status || 'not_checked',
                    detail: checks.office?.message || '尚未针对最终文件执行独立 Office 渲染核验'
                },
                {
                    name: '素材与字体可用性',
                    status: missingAssets > 0 ? 'blocked' : 'passed',
                    detail: (checks.assets || []).length
                        ? (missingAssets > 0 ? `共 ${checks.assets.length} 项引用，其中 ${missingAssets} 项缺失` : `共 ${checks.assets.length} 项引用均可用`)
                        : '当前文稿无外部素材引用'
                },
                {
                    name: '字号可读性标准',
                    status: allIssues.some(item => item.code === 'PRODUCTION_READABILITY') ? 'warning' : 'passed',
                    detail: `目标最小正文字号：${production.summary?.minimumBodyFontPt || 18}pt`
                }
            ];
            for (const row of rows) {
                const item = el('div', 'presentation-deck-report-check-item');
                const top = el('div', 'presentation-deck-report-check-top');
                top.append(
                    el('strong', '', row.name),
                    el('span', `presentation-deck-task-badge is-${STATUS_TONES[row.status] || 'muted'}`, STATUS_LABELS[row.status] || row.status)
                );
                item.append(top, el('p', '', row.detail));
                grid.appendChild(item);
            }
            section.appendChild(grid);
            body.appendChild(section);
        }

        // 逐页视觉复核记录
        if (reviews.length) {
            const section = el('section', 'presentation-deck-report-section');
            section.appendChild(el('h4', 'presentation-deck-report-section-title', `逐页视觉复核记录（共 ${reviews.length} 页）`));
            const list = el('div', 'presentation-deck-report-reviews');
            for (const review of reviews) {
                const row = el('div', 'presentation-deck-report-check-item');
                const top = el('div', 'presentation-deck-report-check-top');
                top.append(
                    el('strong', '', slideLabel(state, review.slideId)),
                    el('span', `presentation-deck-task-badge is-${STATUS_TONES[review.status] || 'muted'}`, STATUS_LABELS[review.status] || review.status || '已完成')
                );
                row.append(top, el('p', '', review.message || '该页复核已完成。'));
                list.appendChild(row);
            }
            section.appendChild(list);
            body.appendChild(section);
        }

        // 问题明细（支持筛选与定位）
        const issueSection = el('section', 'presentation-deck-report-section');
        const issueHead = el('div', 'presentation-deck-report-issues-head');
        issueHead.appendChild(el('h4', 'presentation-deck-report-section-title', `问题明细（共 ${allIssues.length} 项）`));
        const filters = el('div', 'presentation-deck-report-filters');
        const issueList = el('div', 'presentation-deck-report-issues-list');
        let activeFilter = 'all';
        const renderFilteredIssues = () => {
            issueList.replaceChildren();
            const filtered = activeFilter === 'all' ? allIssues : allIssues.filter(item => item.level === activeFilter);
            if (!filtered.length) {
                issueList.appendChild(el('p', 'presentation-deck-report-empty', '当前筛选条件下暂无问题项。'));
                return;
            }
            for (const issue of filtered) {
                const level = issue.level || 'info';
                const row = el('div', `presentation-deck-report-issue is-${level}`);
                const meta = el('div', 'presentation-deck-report-issue-meta');
                meta.append(
                    el('span', `presentation-deck-task-badge is-${level === 'blocking' ? 'blocked' : level === 'warning' ? 'warning' : 'muted'}`, level === 'blocking' ? '阻断' : level === 'warning' ? '建议' : '提示'),
                    el('span', 'presentation-deck-report-slide-tag', slideLabel(state, issue.slideId))
                );
                if (issue.slideId) {
                    const locateBtn = el('button', 'presentation-deck-report-locate-btn', '定位该页');
                    locateBtn.type = 'button';
                    locateBtn.addEventListener('click', () => {
                        state.selectedSlideId = issue.slideId;
                        const elementId = String(issue.elementId || '').split(',')[0];
                        if (elementId) state.selectedElementId = elementId;
                        helpers.renderEditor?.();
                        helpers.switchPanel?.('issues');
                        close();
                    });
                    meta.appendChild(locateBtn);
                }
                const title = el('strong', 'presentation-deck-report-issue-title', issue.message || '');
                row.append(meta, title);
                if (issue.suggestion) row.appendChild(el('p', 'presentation-deck-report-issue-tip', issue.suggestion));
                issueList.appendChild(row);
            }
        };
        for (const [key, label] of [
            ['all', `全部 (${allIssues.length})`],
            ['blocking', `阻断 (${blockingCount})`],
            ['warning', `建议 (${warningCount})`]
        ]) {
            const btn = el('button', 'presentation-deck-report-filter-btn' + (key === activeFilter ? ' is-active' : ''), label);
            btn.type = 'button';
            btn.addEventListener('click', () => {
                activeFilter = key;
                filters.querySelectorAll('.presentation-deck-report-filter-btn').forEach(item => item.classList.toggle('is-active', item === btn));
                renderFilteredIssues();
            });
            filters.appendChild(btn);
        }
        issueHead.appendChild(filters);
        issueSection.append(issueHead, issueList);
        renderFilteredIssues();
        body.appendChild(issueSection);

        const footer = el('div', 'presentation-deck-report-footer');
        const jumpListBtn = el('button', 'btn-secondary', '定位到检查列表');
        jumpListBtn.type = 'button';
        jumpListBtn.addEventListener('click', () => {
            close();
            helpers.switchPanel?.('issues');
            document.getElementById('presentation-issues-list')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        });
        footer.appendChild(jumpListBtn);

        dialog.append(head, body, footer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    function showDeckTask(task, state, helpers, id) {
        const isProduction = (task.mode || task.result?.mode) === 'production';
        const panel = document.getElementById(isProduction ? 'presentation-production-task-status' : 'presentation-design-task-status'); if (!panel) return;
        panel.replaceChildren();
        const badgeInfo = deckTaskBadge(task);
        const card = el('div', `presentation-deck-task-card is-${badgeInfo.tone}`);
        const head = el('div', 'presentation-deck-task-head');
        head.append(
            el('strong', 'presentation-deck-task-title', isProduction ? '交付检查摘要' : '整稿检查摘要'),
            el('span', `presentation-deck-task-badge is-${badgeInfo.tone}`, badgeInfo.text)
        );
        card.appendChild(head);

        const progress = task.progress || {};
        const messageText = task.stale ? '文稿已变化，此检查仅对应旧版本，请重新检查。' : running(task)
            ? `${progress.phase === 'layout' ? '正在分析排版' : '正在检查整稿'}：${progress.completed || 0} / ${progress.total || 0} 页`
            : task.status === 'cancelled' ? '检查已取消，已完成的检查记录保留。' : task.error?.message || task.result?.message || '检查已结束。';
        const text = el('p', 'presentation-deck-task-msg', messageText);
        card.appendChild(text);

        const summary = !task.stale && !running(task) ? task.result?.productionReview?.summary : null;
        if (summary) {
            const metrics = el('div', 'presentation-deck-task-metrics');
            metrics.append(
                el('span', 'presentation-deck-task-metric', `共 ${summary.slides} 页`),
                el('span', `presentation-deck-task-metric${summary.blocking > 0 ? ' is-blocked' : ''}`, `阻断 ${summary.blocking}`),
                el('span', `presentation-deck-task-metric${summary.warnings > 0 ? ' is-warning' : ''}`, `建议 ${summary.warnings}`)
            );
            card.appendChild(metrics);
        }

        const actions = el('div', 'presentation-deck-task-actions');
        if (running(task)) {
            const stop = el('button', 'btn-secondary presentation-deck-task-btn', '停止整稿检查'); stop.type = 'button';
            stop.addEventListener('click', async () => {
                stop.disabled = true;
                try { const data = await helpers.requestJson(taskUrl(id, task.id) + '/cancel', post()); showDeckTask(data.task, state, helpers, id); }
                catch (error) { helpers.toast(error.message, 'error'); stop.disabled = false; }
            });
            actions.appendChild(stop);
        } else if (task.status === 'completed' && !task.stale && task.result?.proposal) {
            const apply = el('button', 'btn-primary presentation-deck-task-btn', '应用排版优化建议'); apply.type = 'button';
            apply.addEventListener('click', async () => {
                apply.disabled = true;
                try {
                    if (state.active?.id !== id || state.dirty) throw new Error('文稿已有新修改，请保存后重新检查。');
                    const checked = await helpers.requestJson(taskUrl(id, task.id));
                    const latest = await helpers.requestJson(`/api/apps/presentations/${encodeURIComponent(id)}`);
                    if (checked.task?.stale || state.active?.id !== id || state.dirty || Number(state.active.version) !== Number(latest.presentation.version)
                        || JSON.stringify(state.active.content) !== JSON.stringify(latest.presentation.content)) throw new Error('文稿已变化，请重新检查最新内容后再应用。');
                    state.active.content = checked.task.result.proposal.content;
                    state.active.validation = checked.task.result.validation || { issues: [] };
                    helpers.recordHistory(); helpers.renderEditor();
                    panel.replaceChildren();
                    const doneCard = el('div', 'presentation-deck-task-card is-passed');
                    doneCard.appendChild(el('p', 'presentation-deck-task-msg', '已应用优化建议，可撤销；请检查并导出最新文稿。'));
                    panel.appendChild(doneCard);
                } catch (error) { helpers.toast(error.message, 'error'); apply.disabled = false; }
            });
            actions.appendChild(apply);
        }
        if (task.status === 'completed' && !task.stale && !task.result?.proposal && (task.result?.reviews?.length || task.result?.productionReview)) {
            const view = el('button', 'btn-secondary presentation-deck-task-btn', '查看整稿检查结果'); view.type = 'button';
            view.addEventListener('click', () => openDeckReportModal(task, state, helpers));
            actions.appendChild(view);
        }
        if (actions.childNodes.length) card.appendChild(actions);
        panel.appendChild(card);
    }

    async function followDeckTask(task, state, helpers, id, revision, sequence) {
        const owner = window.Pivot?.legacy?.currentUser?.id;
        while (state.active?.id === id && state.designTaskSequence === sequence && owner === window.Pivot?.legacy?.currentUser?.id) {
            showDeckTask(task, state, helpers, id);
            if (!running(task)) {
                if (!task.stale && !state.dirty && state.editRevision === revision && task.status === 'completed') {
                    const previous = state.active.validation || { issues: [] };
                    if (task.result?.productionReview) {
                        state.active.validation = { ...previous, ...task.result.validation, visualReview: previous.visualReview,
                            productionReview: { ...task.result.productionReview, localRevision: state.editRevision, localVersion: state.active.version } };
                        helpers.renderIssues(); return;
                    }
                    const issues = (task.result?.reviews || []).flatMap(review => review.issues || []);
                    const proposal = Boolean(task.result?.proposal);
                    state.active.validation = { ...previous, visualReview: { status: proposal ? 'proposal' : task.result?.visualStatus,
                        message: proposal ? '本次复核针对排版建议，确认应用前不代表当前文稿已通过。' : task.result?.message,
                        localRevision: state.editRevision, localVersion: state.active.version },
                    issues: proposal ? previous.issues : [...(previous.issues || []).filter(issue => !String(issue.code).startsWith('VISUAL_')), ...issues] };
                    helpers.renderIssues();
                }
                return;
            }
            await new Promise(resolve => window.setTimeout(resolve, 1000));
            const data = await helpers.requestJson(taskUrl(id, task.id));
            if (!data.task) return;
            task = data.task;
        }
    }

    async function startDeckTask(state, helpers, mode) {
        if (!state.active?.id) return;
        const needsModel = ['visual', 'visual_repair'].includes(mode);
        const model = needsModel ? helpers.requirePresentationAiModel() : ''; if (needsModel && !model) return;
        const buttons = ['presentation-deck-review-btn', 'presentation-deck-layout-btn', 'presentation-production-review-btn'].map(id => document.getElementById(id));
        buttons.forEach(button => { if (button) button.disabled = true; });
        try {
            if (state.dirty) await helpers.saveActive();
            if (state.dirty) throw new Error('文稿尚未保存，请先保存后再检查。');
            const id = state.active.id, revision = state.editRevision, sequence = state.designTaskSequence = (state.designTaskSequence || 0) + 1;
            const data = await helpers.requestJson(taskUrl(id), post({ mode, model }));
            await followDeckTask(data.task, state, helpers, id, revision, sequence);
        } catch (error) { helpers.toast(error.message, 'error'); }
        finally { buttons.forEach(button => { if (button) button.disabled = false; }); }
    }

    async function restoreDeckTask(state, helpers) {
        const id = state.active?.id; if (!id) return;
        const revision = state.editRevision, sequence = state.designTaskSequence = (state.designTaskSequence || 0) + 1;
        document.getElementById('presentation-design-task-status')?.replaceChildren();
        document.getElementById('presentation-production-task-status')?.replaceChildren();
        try {
            const data = await helpers.requestJson(taskUrl(id, 'latest'));
            if (data.task && state.active?.id === id) await followDeckTask(data.task, state, helpers, id, revision, sequence);
        } catch (_) { /* 检查记录不可用不阻断文稿编辑。 */ }
    }

    window.Pivot?.exposeModule?.('apps.presentations.design', { ready: true, runVisualReview, reviewMessage, generationMessage, renderDesignIssues, startDeckTask, restoreDeckTask });
})();
