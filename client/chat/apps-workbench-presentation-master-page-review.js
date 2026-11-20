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
    let checkpointProgressData = null, checkpointReturnFocus = null;
    const byId = id => document.getElementById(id);
    const ACTION_LABELS = { read: '读取任务文件', read_runtime: '读取指引', read_history: '回读历史', read_images: '分页读取图片',
        list: '列出文件', write: '写入文件', run: '执行工具', copy: '复制文件', copy_template: '复制模板', validate_template: '校验模板', pending: '待确认的操作' };
    const TOOL_LABELS = { project: '项目管理', check_svg: '页面矢量检查', finalize: '页面定稿处理', export: '导出演示文件', import_native: '原稿导入',
        import_template: '模板导入', template_preview: '模板预览生成', apply_template: '安装所选模板', split_notes: '拆分演讲备注', preset_shape: '预设图形生成',
        chart_recall: '图表样式检索', visualization_recall: '可视化图式检索', chart_calculator: '图表坐标计算', workspace: '工作区工具',
        text_measure: '文字排版校准', analyze_images: '图片素材盘点', icon_sync: '内置图标同步' };
    const SUBCOMMAND_LABELS = { init: '初始化项目', 'import-sources': '导入源材料', validate: '校验项目结构', info: '查看项目信息',
        'page-context': '读取单页上下文', 'page-context-report': '检查单页上下文报告', 'scaffold-spec': '生成设计规范骨架',
        'scaffold-lock': '生成规范锁文件', calibrate: '字体字号校准', inspect: '检查工作区', pack: '打包演示文件', unpack: '解包演示文件' };
    const DOC_LABELS = { 'SKILL.md': '完整制作总控规范', 'workflows/routing.md': '流程路由指引', 'workflows/generate-pptx.md': '默认生成流程指引',
        'workflows/edit-native-pptx.md': '原稿编辑流程指引', 'workflows/create-template.md': '模板制作流程指引',
        'workflows/profiles/quick-generate.md': '快速制作流程指引', 'workflows/profiles/beautify-pptx.md': '美化原稿流程指引',
        'workflows/profiles/image-to-pptx.md': '图片重建流程指引', 'workflows/governance/failure-recovery.md': '失败恢复指引',
        'references/strategist.md': '策划师指引', 'references/strategist-template.md': '模板策划指引', 'references/strategist-image.md': '图片策划指引',
        'references/plan-core.md': '规划核心指引', 'references/canvas-formats.md': '画布规格指引', 'references/confirm-surface.md': '方案确认规范',
        'references/shared-standards.md': '通用设计规范', 'references/shared-standards-core.md': '核心设计规范',
        'references/executor-base.md': '页面绘制基础指引', 'references/executor-structure.md': '页面结构绘制指引', 'references/executor-structured.md': '结构化页面绘制指引',
        'references/executor-chart.md': '图表绘制指引', 'references/executor-table.md': '表格绘制指引', 'references/executor-image.md': '配图处理指引',
        'references/executor-web-image.md': '网络配图处理指引', 'references/executor-notes.md': '演讲备注指引', 'references/executor-visualization.md': '可视化图形指引',
        'references/modes/_index.md': '叙事模式索引', 'references/visual-styles/_index.md': '视觉风格索引',
        'references/image-palettes/_index.md': '配图配色索引', 'references/image-renderings/_index.md': '配图画风索引', 'references/image-type-templates/_index.md': '配图版型索引',
        'references/semantic-svg.md': '语义矢量规范', 'references/svg-effects.md': '矢量视觉效果规范', 'references/svg-image-embedding.md': '矢量嵌图规范',
        'references/native-data-interface.md': '原生图表数据契约', 'references/native-formula.md': '原生公式规范', 'references/native-hyperlinks.md': '原生超链接规范',
        'references/native-shape-authoring.md': '原生图形绘制规范', 'references/pptx-structure-interface.md': '演示文稿结构规范',
        'references/preset-shape-vocabulary.md': '预设图形词表', 'references/template-designer.md': '模板设计指引',
        'references/topology-assembly.md': '拓扑布局指引', 'references/visual-review.md': '视觉复核指引',
        'references/animations.md': '动画设计指引', 'references/video-design.md': '视频制作指引', 'references/artifact-ownership.md': '产物归属规范',
        'scripts/docs/project.md': '项目管理工具说明', 'scripts/docs/svg-pipeline.md': '矢量页面流转说明', 'scripts/docs/svg-contract.md': '矢量页面规范说明',
        'scripts/docs/conversion.md': '演示文件导出说明', 'scripts/docs/native-data.md': '原生图表与表格说明',
        'scripts/docs/chart-recall.md': '图表检索工具说明', 'scripts/docs/visualization-recall.md': '可视化检索工具说明',
        'scripts/docs/template-tools.md': '模板工具说明', 'scripts/docs/troubleshooting.md': '故障排查说明',
        'spec_lock.md': '设计规范锁文件', 'design_spec.md': '设计规范文件', 'outline.md': '内容大纲文件', 'content_outline.md': '内容大纲文件',
        'brand_spec.md': '品牌规范文件', 'style_spec.md': '风格规范文件', 'layout_spec.md': '版式规范文件',
        'deck_spec.yaml': '演示规格文件', 'deck_spec.yml': '演示规格文件', 'theme.yaml': '主题配色文件', 'theme.yml': '主题配色文件',
        'manifest.json': '项目清单文件', 'total.md': '整稿讲稿文件', 'README.md': '项目说明文件' };
    const ERROR_REASONS = { PPT_MASTER_ACTION_INVALID: '动作格式、参数或阶段不符', PPT_MASTER_MODEL_OUTPUT_INVALID: '模型回复格式无效',
        PPT_MASTER_MODEL_TRUNCATED: '模型回复被截断', PPT_MASTER_CHECKLIST_REQUIRED: '确认或交付清单缺失',
        PPT_MASTER_CITATION_REVIEW_REQUIRED: '清单引文需要核对', PPT_MASTER_DELIVERY_REVIEW_REQUIRED: '导出演示文件回读与已确认清单不一致',
        PPT_MASTER_TOOL_REPEATED_FAILURE: '制作工具连续执行失败', PPT_MASTER_NO_PROGRESS: '多轮重复读取或检查未取得新结果',
        PPT_MASTER_OPERATION_FAILED: '工具脚本执行失败', PPT_SERVICE_OPERATION_FAILED: '执行服务动作未通过', PPT_SERVICE_TIMEOUT: '执行服务动作超时' };
    const OUTCOME_BADGES = { productive: { text: '已写入推进', tone: 'completed' }, progressed: { text: '读取与检查', tone: 'working' },
        input_required: { text: '提交确认', tone: 'input_required' }, completed: { text: '导出交付', tone: 'completed' },
        page_repair: { text: '自动修页', tone: 'input_required' }, retry: { text: '动作修正重试', tone: 'failed' },
        tool_failed: { text: '工具未通过', tone: 'failed' }, stalled: { text: '重复无进展', tone: 'failed' }, failed: { text: '执行异常', tone: 'failed' } };

    const DOC_ICON_PATHS = [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: '16', y1: '13', x2: '8', y2: '13' }], ['line', { x1: '16', y1: '17', x2: '8', y2: '17' }]];
    const USAGE_ICON_PATHS = [['line', { x1: '18', y1: '20', x2: '18', y2: '10' }], ['line', { x1: '12', y1: '20', x2: '12', y2: '4' }], ['line', { x1: '6', y1: '20', x2: '6', y2: '14' }]];
    const PREFIX_LABELS = [
        ['references/modes/', '叙事模式指引'], ['references/visual-styles/', '视觉风格指引'], ['references/image-palettes/', '配图配色指引'],
        ['references/image-renderings/', '配图画风指引'], ['references/image-type-templates/', '配图版型指引'], ['references/image', '图片设计指引'],
        ['references/', '制作参考指引'], ['workflows/stages/', '阶段流程指引'], ['workflows/create-template/', '模板制作子流程指引'],
        ['workflows/', '制作流程指引'], ['scripts/docs/', '制作工具说明'], ['templates/charts/', '内置图表样式规范'],
        ['templates/tables/', '内置表格样式规范'], ['templates/styles/', '内置风格模板规范'], ['templates/brands/', '内置品牌模板规范'],
        ['templates/layouts/', '内置版式模板规范'], ['templates/decks/', '内置整套模板规范'], ['templates/', '内置模板规范']
    ];

    function localizePath(path) {
        if (!path) return '';
        if (DOC_LABELS[path]) return DOC_LABELS[path];
        if (path === 'instruction') return '制作要求';
        const supplement = /^user-supplement:([1-9]\d*)$/.exec(path);
        if (supplement) return '用户补充 ' + supplement[1];
        const material = /^inputs\/material-([1-9]\d*)\.md$/i.exec(path);
        if (material) return '输入材料 ' + material[1];
        if (/^inputs\/source\.pptx$/i.test(path)) return '源演示文稿';
        if (/^inputs\/source\.(?:png|jpe?g|webp)$/i.test(path)) return '源图片素材';
        if (path.startsWith('inputs/')) return '输入素材文件';
        if (path === 'selected-template/templates/design_spec.md') return '所选模板设计规范';
        if (path === 'selected-template') return '所选模板工作区';
        if (path.startsWith('selected-template/')) return '所选模板文件';
        const slideNo = /(?:slide|page)[_-]?0*([1-9]\d*)/i.exec(path)?.[1];
        if (/^(?:svg_output|authoring-svg-flat|authoring-svg-layered)\//i.test(path)) return slideNo ? `第 ${slideNo} 页矢量稿` : '页面矢量稿';
        if (/^svg_final\//i.test(path)) return slideNo ? `第 ${slideNo} 页定稿矢量` : '定稿矢量页';
        if (/^notes\//i.test(path)) return slideNo ? `第 ${slideNo} 页演讲备注` : '演讲备注文件';
        if (/^exports\//i.test(path)) return '导出演示文件';
        if (/^images\//i.test(path)) return '项目图片素材';
        if (/^icons\//i.test(path)) return '项目图标素材';
        if (/^validation\//i.test(path)) return '校验与校准记录';
        if (/^(?:charts|data)\//i.test(path)) return '图表与数据文件';
        const prefix = PREFIX_LABELS.find(([key]) => path.startsWith(key));
        if (prefix) return prefix[1];
        if (/\.svg$/i.test(path)) return slideNo ? `第 ${slideNo} 页矢量稿` : '页面矢量稿';
        if (/\.pptx$/i.test(path)) return '演示文稿文件';
        if (/\.md$/i.test(path)) return '项目文档';
        if (/\.(?:json|ya?ml)$/i.test(path)) return '项目配置文件';
        if (/\.(?:png|jpe?g|webp)$/i.test(path)) return '图片素材';
        return '任务文件';
    }

    function formatDiagnosticLocation(item) {
        if (!item || typeof item !== 'object') return '';
        const label = ACTION_LABELS[item.action] || '制作操作';
        const toolName = item.tool ? (TOOL_LABELS[item.tool] || '制作工具') : '';
        const subName = item.subcommand ? (SUBCOMMAND_LABELS[item.subcommand] || '') : '';
        const tool = toolName ? (subName ? `${toolName}（${subName}）` : toolName) : '';
        const path = item.path ? localizePath(item.path) : '';
        const coordinates = Number.isSafeInteger(item.archive) && Number.isSafeInteger(item.index) ? `归档 ${item.archive}，消息 ${item.index}` : '';
        let range = '';
        if (['read', 'read_runtime', 'read_history'].includes(item.action) && Number.isSafeInteger(item.offset)) {
            range = Number.isSafeInteger(item.nextOffset) ? `偏移 ${item.offset}→${item.nextOffset}`
                : item.nextOffset === null ? (item.offset > 0 ? `偏移 ${item.offset}（已读完）` : '已读完') : `偏移 ${item.offset}`;
        } else if (Number.isSafeInteger(item.offset)) range = `偏移 ${item.offset}`;
        const count = Number.isSafeInteger(item.fileCount) ? `${item.fileCount} ${item.action === 'read_images' ? '张' : '项'}` : '';
        const failReason = ERROR_REASONS[item.errorCode] || '';
        const status = item.confirmed ? '已确认写入'
            : item.failed ? (Number.isInteger(item.exitCode) ? `未通过（退出码 ${item.exitCode}）` : `未通过${failReason ? '（' + failReason + '）' : ''}`) : '';
        return [label, tool, path, coordinates, range, count, status].filter(Boolean).join(' · ');
    }

    function formatTurnWork(item) {
        if (!item || typeof item !== 'object') return '';
        if (item.outcome === 'input_required') {
            const stages = { direction: '确认沟通方向', design: '确认最终页面与关键数据清单', template: '确认模板制作方案' };
            return item.inputKind === 'confirmation'
                ? `提交阶段确认（${stages[item.stage] || '方案确认'}${item.planPages ? '，共 ' + item.planPages + ' 页' : ''}）`
                : '提交补充事实问题，等待用户答复';
        }
        if (item.outcome === 'completed') return `提交最终${item.deliveryKind === 'template' ? '模板工作区' : '演示文件导出'}核验${item.path ? '（' + localizePath(item.path) + '）' : ''}`;
        if (item.outcome === 'page_repair') return `导出回读核验后转入按页自动修复（第 ${(item.repairPages || []).join('、')} 页）`;
        if (Array.isArray(item.actions) && item.actions.length) {
            return item.actions.map(formatDiagnosticLocation).filter(Boolean).join('；')
                + (item.skippedActions ? `（其余 ${item.skippedActions} 项因前序失败未执行）` : '');
        }
        if (item.outcome === 'retry') return '模型回复未通过宿主校验，未执行工具动作';
        if (item.outcome === 'failed') return '本轮制作动作未能完成';
        return '';
    }

    function formatTurnError(item) {
        if (!item || typeof item !== 'object') return '';
        if (item.outcome === 'retry') {
            if (item.errorCode === 'PPT_MASTER_CITATION_REVIEW_REQUIRED') {
                return `清单引文待核对${item.citationCount ? '（共 ' + item.citationCount + ' 项' + (item.citationLocation ? '，首项：' + item.citationLocation : '') + '）' : ''}，宿主已自动发起查证重试。`;
            }
            return `${ERROR_REASONS[item.errorCode] || '模型输出格式或阶段不符'}，宿主已自动要求模型修正重试。`;
        }
        if (item.outcome === 'stalled' || item.repeated) {
            const rep = item.repeated && ACTION_LABELS[item.repeated.action] ? formatDiagnosticLocation(item.repeated) : '';
            return `重复读取或检查同一内容${rep ? '（' + rep + '）' : ''}未取得新结果${item.repairAttempt ? '，已触发第 ' + item.repairAttempt + '/2 次步骤调整' : ''}。`;
        }
        if (item.outcome === 'tool_failed') {
            const failed = (item.actions || []).find(action => action.failed);
            return `工具动作未通过：${failed ? formatDiagnosticLocation(failed) : (ERROR_REASONS[item.errorCode] || '执行失败')}${item.skippedActions ? '；同批后续 ' + item.skippedActions + ' 项动作已停止' : ''}。`;
        }
        if (item.outcome === 'page_repair') return `导出演示文件回读发现第 ${(item.repairPages || []).join('、')} 页与确认清单不一致，已启动自动修页。`;
        if (item.outcome === 'failed') {
            return `${ERROR_REASONS[item.errorCode] || '本轮执行异常终止'}${item.failedPages?.length ? '（待修页：第 ' + item.failedPages.join('、') + ' 页）' : ''}${item.citationLocation ? '（' + item.citationLocation + '）' : ''}。`;
        }
        return '';
    }
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
        if (usageModal && !usageModal.classList.contains('hidden')) usageModal.classList.add('hidden');
        if (!restoreFocus) closeCheckpointModal({ restoreFocus: false });
        const checkpointOpen = byId('presentation-master-checkpoint-modal') && !byId('presentation-master-checkpoint-modal').classList.contains('hidden');
        if (!checkpointOpen) setProcessModalInert(false);
        const focus = usageReturnFocus; usageReturnFocus = null;
        if (restoreFocus && focus?.isConnected) focus.focus();
    }
    function removeUsageModal() {
        usageDiagnostics = [];
        closeUsageModal({ restoreFocus: false });
        byId('presentation-master-usage-modal')?.remove();
        removeCheckpointModal();
    }
    function closeCheckpointModal({ restoreFocus = true } = {}) {
        const modal = byId('presentation-master-checkpoint-modal');
        const body = byId('presentation-master-checkpoint-body');
        if (body) body.replaceChildren();
        if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden');
        const usageOpen = byId('presentation-master-usage-modal') && !byId('presentation-master-usage-modal').classList.contains('hidden');
        if (!usageOpen) setProcessModalInert(false);
        const focus = checkpointReturnFocus; checkpointReturnFocus = null;
        if (restoreFocus && focus?.isConnected) focus.focus();
    }
    function removeCheckpointModal() {
        checkpointProgressData = null;
        closeCheckpointModal({ restoreFocus: false });
        byId('presentation-master-checkpoint-modal')?.remove();
    }
    function ensureSubModal({ id, title, subtitle, icon, bodyClass, bodyId, onClose }) {
        if (byId(id)) return byId(id);
        const modal = el('div', 'modal-overlay presentation-master-usage-overlay hidden');
        modal.id = id;
        const dialog = el('section', 'workspace-modal presentation-master-usage-dialog');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', title);
        const header = el('header', 'workspace-modal-header presentation-master-header');
        const headerInfo = el('div', 'presentation-master-header-info');
        const titleRow = el('div', 'presentation-master-header-title-row');
        const headerIcon = el('span', 'presentation-master-header-icon');
        headerIcon.appendChild(svgIcon(icon, 16));
        titleRow.append(headerIcon, el('h3', '', title));
        headerInfo.append(titleRow, el('p', 'presentation-master-header-subtitle', subtitle));
        const closeBtn = el('button', 'btn-secondary workspace-modal-close', '关闭'); closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => onClose());
        header.append(headerInfo, closeBtn);
        const body = el('div', 'workspace-modal-body ' + bodyClass);
        if (bodyId) body.id = bodyId;
        dialog.append(header, body); modal.appendChild(dialog); document.body.appendChild(modal);
        modal.addEventListener('click', event => { if (event.target === modal) onClose(); });
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
            trapDialogFocus(dialog, event);
        });
        return modal;
    }
    function ensureCheckpointModal() {
        return ensureSubModal({ id: 'presentation-master-checkpoint-modal', title: '材料与提纲',
            subtitle: '核对文字材料快照读取范围及已保存的沟通方向与逐页提纲', icon: DOC_ICON_PATHS,
            bodyClass: 'presentation-master-checkpoint-body', bodyId: 'presentation-master-checkpoint-body', onClose: closeCheckpointModal });
    }
    function renderCheckpointBody() {
        const body = byId('presentation-master-checkpoint-body');
        const progress = checkpointProgressData;
        if (!body || !progress) return;
        body.replaceChildren();
        const { materials = [], plans = [] } = progress;
        const readCount = materials.filter(item => item.reads).length;
        const materialSection = el('section', 'presentation-master-checkpoint-section');
        const matHead = el('div', 'presentation-master-checkpoint-head');
        const matTitleGroup = el('div', 'presentation-master-checkpoint-title-group');
        matTitleGroup.append(
            el('h4', 'presentation-master-checkpoint-stage', '输入材料与制作要求'),
            el('span', `presentation-master-task-badge ${progress.requirementsLoaded ? 'completed' : 'expired'}`,
                progress.requirementsLoaded ? '制作要求已载入' : '制作要求待载入')
        );
        matHead.append(matTitleGroup, el('span', 'presentation-master-checkpoint-count',
            materials.length ? `已读取 ${readCount} / ${materials.length} 份文字材料` : '未提供文字材料'));
        materialSection.appendChild(matHead);
        if (!progress.requirementsLoaded) {
            materialSection.appendChild(el('p', 'presentation-master-task-summary', '制作要求已随任务登记，流程准备尚无完成回执。'));
        }
        if (materials.length) {
            const list = el('ul', 'presentation-master-checkpoint-materials');
            for (const material of materials) {
                const row = el('li', 'presentation-master-checkpoint-material');
                const name = el('span', 'presentation-master-checkpoint-material-name');
                name.append(
                    svgIcon([['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }]], 14),
                    el('span', '', material.title)
                );
                const status = [];
                if (material.complete) status.push('已读完整文字快照');
                else if (material.reads) status.push(material.totalChars && material.contiguous > 0
                    ? `从开头已连续读取 ${material.contiguous.toLocaleString('zh-CN')} / ${material.totalChars.toLocaleString('zh-CN')} 字符`
                    : '已读取部分内容');
                else if (material.saved) status.push('已准备输入快照，暂无成功读取回执');
                else status.push('输入快照待准备');
                if (material.failedReads) status.push(`读取失败 ${material.failedReads} 次`);
                const badgeTone = material.failedReads ? 'failed' : material.complete ? 'completed' : material.reads ? 'input_required' : 'expired';
                row.append(name, el('span', `presentation-master-task-badge ${badgeTone}`, status.join(' · ')));
                list.appendChild(row);
            }
            materialSection.appendChild(list);
        }
        body.appendChild(materialSection);
        const stageNames = { direction: '沟通方向', design: '逐页提纲', template: '模板方案' };
        const statusMeta = {
            approved: { label: '已确认', tone: 'completed' },
            pending: { label: '待确认', tone: 'input_required' },
            citation_review: { label: '引文待核对', tone: 'failed' },
            previous: { label: '历史方案', tone: 'expired' }
        };
        for (const plan of plans) {
            const planSection = el('section', 'presentation-master-checkpoint-section');
            const head = el('div', 'presentation-master-checkpoint-head');
            const titleGroup = el('div', 'presentation-master-checkpoint-title-group');
            const statusInfo = statusMeta[plan.status] || { label: '已保存', tone: 'working' };
            titleGroup.append(
                el('h4', 'presentation-master-checkpoint-stage', stageNames[plan.stage] || '方案'),
                el('span', `presentation-master-task-badge ${statusInfo.tone}`, statusInfo.label)
            );
            head.appendChild(titleGroup);
            if (plan.pages?.length) head.appendChild(el('span', 'presentation-master-checkpoint-count', `共 ${plan.pages.length} 页`));
            planSection.appendChild(head);
            if (plan.summary) planSection.appendChild(el('p', 'presentation-master-checkpoint-summary', plan.summary));
            if (plan.pages?.length) {
                const pages = el('ol', 'presentation-master-checkpoint-pages');
                for (const [index, page] of plan.pages.entries()) {
                    const card = el('li', 'presentation-master-checkpoint-page');
                    const pageHead = el('div', 'presentation-master-checkpoint-page-head');
                    pageHead.append(
                        el('span', 'presentation-master-plan-num', `第 ${index + 1} 页`),
                        el('h5', 'presentation-master-checkpoint-page-title', page.title || '标题待补充')
                    );
                    card.appendChild(pageHead);
                    if (page.values?.length) {
                        const values = el('ul', 'presentation-master-checkpoint-values');
                        for (const text of page.values) values.appendChild(el('li', 'presentation-master-checkpoint-value', text));
                        card.appendChild(values);
                    }
                    pages.appendChild(card);
                }
                planSection.appendChild(pages);
            }
            body.appendChild(planSection);
        }
        if (!plans.length) {
            const emptySection = el('section', 'presentation-master-checkpoint-section');
            emptySection.appendChild(el('p', 'presentation-master-checkpoint-empty', '检查点中还没有已保存的方案或逐页提纲。'));
            body.appendChild(emptySection);
        }
    }
    function openCheckpointModal(trigger = null) {
        const modal = ensureCheckpointModal();
        if (modal.classList.contains('hidden')) checkpointReturnFocus = trigger || document.activeElement;
        renderCheckpointBody();
        setProcessModalInert(true);
        modal.classList.remove('hidden');
        modal.querySelector('.workspace-modal-close')?.focus();
    }
    function ensureUsageBar(panel) {
        let bar = panel.querySelector('.presentation-master-usage-bar');
        if (!bar) {
            bar = el('div', 'presentation-master-usage-bar');
            panel.appendChild(bar);
        }
        return bar;
    }
    function ensureUsageModal() {
        const modal = ensureSubModal({ id: 'presentation-master-usage-modal', title: '每轮模型用量明细',
            subtitle: '按模型调用轮次展示本轮工作、异常诊断、输入输出令牌与上下文收敛详情', icon: USAGE_ICON_PATHS,
            bodyClass: 'presentation-master-usage-body', onClose: closeUsageModal });
        if (!byId('presentation-master-usage-list')) {
            const list = el('ol', 'presentation-master-usage-list'); list.id = 'presentation-master-usage-list';
            modal.querySelector('.presentation-master-usage-body')?.appendChild(list);
        }
        return modal;
    }
    function renderUsageList() {
        const list = byId('presentation-master-usage-list');
        if (!list) return;
        list.replaceChildren();
        for (const item of usageDiagnostics) {
            const row = el('li', 'presentation-master-usage-item');
            const top = el('div', 'presentation-master-usage-item-head');
            const stepGroup = el('div', 'presentation-master-usage-step-group');
            stepGroup.appendChild(el('span', 'presentation-master-usage-step', `第 ${item.call || item.step} 次模型调用（步骤 ${item.step}）`));
            const badge = OUTCOME_BADGES[item.outcome];
            if (badge) stepGroup.appendChild(el('span', `presentation-master-task-badge ${badge.tone}`, badge.text));
            top.append(
                stepGroup,
                el('span', 'presentation-master-usage-metrics', `输入 ${item.inputTokens}${item.inputEstimated ? '（估算）' : ''}，输出 ${item.outputTokens}${item.outputEstimated ? '（估算）' : ''}，累计 ${item.cumulativeTokens}`)
            );
            row.appendChild(top);
            const work = formatTurnWork(item);
            if (work) {
                const workEl = el('p', 'presentation-master-usage-work', `本轮工作：${work}`);
                const rawTargets = (item.actions || []).map(action => [action.tool, action.subcommand, action.path].filter(Boolean).join(' ')).filter(Boolean);
                if (rawTargets.length) workEl.title = rawTargets.join('；');
                row.appendChild(workEl);
            }
            const err = formatTurnError(item);
            if (err) {
                const errEl = el('p', 'presentation-master-usage-error', `异常诊断：${err}`);
                if (item.errorCode) errEl.title = item.errorCode;
                row.appendChild(errEl);
            }
            const parts = item.breakdown ? `（初始指引及任务 ${item.breakdown.initial}，历史消息 ${item.breakdown.history}，工具结果 ${item.breakdown.toolResults || 0}，图片 ${item.breakdown.images}）` : '';
            row.appendChild(el('p', 'presentation-master-usage-detail', `预计输入 ${item.inputEstimate}${parts}，收敛前预计 ${item.originalEstimate}，已收敛 ${item.compactedWrites} 条文件写入正文。`));
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
        const usageBar = ensureUsageBar(panel);
        const usageBtn = el('button', 'btn-secondary presentation-master-usage-btn');
        usageBtn.type = 'button'; usageBtn.id = 'presentation-master-usage-btn';
        usageBtn.append(svgIcon(USAGE_ICON_PATHS, 13), el('span', '', `查看每轮模型用量（共 ${usageDiagnostics.length} 轮）`));
        usageBtn.addEventListener('click', () => openUsageModal(usageBtn));
        usageBar.appendChild(usageBtn);
        const usageModal = byId('presentation-master-usage-modal');
        if (usageModal && !usageModal.classList.contains('hidden')) renderUsageList();
    }

    function mountCheckpointProgress(panel, progress) {
        checkpointProgressData = progress || null;
        if (!progress) return;
        const { materials = [], plans = [] } = progress;
        const read = materials.filter(item => item.reads).length;
        const headline = ['查看材料与提纲', materials.length ? `已读取 ${read} / ${materials.length} 份文字材料` : '未提供文字材料',
            plans.length ? '有已保存方案' : '暂无已保存方案'];
        const bar = ensureUsageBar(panel);
        const btn = el('button', 'btn-secondary presentation-master-usage-btn');
        btn.type = 'button'; btn.id = 'presentation-master-checkpoint-btn';
        btn.append(svgIcon(DOC_ICON_PATHS, 13), el('span', '', headline.join(' · ')));
        btn.addEventListener('click', () => openCheckpointModal(btn));
        bar.appendChild(btn);
        const modal = byId('presentation-master-checkpoint-modal');
        if (modal && !modal.classList.contains('hidden')) renderCheckpointBody();
    }

    function mountTaskDiagnostics(panel, value, node) {
        if (value.workflowProgress?.goal && ['working', 'failed', 'expired'].includes(value.status)) {
            const { goal, calls, limit } = value.workflowProgress;
            panel.appendChild(node('p', 'presentation-master-task-summary', `当前目标 ${goal}，本阶段已用 ${calls} / ${limit} 轮。`));
        }
        if (value.imageCoverage?.total) panel.appendChild(node('p', 'presentation-master-task-summary', `已发送 ${value.imageCoverage.read} / ${value.imageCoverage.total} 张图片给模型。`));
        if (value.actionRetries) {
            const reason = Object.hasOwn(ERROR_REASONS, value.lastActionCorrection) ? ERROR_REASONS[value.lastActionCorrection] : '';
            panel.appendChild(node('p', 'presentation-master-task-summary', `已修正模型动作 ${value.actionRetries} 次。${reason ? '最近原因：' + reason + '。' : ''}`));
        }
        const audit = value.result?.checks;
        if (audit?.checklistDigest) panel.appendChild(node('p', 'presentation-master-task-summary', `交付已按批准清单核对 ${audit.checkedPages} 页及 ${audit.checkedValues} 项关键数据。`));
        const actions = value.actionSummary;
        if (actions && value.steps > 0) {
            const writeText = actions.writes ? `已确认直接写入 ${actions.writes} 次。最近写入 ${actions.lastWrittenPath}。` : '当前检查点暂无直接写入回执。';
            const recent = (actions.lastActions || []).map(item => ACTION_LABELS[item.action] && ACTION_LABELS[item.action] + (item.failed ? '未完成' : '')).filter(Boolean);
            panel.appendChild(node('p', 'presentation-master-task-summary', writeText + (actions.failedWrites ? `写入失败 ${actions.failedWrites} 次。` : '') +
                (actions.runtimeReads ? `已读取指引 ${actions.runtimeReads} 次。` : '') +
                (recent.length ? '最近工具动作包括' + recent.join('、') + '。' : '')));
            const stalled = value.error?.code === 'PPT_MASTER_NO_PROGRESS';
            const diagnostic = stalled ? value.inspectionDiagnostic : actions.lastFailure;
            if (diagnostic && ACTION_LABELS[diagnostic.action] && (value.error || actions.lastActions?.some(item => item.failed))) {
                const prefix = stalled ? '重复检查' : '最近失败';
                const coordinates = Number.isSafeInteger(diagnostic.archive) && Number.isSafeInteger(diagnostic.index)
                    ? `归档 ${diagnostic.archive}，消息 ${diagnostic.index}` : '';
                const details = [ACTION_LABELS[diagnostic.action], diagnostic.tool, diagnostic.path, coordinates,
                    Number.isSafeInteger(diagnostic.offset) ? `偏移 ${diagnostic.offset}` : '',
                    Number.isInteger(diagnostic.exitCode) ? `退出码 ${diagnostic.exitCode}` : diagnostic.errorCode].filter(Boolean);
                panel.appendChild(node('p', 'presentation-master-task-summary', prefix + '：' + details.join(' · ')));
            }
        }
        if (Array.isArray(value.usageDiagnostics) && value.usageDiagnostics.length) {
            const latestTurn = value.usageDiagnostics.at(-1);
            const latestWork = formatTurnWork(latestTurn);
            if (latestWork) panel.appendChild(node('p', 'presentation-master-task-summary', `本步工作（第 ${latestTurn.step} 步）：${latestWork}。`));
            const issueTurns = value.usageDiagnostics.filter(item => formatTurnError(item));
            if (issueTurns.length) {
                const lastIssue = issueTurns.at(-1);
                panel.appendChild(node('p', 'presentation-master-task-summary', `轮次异常记录（共 ${issueTurns.length} 轮，最近在第 ${lastIssue.call || lastIssue.step} 轮 / 步骤 ${lastIssue.step}）：${formatTurnError(lastIssue)}`));
            }
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
        mountCheckpointProgress(panel, value.checkpointProgress, node);
    }

    window.Pivot.exposeModule('apps.presentations.masterPageReview', {
        mount, mountTaskDiagnostics, mountActions, mountHistory, mountUsageButton, closeUsageModal, removeUsageModal, trapDialogFocus, mountResumeNote, citationSourceName
    });
})();
