(function () {
    'use strict';

    function mount(container, task, node) {
        if (!task.pageReview?.failedPages?.length) return null;
        const review = node('div', 'presentation-master-review-panel');
        review.appendChild(node('strong', 'presentation-master-resume-title', '逐页核验结果'));
        const passed = task.pageReview.passedPages.length;
        review.appendChild(node('p', 'presentation-master-task-summary', `已通过 ${passed} 页。`
            + (task.canRepairPages ? '仅重做勾选的页面，保留其余页面。' : '可下载待核验草稿查看。')));

        const choices = [];
        for (const page of task.pageReview.failedPages) {
            const details = node('div', 'modal-form-field');
            const label = node('label', 'modal-form-label');
            if (task.canRepairPages) {
                const checkbox = node('input');
                checkbox.type = 'checkbox';
                checkbox.checked = true;
                label.appendChild(checkbox);
                choices.push({ page: page.page, checkbox });
            }
            label.appendChild(node('span', '', `第 ${page.page} 页 · ${page.title}`));
            details.appendChild(label);
            if (page.missingTitle) details.appendChild(node('p', 'presentation-master-task-summary', '页面标题需与确认清单一致。'));
            for (const item of page.items) {
                const chart = item.chart ? `，图表「${item.chart.series}」的「${item.chart.category}」应为 ${item.chart.number}` : '';
                details.appendChild(node('p', 'presentation-master-task-summary', `第 ${item.index} 项应包含「${item.text}」${chart}。`));
                if (item.source?.quote) details.appendChild(node('p', 'presentation-master-task-summary', `材料原文「${item.source.quote}」`));
            }
            review.appendChild(details);
        }
        container.appendChild(review);
        if (!task.canRepairPages) return null;

        const field = node('label', 'modal-form-field');
        field.appendChild(node('span', 'modal-form-label', '本次修改意见（选填）'));
        const note = node('textarea', 'form-input');
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

    function mountActions(row, panel, task, { node, getEpoch, isCurrent, restart, showError, feedback }) {
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
        if (!task.hasReviewDraft) return;
        panel.appendChild(node('p', 'presentation-master-task-summary', '已保留待核验草稿，供检查版面与内容。正式交付须通过清单核验。'));
        const draft = node('button', 'btn-secondary', '下载待核验草稿（.pptx）');
        draft.type = 'button';
        draft.addEventListener('click', async () => {
            const sequence = getEpoch();
            draft.disabled = true;
            feedback.textContent = '';
            try {
                const response = await window.Pivot.api.fetch('/api/apps/presentations/master/tasks/' + encodeURIComponent(task.id) + '/review-draft');
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error?.message || data.error || '草稿下载失败，请刷新任务状态后重试。');
                }
                const blob = await response.blob();
                if (!isCurrent(sequence)) return;
                const url = URL.createObjectURL(blob);
                const link = node('a');
                link.href = url;
                link.download = String(task.request?.title || '演示文稿').replace(/[\r\n\\/]/g, '_') + '-待核验草稿.pptx';
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                if (isCurrent(sequence)) feedback.textContent = showError(error);
            } finally {
                if (isCurrent(sequence)) draft.disabled = false;
            }
        });
        row.appendChild(draft);
    }

    window.Pivot.exposeModule('apps.presentations.masterPageReview', { mount, mountActions });
})();
