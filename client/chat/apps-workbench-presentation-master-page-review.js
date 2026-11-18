(function () {
    'use strict';

    function svgIcon(paths, size = 15) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
        el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('aria-hidden', 'true');
        for (const [tag, attrs] of paths) {
            const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
            el.appendChild(child);
        }
        return el;
    }

    function citationSourceName(path) {
        if (path === 'instruction') return '制作要求';
        const number = /^user-supplement:([1-9]\d*)$/.exec(path)?.[1];
        return number ? '用户补充 ' + number : path;
    }

    function mountResumeNote(container, task, node) {
        if (task.citationReview) {
            const section = node('div', 'presentation-master-review-panel');
            section.appendChild(node('strong', '', '待核对的引文'));
            for (const item of task.citationReview.items) {
                section.appendChild(node('p', 'presentation-master-task-summary',
                    [item.location, item.title, item.text && '「' + item.text + '」'].filter(Boolean).join(' · ')));
            }
            section.appendChild(node('p', 'presentation-master-task-summary', '请补充带数字和单位的原文、说明怎么改，或切换制作模型后继续。'));
            container.appendChild(section);
        }
        const field = node('label', 'modal-form-field');
        const note = node('textarea', 'form-input presentation-master-task-answer');
        note.rows = 2; note.maxLength = 4000;
        note.placeholder = '可粘贴包含数字、单位的原文。填写后需重新确认最终方案。';
        field.append(node('span', 'modal-form-label', '补充说明或修改意见（选填）'), note);
        const revision = node('input'); revision.type = 'checkbox';
        const label = node('label', 'presentation-master-page-review-check hidden');
        label.append(revision, node('span', '', '允许按上述说明调整原清单'));
        note.addEventListener('input', () => { label.classList.toggle('hidden', !note.value.trim()); });
        container.append(field, label);
        return () => note.value.trim() ? { resumeNote: note.value.trim(), revisePlan: revision.checked } : {};
    }

    function mount(container, task, node) {
        if (!task.pageReview?.failedPages?.length) return null;
        const review = node('div', 'presentation-master-review-panel');
        const stageHead = node('div', 'presentation-master-review-stage');
        stageHead.append(svgIcon([['path', { d: 'M9 11l3 3L22 4' }], ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }]], 14), node('span', '', '逐页核验结果'));
        review.appendChild(stageHead);
        const passed = task.pageReview.passedPages.length;
        review.appendChild(node('p', 'presentation-master-task-summary', `已通过 ${passed} 页。`
            + (task.canRepairPages ? '仅重做勾选的页面，保留其余页面。' : '可下载待核验草稿查看。')));

        const pageList = node('div', 'presentation-master-page-review-list');
        const choices = [];
        for (const page of task.pageReview.failedPages) {
            const card = node('div', 'presentation-master-page-review-card');
            const label = node('label', 'presentation-master-page-review-check');
            if (task.canRepairPages) {
                const checkbox = node('input');
                checkbox.type = 'checkbox';
                checkbox.checked = true;
                label.appendChild(checkbox);
                choices.push({ page: page.page, checkbox });
            }
            label.appendChild(node('span', 'presentation-master-page-review-title', `第 ${page.page} 页 · ${page.title}`));
            card.appendChild(label);
            const items = node('div', 'presentation-master-page-review-items');
            if (page.missingTitle) items.appendChild(node('p', 'presentation-master-page-review-detail', '页面标题需与确认清单一致。'));
            for (const item of page.items) {
                const chart = item.chart ? `，图表「${item.chart.series}」的「${item.chart.category}」应为 ${item.chart.number}` : '';
                items.appendChild(node('p', 'presentation-master-page-review-detail', `第 ${item.index} 项应包含「${item.text}」${chart}。`));
                if (item.source?.quote) items.appendChild(node('p', 'presentation-master-plan-source', `${citationSourceName(item.source.path)}原文「${item.source.quote}」`));
            }
            if (items.children.length) card.appendChild(items);
            pageList.appendChild(card);
        }
        review.appendChild(pageList);
        container.appendChild(review);
        if (!task.canRepairPages) return null;

        const field = node('label', 'modal-form-field');
        field.appendChild(node('span', 'modal-form-label', '本次修改意见（选填）'));
        const note = node('textarea', 'form-input presentation-master-task-answer');
        note.maxLength = 1000;
        note.rows = 2;
        field.appendChild(note);
        review.appendChild(field);

        return () => {
            const pages = choices.filter(({ checkbox }) => checkbox.checked).map(({ page }) => page);
            if (!pages.length) throw new Error('请至少选择一页需要修复的页面。');
            return { pages, draftRevision: task.draftRevision, repairNote: note.value };
        };
    }

    function mountHistory(panel, tasks, node, selectTask) {
        panel.replaceChildren();
        if (!tasks.length) {
            const empty = node('div', 'presentation-master-history-empty');
            empty.append(
                svgIcon([['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }]], 18),
                node('p', 'presentation-master-task-message', '当前账号暂无可查看的完整制作记录。')
            );
            panel.appendChild(empty);
            return;
        }
        const head = node('div', 'presentation-master-history-head');
        head.append(node('p', 'presentation-master-history-desc', '已保存页面的任务优先显示。'),
            node('span', 'presentation-master-history-count', `共 ${tasks.length} 条`));
        panel.appendChild(head);
        const list = node('ul', 'presentation-master-history-list');
        const labels = { working: '正在制作', input_required: '等待确认', completed: '已完成', failed: '未完成', cancelled: '已取消', expired: '已过期' };
        for (const task of tasks) {
            const item = node('li', 'presentation-master-history-item');
            const date = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN') : '';
            const statusClass = task.status || 'failed';
            const button = node('button', 'presentation-master-history-row');
            button.type = 'button';
            button.dataset.historyTaskId = task.id;
            button.addEventListener('click', () => selectTask(task.id));
            const main = node('span', 'presentation-master-history-row-main');
            main.append(
                node('span', 'presentation-master-history-row-title', task.title || '未命名演示'),
                node('span', `presentation-master-task-badge ${statusClass}`, labels[task.status] || '制作任务')
            );
            if (task.hasSavedReviewPages) main.appendChild(node('span', 'presentation-master-task-badge completed', '已保存通过页'));
            if (task.hasProgressSnapshot) main.appendChild(node('span', 'presentation-master-task-badge completed', '已保存制作快照'));
            const meta = node('span', 'presentation-master-history-row-meta');
            if (date) meta.appendChild(node('span', 'presentation-master-history-date', date));
            meta.appendChild(svgIcon([['polyline', { points: '9 18 15 12 9 6' }]], 14));
            button.append(main, meta);
            item.appendChild(button);
            list.appendChild(item);
        }
        panel.appendChild(list);
    }

    function openPageImage(image, trigger, node) {
        const dialog = node('dialog', 'workspace-modal presentation-master-page-image-dialog');
        dialog.setAttribute('aria-label', '单页预览 · ' + image.alt);
        const header = node('header', 'workspace-modal-header');
        const close = node('button', 'btn-secondary workspace-modal-close', '关闭预览');
        close.type = 'button';
        close.addEventListener('click', () => dialog.close());
        header.append(node('h3', '', image.alt), close);
        const body = node('div', 'workspace-modal-body');
        body.appendChild(image.cloneNode());
        dialog.append(header, body);
        dialog.addEventListener('keydown', event => event.stopPropagation());
        dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); });
        trigger.after(dialog);
        dialog.showModal();
    }

    function mountPassedPages(row, panel, task, { node, getEpoch, isCurrent, showError, requestJson }) {
        if (!task.canPreviewExport && !task.hasSavedReviewPages) return;
        const base = '/api/apps/presentations/master/tasks/' + encodeURIComponent(task.id) + '/review-pages';
        const savedButton = node('button', 'btn-secondary', '查看已保存页面');
        const liveButton = node('button', 'btn-secondary', '查看已通过页面');
        savedButton.type = liveButton.type = 'button';
        if (task.hasSavedReviewPages) row.appendChild(savedButton);
        if (task.canPreviewExport) row.appendChild(liveButton);
        const preview = node('div', 'presentation-master-review-panel');
        preview.hidden = true;
        panel.appendChild(preview);
        const setBusy = busy => { savedButton.disabled = liveButton.disabled = busy; };
        const load = async isSaved => {
            const sequence = getEpoch();
            setBusy(true);
            preview.hidden = false;
            preview.replaceChildren(node('p', 'presentation-master-task-summary', isSaved ? '正在读取已保存页面…' : '正在按原确认清单核验已导出的页面…'));
            try {
                const { pages, failedPages, exportRevision } = await requestJson(base, { method: isSaved ? 'GET' : 'POST' });
                if (!isCurrent(sequence)) return;
                const title = node('strong', '', isSaved ? '已保存页面' : '已通过页面预览');
                preview.replaceChildren(title);
                if (!pages.length) {
                    preview.appendChild(node('p', 'presentation-master-task-summary', '本次导出暂无通过核验的页面。'));
                    return;
                }
                const note = `通过 ${pages.length} 页。` + (failedPages.length ? `待修复页：${failedPages.map(item => item.page).join('、')}。` : '');
                preview.appendChild(node('p', 'presentation-master-task-summary', note));
                const field = node('label', 'modal-form-field'), select = node('select', 'form-input');
                field.append(node('span', 'modal-form-label', '选择已通过的页面'), select);
                for (const item of pages) select.appendChild(new Option(`第 ${item.page} 页 · ${item.title}`, String(item.page)));
                const image = node('img', 'presentation-master-passed-preview');
                const actions = node('div', 'presentation-master-task-actions');
                const open = node('button', 'btn-secondary', '打开单页预览图');
                open.type = 'button';
                open.addEventListener('click', () => openPageImage(image, open, node));
                actions.appendChild(open);
                const notice = node('p', 'presentation-master-task-summary');
                notice.setAttribute('role', 'status');
                const imageError = node('p', 'presentation-master-task-feedback');
                imageError.setAttribute('role', 'status');
                const update = () => {
                    const item = pages[select.selectedIndex];
                    open.disabled = true;
                    imageError.textContent = '';
                    image.alt = `第 ${item.page} 页 · ${item.title}`;
                    image.src = base + '/' + encodeURIComponent(item.file);
                    if (image.complete && image.naturalWidth) open.disabled = false;
                };
                image.addEventListener('load', () => { open.disabled = false; });
                image.addEventListener('error', () => { imageError.textContent = '预览暂不可用，请重新打开该制作记录后再试。'; });
                select.addEventListener('change', update);
                if (!isSaved && exportRevision) {
                    const save = node('button', 'btn-primary', '保存已通过页面');
                    save.type = 'button';
                    notice.textContent = '将通过页面保存为图片，关闭后可从「完整制作记录」回看。';
                    save.addEventListener('click', async () => {
                        save.disabled = true;
                        setBusy(true);
                        notice.textContent = '正在保存已通过页面…';
                        try {
                            await requestJson(base + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exportRevision }) });
                            if (!isCurrent(sequence)) return;
                            title.textContent = '已保存页面';
                            notice.textContent = '已保存到本条制作记录。关闭后可从「完整制作记录」打开。';
                            liveButton.replaceWith(savedButton);
                            select.focus();
                            save.remove();
                        } catch (error) {
                            if (isCurrent(sequence)) { notice.textContent = showError(error); save.disabled = false; save.focus(); }
                        } finally { if (isCurrent(sequence)) setBusy(false); }
                    });
                    actions.appendChild(save);
                }
                preview.append(field, image, imageError, actions, notice);
                update();
                select.focus();
            } catch (error) {
                if (isCurrent(sequence)) preview.replaceChildren(node('p', 'presentation-master-task-feedback', showError(error)));
            } finally { if (isCurrent(sequence)) setBusy(false); }
        };
        savedButton.addEventListener('click', () => load(true));
        liveButton.addEventListener('click', () => load(false));
    }

    function mountActions(row, panel, task, options) {
        const { node, getEpoch, isCurrent, restart } = options;
        mountPassedPages(row, panel, task, options);
        mountSnapshots(panel, task, options);
        if (task.canRegenerate) {
            const regenerate = node('button', 'btn-secondary', '重新生成整份');
            regenerate.type = 'button';
            regenerate.addEventListener('click', async () => {
                const sequence = getEpoch();
                if (!await window.Pivot.legacy.showConfirm('重新生成整份', '将用原材料和设置创建一个新任务，重新计算模型用量。原任务和草稿会保留。')) return;
                if (isCurrent(sequence)) await restart(task.id, regenerate);
            });
            row.appendChild(regenerate);
        }
        if (task.regeneratedFrom && !['working', 'input_required'].includes(task.status)) {
            const previous = node('button', 'btn-secondary', '查看原任务');
            previous.type = 'button';
            previous.addEventListener('click', () => restart(task.regeneratedFrom));
            row.appendChild(previous);
        }
        if (!task.hasReviewDraft) {
            if (['failed', 'expired'].includes(task.status) && !task.progressSnapshot?.export) {
                panel.appendChild(node('p', 'presentation-master-task-summary', '此记录没有已保留的待核验 PPTX。可按任务状态继续制作，或使用仍可用的材料重新生成。'));
            }
            return;
        }
        panel.appendChild(node('p', 'presentation-master-task-summary', '已保留待核验草稿，可手动编辑副本。手动保存的副本需自行复核。'));
        addFileActions(row, task, 'review-draft', '-待核验草稿.pptx', '下载待核验草稿（.pptx）', '手动编辑草稿副本', options);
    }

    function mountSnapshots(panel, task, options) {
        const { node } = options, saved = task.progressSnapshot;
        if (!saved || task.status === 'working') return;
        const section = node('section', 'presentation-master-review-panel');
        const controls = node('div', 'presentation-master-task-actions');
        section.appendChild(node('strong', '', '自动保存的制作快照'));
        if (saved.source) {
            const count = saved.source.count;
            const summary = node('p', 'presentation-master-task-summary', count ? `已保留 ${count} 个源页文件，源稿待核验。` : '已保留待核验项目源文件。');
            if (saved.source.files?.length) summary.title = saved.source.files.join('、');
            section.appendChild(summary);
            addFileActions(controls, task, 'snapshots/source', '-待核验项目源包.zip', '下载待核验项目源包', '', options);
        }
        if (saved.export) {
            const pending = saved.export.pendingPages;
            if (pending.length) section.appendChild(node('p', 'presentation-master-task-summary', `待核验页：${pending.join('、')}。`));
            addFileActions(controls, task, 'snapshots/export', '-待核验整稿快照.pptx', '下载待核验整稿快照（.pptx）', '', options);
        }
        if (saved.passed) {
            const label = saved.passed.historical ? '上一次可下载的通过页' : '已通过核验的快照页';
            section.appendChild(node('p', 'presentation-master-task-summary', `${label}：${saved.passed.pages.join('、')}。`));
            addFileActions(controls, task, 'snapshots/passed', '-已通过页面（部分文稿）.pptx', '下载已通过页面（.pptx）', '将已通过页转存为独立文稿', options);
        }
        if (saved.subsetUnavailable) section.appendChild(node('p', 'presentation-master-task-summary', '本次导出中的部分资源无法独立提取，可下载整稿快照核对。'));
        section.appendChild(controls);
        panel.appendChild(section);
    }

    function addFileActions(row, task, route, suffix, downloadLabel, importLabel, { node, getEpoch, isCurrent, showError, feedback, requestJson, openNative }) {
        const filename = String(task.request?.title || '演示文稿').replace(/[\r\n\\/]/g, '_').slice(0, 160 - suffix.length) + suffix;
        const draft = node('button', 'btn-secondary', downloadLabel);
        draft.type = 'button';
        const readDraft = async (button, useFile) => {
            const sequence = getEpoch();
            button.disabled = true;
            feedback.textContent = '';
            try {
                const response = await window.Pivot.api.fetch('/api/apps/presentations/master/tasks/' + encodeURIComponent(task.id) + '/' + route);
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error?.message || data.error || '草稿下载失败，请刷新任务状态后重试。');
                }
                const blob = await response.blob();
                if (isCurrent(sequence)) await useFile(blob, sequence);
            } catch (error) {
                if (isCurrent(sequence)) feedback.textContent = showError(error);
            } finally {
                if (isCurrent(sequence)) button.disabled = false;
            }
        };
        draft.addEventListener('click', () => readDraft(draft, blob => {
            const url = URL.createObjectURL(blob), link = node('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }));
        row.appendChild(draft);
        if (!importLabel) return;
        const edit = node('button', 'btn-secondary', importLabel);
        edit.type = 'button';
        edit.addEventListener('click', () => readDraft(edit, async (blob, sequence) => {
            const body = new FormData();
            body.append('file', blob, filename);
            body.append('assetType', 'attachment');
            const { asset } = await requestJson('/api/apps/presentations/assets', { method: 'POST', body });
            if (!asset?.id) throw new Error('草稿副本导入未完成，请重试。');
            if (isCurrent(sequence)) await openNative({ sourceAssetId: String(asset.id), title: filename.slice(0, -5) });
        }));
        row.appendChild(edit);
    }

    let usageDiagnostics = [], usageReturnFocus = null;
    const byId = id => document.getElementById(id);
    function el(tag, className = '', value = '') {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (value) item.textContent = value;
        return item;
    }
    function trapDialogFocus(dialog, event) {
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button,input,select,textarea,summary')].filter(element => !element.disabled && element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    function setProcessModalInert(inactive) {
        const processModal = byId('presentation-master-process-modal');
        if (!processModal) return;
        if (inactive) processModal.setAttribute('aria-hidden', 'true');
        else processModal.removeAttribute('aria-hidden');
        if ('inert' in processModal) processModal.inert = Boolean(inactive);
    }
    function closeUsageModal({ restoreFocus = true } = {}) {
        const usageModal = byId('presentation-master-usage-modal');
        const list = byId('presentation-master-usage-list');
        if (list) list.replaceChildren();
        setProcessModalInert(false);
        if (usageModal && !usageModal.classList.contains('hidden')) usageModal.classList.add('hidden');
        const focus = usageReturnFocus; usageReturnFocus = null;
        if (restoreFocus && focus?.isConnected) focus.focus();
    }
    function removeUsageModal() {
        usageDiagnostics = [];
        closeUsageModal({ restoreFocus: false });
        byId('presentation-master-usage-modal')?.remove();
    }
    function ensureUsageModal() {
        if (byId('presentation-master-usage-modal')) return byId('presentation-master-usage-modal');
        const usageModal = el('div', 'modal-overlay presentation-master-usage-overlay hidden');
        usageModal.id = 'presentation-master-usage-modal';
        const dialog = el('section', 'workspace-modal presentation-master-usage-dialog');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '每轮模型用量明细');

        const header = el('header', 'workspace-modal-header presentation-master-header');
        const headerInfo = el('div', 'presentation-master-header-info');
        const headerTitleRow = el('div', 'presentation-master-header-title-row');
        const headerIcon = el('span', 'presentation-master-header-icon');
        headerIcon.appendChild(svgIcon([['line', { x1: '18', y1: '20', x2: '18', y2: '10' }], ['line', { x1: '12', y1: '20', x2: '12', y2: '4' }], ['line', { x1: '6', y1: '20', x2: '6', y2: '14' }]], 16));
        headerTitleRow.append(headerIcon, el('h3', '', '每轮模型用量明细'));
        headerInfo.append(headerTitleRow, el('p', 'presentation-master-header-subtitle', '按模型调用轮次展示输入、输出、累计令牌与上下文收敛详情'));
        const closeBtn = el('button', 'btn-secondary workspace-modal-close', '关闭'); closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => closeUsageModal());
        header.append(headerInfo, closeBtn);

        const body = el('div', 'workspace-modal-body presentation-master-usage-body');
        const list = el('ol', 'presentation-master-usage-list'); list.id = 'presentation-master-usage-list';
        body.appendChild(list);

        dialog.append(header, body); usageModal.appendChild(dialog); document.body.appendChild(usageModal);
        usageModal.addEventListener('click', event => { if (event.target === usageModal) closeUsageModal(); });
        usageModal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeUsageModal(); return; }
            trapDialogFocus(dialog, event);
        });
        return usageModal;
    }
    function renderUsageList() {
        const list = byId('presentation-master-usage-list');
        if (!list) return;
        list.replaceChildren();
        for (const item of usageDiagnostics) {
            const row = el('li', 'presentation-master-usage-item');
            const top = el('div', 'presentation-master-usage-item-head');
            top.append(
                el('span', 'presentation-master-usage-step', `第 ${item.call || item.step} 次模型调用（步骤 ${item.step}）`),
                el('span', 'presentation-master-usage-metrics', `输入 ${item.inputTokens}${item.inputEstimated ? '（估算）' : ''}，输出 ${item.outputTokens}${item.outputEstimated ? '（估算）' : ''}，累计 ${item.cumulativeTokens}`)
            );
            const parts = item.breakdown ? `（初始指引及任务 ${item.breakdown.initial}，历史消息 ${item.breakdown.history}，工具结果 ${item.breakdown.toolResults || 0}，图片 ${item.breakdown.images}）` : '';
            row.append(top, el('p', 'presentation-master-usage-detail', `预计输入 ${item.inputEstimate}${parts}，收敛前预计 ${item.originalEstimate}，已收敛 ${item.compactedWrites} 条文件写入正文。`));
            list.appendChild(row);
        }
    }
    function openUsageModal(trigger = null) {
        const usageModal = ensureUsageModal();
        if (usageModal.classList.contains('hidden')) usageReturnFocus = trigger || document.activeElement;
        renderUsageList();
        setProcessModalInert(true);
        usageModal.classList.remove('hidden');
        usageModal.querySelector('.workspace-modal-close')?.focus();
    }
    function mountUsageButton(panel, items) {
        usageDiagnostics = Array.isArray(items) ? items : [];
        if (!usageDiagnostics.length) return;
        const usageBar = el('div', 'presentation-master-usage-bar');
        const usageBtn = el('button', 'btn-secondary presentation-master-usage-btn');
        usageBtn.type = 'button'; usageBtn.id = 'presentation-master-usage-btn';
        usageBtn.append(
            svgIcon([['line', { x1: '18', y1: '20', x2: '18', y2: '10' }], ['line', { x1: '12', y1: '20', x2: '12', y2: '4' }], ['line', { x1: '6', y1: '20', x2: '6', y2: '14' }]], 13),
            el('span', '', `查看每轮模型用量（共 ${usageDiagnostics.length} 轮）`)
        );
        usageBtn.addEventListener('click', () => openUsageModal(usageBtn));
        usageBar.appendChild(usageBtn);
        panel.appendChild(usageBar);
        const usageModal = byId('presentation-master-usage-modal');
        if (usageModal && !usageModal.classList.contains('hidden')) renderUsageList();
    }

    window.Pivot.exposeModule('apps.presentations.masterPageReview', {
        mount, mountActions, mountHistory, mountUsageButton, closeUsageModal, removeUsageModal, trapDialogFocus, mountResumeNote, citationSourceName
    });
})();
