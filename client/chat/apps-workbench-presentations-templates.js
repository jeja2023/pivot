(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.templates')?.ready) return;

    const API = '/api/apps/presentations';
    const byId = id => document.getElementById(id);

    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) {
            const error = new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
            error.status = res.status;
            error.code = data?.code || data?.error?.code || '';
            throw error;
        }
        return data;
    }

    function jsonOptions(body) {
        return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    }

    function downloadBlob(name, blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function renderTemplateImportReport(template, expanded = false) {
        const host = byId('presentation-template-import-report');
        const report = Array.isArray(template?.importReport) ? template.importReport : (Array.isArray(template?.definition?.importMetadata?.report) ? template.definition.importMetadata.report : []);
        const button = byId('presentation-template-report-btn');
        button?.classList.toggle('hidden', !report.length);
        if (!host) return;
        host.replaceChildren();
        host.classList.toggle('hidden', !expanded || !report.length);
        if (!expanded || !report.length) return;
        const title = document.createElement('strong'); title.textContent = `兼容性报告（${report.length} 项）`;
        const list = document.createElement('div'); list.className = 'presentation-template-import-report-list';
        report.slice(0, 80).forEach(item => {
            const entry = document.createElement('li'); entry.dataset.severity = item?.severity || 'warning';
            entry.textContent = [item?.location, item?.message].filter(Boolean).join('：') || '模板导入提示'; list.appendChild(entry);
        });
        if (template?.definition?.layouts?.length) host.append(renderTemplateThumbnail(template));
        host.append(title, list);
    }

    function renderTemplatePanel(state, { templateById, renderTemplates } = {}) {
        renderTemplates?.(byId('presentation-template-list'));
        const canManage = typeof isAdminUser === 'function' && isAdminUser();
        byId('presentation-save-template-btn')?.classList.toggle('hidden', !canManage);
        byId('presentation-save-department-template-btn')?.classList.toggle('hidden', !canManage);
        const currentTemplate = templateById?.(state.active?.content?.template?.id || state.active?.template?.id);
        byId('presentation-submit-template-review-btn')?.classList.toggle('hidden', !canManage || !currentTemplate || currentTemplate.ownerType === 'system' || !['draft', 'unpublished'].includes(currentTemplate.status));
        byId('presentation-review-template-btn')?.classList.toggle('hidden', !canManage || currentTemplate?.status !== 'pending_review');
        byId('presentation-import-template-btn')?.classList.toggle('hidden', !canManage);
        byId('presentation-cancel-template-import-btn')?.classList.toggle('hidden', !state.templateImportTaskId);
        byId('presentation-download-template-source-btn')?.classList.toggle('hidden', !canManage || !currentTemplate?.sourceAvailable);
        const canReparse = Boolean(currentTemplate?.sourceAvailable && (currentTemplate?.sourceFormat === 'pptx' || currentTemplate?.definition?.importMetadata?.sourceFormat === 'pptx'));
        byId('presentation-reparse-template-source-btn')?.classList.toggle('hidden', !canManage || !canReparse);
        renderTemplateImportReport(currentTemplate?.importReport?.length ? currentTemplate : state.templateImportPreview, state.templateImportReportExpanded === true);
    }

    async function saveAsTemplate(scope = 'organization', state, { templateById, renderTemplatePanel, renderLibrary, selectedElement, toast } = {}) {
        if (!state.active?.content) return;
        const scopeLabel = scope === 'department' ? '部门' : '组织';
        const name = await window.Pivot.legacy.showInputPrompt?.({ title: '保存为' + scopeLabel + '模板', message: '模板名称', value: state.active.content.title + ' 模板', required: true, width: 480 });
        if (!name) return;
        let departmentName = '';
        if (scope === 'department') {
            departmentName = await window.Pivot.legacy.showInputPrompt?.({ title: '部门模板范围', message: '部门名称', value: '', required: true, width: 480 });
            if (!departmentName) return;
        }
        const currentTemplate = templateById?.(state.active.template?.id);
        const useBrandControls = await window.Pivot.legacy.showConfirm?.('品牌控制', '是否将当前选中的图片作为锁定 Logo，并为模板设置锁定页脚、页码和字体？') === true;
        let brandControls = currentTemplate?.definition?.brandControls || {};
        if (useBrandControls) {
            const footerText = await window.Pivot.legacy.showInputPrompt?.({ title: '品牌页脚', message: '页脚文字（可留空）', value: brandControls.footerText || '', width: 520 }) || '';
            const element = selectedElement?.();
            const selectedLogo = element?.type === 'image' ? element.assetRef : '';
            if (selectedLogo) await requestJson(API + '/assets/publish', jsonOptions({ ref: selectedLogo, scope, departmentName }));
            brandControls = { footerText, logoAssetRef: selectedLogo || brandControls.logoAssetRef || '', lockBrandElements: true, lockFonts: true, showPageNumber: true };
        }
        const definition = { ...(currentTemplate?.definition || {}), theme: state.active.content.theme, layouts: currentTemplate?.definition?.layouts || [], brandControls };
        const data = await requestJson(API + '/templates', jsonOptions({ name, description: '由 ' + state.active.content.title + ' 保存的' + scopeLabel + '模板', definition, aspectRatio: state.active.content.aspectRatio, scope, departmentName, publish: true }));
        state.templates.push(data.template);
        renderTemplatePanel?.();
        renderLibrary?.();
        toast?.(scopeLabel + '模板已提交审核，审核通过后对授权用户可见。');
    }

    async function submitCurrentTemplateReview(state, { templateById, renderTemplatePanel, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!template || template.ownerType === 'system') return;
        const data = await requestJson(API + '/templates/' + encodeURIComponent(templateId) + '/submit-review', { method: 'POST' });
        state.templates = state.templates.map(item => item.id === templateId ? data.template : item);
        renderTemplatePanel?.();
        toast?.('模板已提交审核。');
    }

    async function reviewCurrentTemplate(state, { templateById, renderTemplatePanel, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!template || template.status !== 'pending_review') return;
        const note = await window.Pivot.legacy.showInputPrompt?.({ title: '审核模板', message: '审核说明', value: '已完成素材、字体和布局检查', required: true, width: 520 });
        if (!note) return;
        const data = await requestJson(API + '/templates/' + encodeURIComponent(templateId) + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true, note }) });
        state.templates = state.templates.map(item => item.id === templateId ? data.template : item);
        renderTemplatePanel?.();
        toast?.('模板已审核通过。');
    }

    async function exportCurrentTemplate(state, { templateById, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        if (!templateId) return;
        const response = await apiFetch(`${API}/templates/${encodeURIComponent(templateId)}/package`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || '导出模板失败。');
        }
        downloadBlob(`${templateById?.(templateId)?.name || 'PPT模板'}.pivot-ppt-template.json`, await response.blob());
        toast?.('模板包已开始下载。');
    }

    async function downloadCurrentTemplateSource(state, { templateById, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!templateId || !template?.sourceAvailable) return;
        const response = await apiFetch(`${API}/templates/${encodeURIComponent(templateId)}/source?version=${encodeURIComponent(template.version)}`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || '模板源文件下载失败。');
        }
        const extension = template.sourceFormat === 'pptx' || template.definition?.importMetadata?.sourceFormat === 'pptx' ? 'pptx' : 'pivot-ppt-template.json';
        downloadBlob(`${template.name || 'PPT模板'}-v${template.version}.${extension}`, await response.blob());
        toast?.('模板源文件已开始下载。');
    }

    async function reparseCurrentTemplateSource(state, { templateById, renderTemplatePanel, renderLibrary, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!templateId || !template?.sourceAvailable) return;
        const accepted = await window.Pivot.legacy.showConfirm?.('重新解析模板', '将根据已保存的 PPTX 源文件生成新模板版本，并提交审核；已有文稿不会被修改。');
        if (!accepted) return;
        const data = await requestJson(`${API}/templates/${encodeURIComponent(templateId)}/reparse`, jsonOptions({}));
        state.templates = state.templates.map(item => item.id === templateId ? data.template : item);
        state.templateImportPreview = data.template;
        state.templateImportReportExpanded = true;
        renderTemplatePanel?.(); renderLibrary?.();
        toast?.('模板已重新解析并提交审核。');
    }

    async function importTemplatePackage(file, state, { renderTemplatePanel, renderLibrary, toast } = {}) {
        if (!file) return;
        const importMode = await window.Pivot.legacy.showConfirm?.('PPTX 模板导入方式', '确定后锁定可转换的母版装饰以优先保持外观；取消则保留简单装饰为可编辑对象。') === true ? 'fidelity' : 'editable';
        const form = new FormData();
        form.append('file', file);
        form.append('importMode', importMode);
        const preview = await requestJson(`${API}/templates/import/preview`, { method: 'POST', body: form });
        state.templateImportPreview = { id: '', name: preview.preview?.name || file.name, aspectRatio: preview.preview?.aspectRatio || '16:9', definition: preview.preview?.definition || {}, importReport: preview.preview?.report || [] };
        state.templateImportReportExpanded = true;
        renderTemplatePanel?.();
        const confirmed = await window.Pivot.legacy.showConfirm?.('确认导入模板', `已识别 ${preview.preview?.definition?.masters?.length || 0} 个母版、${preview.preview?.definition?.layouts?.length || 0} 个布局和 ${preview.preview?.assets?.length || 0} 个素材；是否继续导入？`);
        if (!confirmed) { toast?.('模板预检完成，尚未写入模板库。', 'warning'); return; }
        const importForm = new FormData();
        importForm.append('file', file);
        importForm.append('importMode', importMode);
        const started = await requestJson(`${API}/templates/import`, { method: 'POST', body: importForm });
        if (!started.task?.id) throw new Error('模板导入任务未返回任务标识。');
        state.templateImportTaskId = started.task.id;
        renderTemplatePanel?.();
        let task = started.task;
        try {
            for (let attempt = 0; attempt < 180; attempt += 1) {
                await new Promise(resolve => window.setTimeout(resolve, 500));
                const data = await requestJson(`${API}/templates/import/${encodeURIComponent(task.id)}`, { cache: 'no-store' });
                task = data.task || task;
                if (task.status === 'completed') break;
                if (task.status === 'failed') throw new Error(task.errorMessage || '模板导入失败。');
                if (task.status === 'cancelled') { toast?.('模板导入已取消。', 'warning'); return; }
            }
            if (task.status !== 'completed') throw new Error('模板导入处理超时，请稍后在模板面板刷新结果。');
            if (task.template) state.templates = [...state.templates.filter(item => item.id !== task.template.id), task.template];
            state.templateImportPreview = task.template || state.templateImportPreview;
            state.templateImportReportExpanded = true;
            renderTemplatePanel?.();
            renderLibrary?.();
            const warnings = Array.isArray(task.importWarnings) ? task.importWarnings : (Array.isArray(task.importReport) ? task.importReport : []);
            toast?.(warnings.length ? '模板已导入并提交审核；有 ' + warnings.length + ' 项兼容性提示。' : '模板已导入并提交审核，审核通过后对组织用户可见。', warnings.length ? 'warning' : 'success');
        } finally {
            state.templateImportTaskId = '';
            renderTemplatePanel?.();
        }
    }

    async function cancelTemplateImport(state, { renderTemplatePanel, toast } = {}) {
        if (!state.templateImportTaskId) return;
        const data = await requestJson(`${API}/templates/import/${encodeURIComponent(state.templateImportTaskId)}`, { method: 'DELETE' });
        if (data.task?.status === 'cancelled') {
            state.templateImportTaskId = '';
            renderTemplatePanel?.();
            toast?.('模板导入已取消。', 'warning');
        } else if (data.task?.status === 'processing') {
            toast?.('模板已进入解析阶段，当前请求无法取消；请等待兼容性报告。', 'warning');
        }
    }

    function renderTemplateThumbnail(template) {
        const definition = template?.definition || {};
        const layouts = Array.isArray(definition.layouts) ? definition.layouts : [];
        const layout = layouts.find(item => item.legacyLayoutId === 'cover' || /封面|cover/i.test(item.name || '')) || layouts[0] || {};
        const masters = Array.isArray(definition.masters) ? definition.masters : [];
        const master = masters.find(item => item.id === layout.masterId) || masters[0] || {};
        const thumbnail = document.createElement('div'); thumbnail.className = 'presentation-template-thumbnail';
        thumbnail.style.aspectRatio = template.aspectRatio === '4:3' ? '4 / 3' : '16 / 9';
        thumbnail.style.background = master.background?.fill || definition.theme?.colors?.background || '';
        const addItem = (item, className) => {
            const node = document.createElement('i'); node.className = className;
            node.style.left = `${Math.max(0, Math.min(100, Number(item.x || 0) / (template.aspectRatio === '4:3' ? 9.6 : 12.8)))}%`;
            node.style.top = `${Math.max(0, Math.min(100, Number(item.y || 0) / 7.2))}%`;
            node.style.width = `${Math.max(1, Math.min(100, Number(item.width || 100) / (template.aspectRatio === '4:3' ? 9.6 : 12.8)))}%`;
            node.style.height = `${Math.max(1, Math.min(100, Number(item.height || 60) / 7.2))}%`;
            if (item.type === 'shape') node.style.background = item.style?.fill || definition.theme?.colors?.secondary || '';
            if (item.type === 'text') node.style.background = item.style?.color || definition.theme?.colors?.text || '';
            thumbnail.appendChild(node);
        };
        const decorations = [...(master.decorations || []), ...(layout.decorations || [])];
        const placeholders = layout.placeholders || [];
        if (decorations.length || placeholders.length) {
            decorations.slice(0, 12).forEach(item => addItem(item, 'presentation-template-thumbnail-decoration'));
            placeholders.slice(0, 12).forEach(item => addItem(item, 'presentation-template-thumbnail-slot'));
        } else {
            const colors = definition.theme?.colors || template.theme?.colors || {};
            if (colors.primary) {
                const accentBar = document.createElement('i');
                accentBar.className = 'presentation-template-thumbnail-accent';
                accentBar.style.left = '12%';
                accentBar.style.top = '20%';
                accentBar.style.width = '18%';
                accentBar.style.height = '4%';
                accentBar.style.borderRadius = '1px';
                accentBar.style.background = colors.accent || colors.primary;

                const titleBar = document.createElement('i');
                titleBar.className = 'presentation-template-thumbnail-title';
                titleBar.style.left = '12%';
                titleBar.style.top = '34%';
                titleBar.style.width = '56%';
                titleBar.style.height = '14%';
                titleBar.style.borderRadius = '2px';
                titleBar.style.background = colors.primary;

                const subBar = document.createElement('i');
                subBar.className = 'presentation-template-thumbnail-sub';
                subBar.style.left = '12%';
                subBar.style.top = '56%';
                subBar.style.width = '36%';
                subBar.style.height = '8%';
                subBar.style.borderRadius = '1px';
                subBar.style.background = colors.secondary || colors.text || colors.primary;
                subBar.style.opacity = '0.75';

                thumbnail.append(accentBar, titleBar, subBar);
            }
        }
        return thumbnail;
    }
    function renderTemplates(state, host, { compact = false } = {}) {
        if (!host) return;
        host.replaceChildren();
        state.templates.forEach(template => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `presentation-template-card${state.active?.template?.id === template.id ? ' is-active' : ''}${compact ? ' is-compact' : ''}`;
            button.dataset.presentationTemplateId = template.id;
            const color = template.definition?.theme?.colors?.primary || '';
            button.style.setProperty('--presentation-template-color', color);
            const title = document.createElement('strong'); title.textContent = template.name;
            const desc = document.createElement('span'); desc.textContent = template.description || '自定义主题模板';
            const footer = document.createElement('div'); footer.className = 'presentation-template-card-footer';
            const tags = document.createElement('small'); tags.textContent = (template.tags || []).slice(0, 3).join(' · ') || '主题模板';
            const colors = template.definition?.theme?.colors || template.theme?.colors || {};
            const palette = document.createElement('div'); palette.className = 'presentation-template-palette';
            [colors.primary, colors.secondary, colors.accent].filter(Boolean).forEach(c => {
                const dot = document.createElement('span');
                dot.className = 'presentation-template-color-dot';
                dot.style.backgroundColor = c;
                palette.appendChild(dot);
            });
            footer.append(tags, palette);
            button.append(renderTemplateThumbnail(template), title, desc, footer);
            host.appendChild(button);
        });
    }

    function handleTemplateClick(event, state, context = {}) {
        const { renderTemplatePanel, toast } = context;
        const notify = promise => promise?.catch(error => toast?.(error?.message || '模板操作失败', 'error'));
        if (event.target.closest('#presentation-save-template-btn')) { notify(saveAsTemplate('organization', state, context)); return true; }
        if (event.target.closest('#presentation-save-department-template-btn')) { notify(saveAsTemplate('department', state, context)); return true; }
        if (event.target.closest('#presentation-submit-template-review-btn')) { notify(submitCurrentTemplateReview(state, context)); return true; }
        if (event.target.closest('#presentation-review-template-btn')) { notify(reviewCurrentTemplate(state, context)); return true; }
        if (event.target.closest('#presentation-export-template-btn')) { notify(exportCurrentTemplate(state, context)); return true; }
        if (event.target.closest('#presentation-download-template-source-btn')) { notify(downloadCurrentTemplateSource(state, context)); return true; }
        if (event.target.closest('#presentation-reparse-template-source-btn')) { notify(reparseCurrentTemplateSource(state, context)); return true; }
        if (event.target.closest('#presentation-template-report-btn')) { state.templateImportReportExpanded = !state.templateImportReportExpanded; renderTemplatePanel?.(); return true; }
        if (event.target.closest('#presentation-import-template-btn')) { byId('presentation-template-package-input')?.click(); return true; }
        if (event.target.closest('#presentation-cancel-template-import-btn')) { notify(cancelTemplateImport(state, context)); return true; }
        return false;
    }

    const deepClone = val => (val ? JSON.parse(JSON.stringify(val)) : val);

    const PRESENTATION_LAYOUT_LABELS = Object.freeze({
        cover: "封面页", section: "章节过渡页", "title-content": "标题与正文", "two-column": "双栏图文",
        "three-card": "三栏卡片", "image-focus": "大图重点页", chart: "数据图表页", "data-chart": "数据图表页",
        table: "数据表格页", "data-table": "数据表格页", quote: "引用重点页", summary: "总结行动页"
    });

    function presentationLayoutLabel(layoutId, state, templateById) {
        const id = String(layoutId || "").trim();
        if (PRESENTATION_LAYOUT_LABELS[id]) return PRESENTATION_LAYOUT_LABELS[id];
        const layouts = templateById?.(state?.active?.template?.id)?.definition?.layouts || [];
        const configuredName = layouts.find(layout => layout.id === id)?.name?.trim();
        return configuredName || "自定义布局";
    }

    function buildEmptySlide(index, requestedLayoutId = "title-content", state = {}, { templateById, textElement } = {}) {
        const template = templateById?.(state.active?.template?.id);
        const theme = template?.definition?.theme || state.active?.content?.theme || {};
        const colors = theme?.colors || state.active?.content?.theme?.colors || {};
        const layouts = template?.definition?.layouts || [];
        const layout = layouts.find(item => item.id === requestedLayoutId || item.legacyLayoutId === requestedLayoutId)
            || layouts.find(item => item.id === "title-content" || item.legacyLayoutId === "title-content")
            || layouts[0] || null;
        const masters = template?.definition?.masters || [];
        const master = masters.find(item => item.id === layout?.masterId) || null;
        const slideId = `slide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const placeholders = layout?.placeholders || [];
        const layers = [...(master?.decorations || []), ...(layout?.decorations || [])].map((item, itemIndex) => {
            const cloned = deepClone(item);
            if (cloned.content?.text) { cloned.content.text = cloned.content.text.replace(/^[★✦]\s*/, ''); }
            return {
                ...cloned,
                id: `pivotTemplate_${layout?.id || "default"}_${index + 1}_${itemIndex + 1}`,
                zIndex: Number(item.zIndex) || 1,
                locked: item.locked !== false,
                sourceRefs: []
            };
        });
        const editableElements = [];
        if (placeholders.length) {
            placeholders.forEach((slot, slotIndex) => {
                if (slot.kind === "text") {
                    const isTitle = slot.role === "title";
                    const defaultText = isTitle ? "新页面标题" : slot.role === "subtitle" ? "副标题或简要说明" : slot.role === "section" ? "章节导航" : slot.role === "left" ? "左侧要点与阐述" : slot.role === "right" ? "右侧要点与阐述" : slot.role === "card1" ? "核心卡片一" : slot.role === "card2" ? "核心卡片二" : slot.role === "card3" ? "核心卡片三" : slot.role === "quote" ? "“在此输入重点引言或核心金句”" : slot.role === "attribution" ? "—— 引述来源或负责人" : slot.role === "summary" ? "总结与成果回顾" : slot.role === "nextSteps" ? "下一步推进规划" : "在此输入页面内容";
                    editableElements.push({
                        ...textElement(
                            isTitle ? "title" : `text_${slot.role || slotIndex}`,
                            slot.x,
                            slot.y,
                            slot.width,
                            slot.height,
                            defaultText,
                            {
                                fontFamily: isTitle ? (theme?.fonts?.heading || "Microsoft YaHei") : (theme?.fonts?.body || "Microsoft YaHei"),
                                fontSize: slot.style?.fontSize || (isTitle ? 32 : 18),
                                fontWeight: slot.style?.fontWeight || (isTitle ? 700 : 400),
                                color: slot.style?.color || colors.text || "#1F2937",
                                align: slot.style?.align || "left",
                                verticalAlign: slot.style?.verticalAlign || "top",
                                lineHeight: slot.style?.lineHeight || 1.4,
                                ...(slot.style || {})
                            }
                        ),
                        zIndex: 10,
                        animation: deepClone(layout?.slotAnimations?.[slot.role] || { type: "none", durationMs: 0, delayMs: 0, direction: "" })
                    });
                }
            });
        } else {
            editableElements.push(
                { ...textElement("title", 100, 50, 1096, 56, "新页面标题", { fontFamily: theme?.fonts?.heading || "Microsoft YaHei", fontSize: 32, fontWeight: 700, color: colors.text || "" }), zIndex: 10, animation: { type: "none", durationMs: 0, delayMs: 0, direction: "" } },
                { ...textElement("body", 116, 165, 1048, 445, "在此输入页面内容", { fontFamily: theme?.fonts?.body || "Microsoft YaHei", fontSize: 20, color: colors.text || "" }), zIndex: 10, animation: { type: "none", durationMs: 0, delayMs: 0, direction: "" } }
            );
        }
        return {
            id: slideId,
            index,
            type: layout?.category === "封面" ? "cover" : "content",
            layoutId: layout?.id || "title-content",
            sectionId: "",
            background: master?.background ? { fill: master.background.fill || colors.background || "", imageAssetRef: master.background.imageAssetRef || "", opacity: master.background.opacity ?? 1 } : { fill: colors.background || "", imageAssetRef: "", opacity: 1 },
            transition: layout?.defaultTransition?.type && layout.defaultTransition.type !== "none" ? deepClone(layout.defaultTransition) : { type: "none", durationMs: 0, direction: "" },
            elements: [...layers, ...editableElements],
            speakerNotes: "",
            sourceRefs: []
        };
    }

    function applyLayoutToSlide(layoutId, state) {
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (!slide) return;
        const template = state.active?.templateDefinition
            ? { ...state.active.template, definition: state.active.templateDefinition }
            : state.templates?.find(item => item.id === state.active?.template?.id);
        const importedLayout = template?.definition?.layouts?.find(layout => layout.id === layoutId);
        if (importedLayout?.placeholders?.length) {
            const hasDecorations = (importedLayout.decorations || []).some(d => d.type === 'shape');
            let editable = slide.elements.filter(element => {
                if (String(element.id || '').startsWith('pivotTemplate_')) return false;
                if (!hasDecorations) return true;
                if (element.type !== 'shape') return true;
                const id = String(element.id || '').toLowerCase();
                return !/^(?:card_\d+|card\d+|left_box|right_box|focus_box|summary_box|content_box|backdrop|box_\d+|line|cover_accent|accent_.*|header_.*|title_.*|divider.*|border_.*|rect_.*|bg_.*)$/i.test(id);
            });
            editable.forEach(el => {
                el.zIndex = Math.max(Number(el.zIndex) || 10, 10);
            });

            const theme = template?.definition?.theme || state.active?.content?.theme || {};
            const colors = theme?.colors || {};
            const placeholders = importedLayout.placeholders;
            const used = new Set();
            const placed = new Set();

            // 1. Match and place the title element
            const titleSlot = placeholders.find(s => s.role === 'title' && s.kind === 'text');
            let titleEl = editable.find(el => el.type === 'text' && (el.id === 'title' || el.role === 'title'));
            if (!titleEl && titleSlot) {
                const texts = editable.filter(el => el.type === 'text').sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
                if (texts.length && (texts[0].style?.fontSize || 0) >= 26) titleEl = texts[0];
            }
            if (titleEl && titleSlot) {
                used.add(titleSlot.id);
                placed.add(titleEl);
                titleEl.x = titleSlot.x;
                titleEl.y = titleSlot.y;
                titleEl.width = titleSlot.width;
                titleEl.height = titleSlot.height;
                titleEl.rotation = titleSlot.rotation || 0;
                if (titleSlot.style && Object.keys(titleSlot.style).length) titleEl.style = { ...titleEl.style, ...titleSlot.style };
                if (importedLayout.slotAnimations?.[titleSlot.role]) titleEl.animation = { ...importedLayout.slotAnimations[titleSlot.role] };
            }

            const remaining = editable.filter(el => !placed.has(el));

            if (layoutId === 'cover') {
                const subSlot = placeholders.find(s => s.role === 'subtitle');
                const subEl = remaining.find(el => /sub|message|desc/i.test(el.id)) || remaining.find(el => el.type === 'text');
                if (subEl && subSlot) {
                    placed.add(subEl); used.add(subSlot.id);
                    subEl.x = subSlot.x; subEl.y = subSlot.y; subEl.width = subSlot.width; subEl.height = subSlot.height;
                    if (subSlot.style) subEl.style = { ...subEl.style, ...subSlot.style };
                    if (importedLayout.slotAnimations?.subtitle) subEl.animation = { ...importedLayout.slotAnimations.subtitle };

                    const secondEl = remaining.find(el => el !== subEl && el.type === 'text' && !placed.has(el));
                    if (secondEl) {
                        placed.add(secondEl);
                        secondEl.x = subSlot.x; secondEl.y = subSlot.y + 64; secondEl.width = subSlot.width; secondEl.height = 42;
                        secondEl.style = { ...secondEl.style, fontSize: 18, fontWeight: 400, color: colors.text || '#64748B', align: 'left', lineHeight: 1.4 };
                        if (importedLayout.slotAnimations?.subtitle) secondEl.animation = { ...importedLayout.slotAnimations.subtitle, delayMs: (importedLayout.slotAnimations.subtitle.delayMs || 220) + 100 };
                    }
                }
            } else if (layoutId === 'three-card') {
                const cardSlots = [
                    placeholders.find(s => s.role === 'card1'),
                    placeholders.find(s => s.role === 'card2'),
                    placeholders.find(s => s.role === 'card3')
                ].filter(Boolean);

                for (let i = 0; i < 3; i++) {
                    const slot = cardSlots[i];
                    if (!slot) continue;
                    used.add(slot.id);
                    const num = i + 1;
                    const cardRegex = new RegExp(`card[_-]?${num}`, 'i');
                    const cardElements = remaining.filter(el => cardRegex.test(el.id) || el.cardIndex === i);
                    const title = cardElements.find(el => /title|heading|header/i.test(el.id));
                    const body = cardElements.find(el => /body|content|text|desc/i.test(el.id)) || cardElements.find(el => el !== title);
                    const anim = importedLayout.slotAnimations?.[slot.role];

                    const cardPalette = colors.cardPalette || [
                        colors.primary || '#1769AA',
                        colors.secondary || '#5B8FF9',
                        colors.accent || '#61DDAA',
                        '#D8A23A',
                        '#7A5AF8',
                        '#C84A4A'
                    ];

                    if (title && body && title !== body) {
                        placed.add(title); placed.add(body);
                        const cColor = cardPalette[i % cardPalette.length];
                        title.x = slot.x; title.y = slot.y; title.width = slot.width; title.height = 38;
                        title.style = { ...title.style, fontSize: 20, fontWeight: 700, color: cColor, align: 'left', lineHeight: 1.3 };
                        body.x = slot.x; body.y = slot.y + 46; body.width = slot.width; body.height = slot.height - 46;
                        body.style = { ...body.style, fontSize: 15, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.55 };
                        if (anim) {
                            title.animation = { ...anim };
                            body.animation = { ...anim, delayMs: (anim.delayMs || 0) + 60 };
                        }
                    } else if (cardElements.length) {
                        const single = cardElements[0];
                        placed.add(single);
                        single.x = slot.x; single.y = slot.y; single.width = slot.width; single.height = slot.height;
                        if (slot.style) single.style = { ...single.style, ...slot.style };
                        if (anim) single.animation = { ...anim };
                    }
                }
            } else if (layoutId === 'two-column') {
                const leftSlot = placeholders.find(s => s.role === 'left');
                const rightSlot = placeholders.find(s => s.role === 'right');
                const cardPalette = colors.cardPalette || [
                    colors.primary || '#1769AA',
                    colors.secondary || '#5B8FF9',
                    colors.accent || '#61DDAA',
                    '#D8A23A',
                    '#7A5AF8',
                    '#C84A4A'
                ];
                const layoutCol = (slot, regex) => {
                    if (!slot) return;
                    used.add(slot.id);
                    const colElements = remaining.filter(el => regex.test(el.id));
                    const title = colElements.find(el => /title|heading|header/i.test(el.id));
                    const body = colElements.find(el => /body|content|text|desc/i.test(el.id)) || colElements.find(el => el !== title);
                    const anim = importedLayout.slotAnimations?.[slot.role];

                    if (title && body && title !== body) {
                        placed.add(title); placed.add(body);
                        const colColor = slot.role === 'left' ? cardPalette[0] : cardPalette[1];
                        title.x = slot.x; title.y = slot.y; title.width = slot.width; title.height = 40;
                        title.style = { ...title.style, fontSize: 22, fontWeight: 700, color: colColor, align: 'left', lineHeight: 1.3 };
                        body.x = slot.x; body.y = slot.y + 48; body.width = slot.width; body.height = slot.height - 48;
                        body.style = { ...body.style, fontSize: 17, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.95 };
                        if (anim) {
                            title.animation = { ...anim };
                            body.animation = { ...anim, delayMs: (anim.delayMs || 0) + 60 };
                        }
                    } else if (colElements.length) {
                        const single = colElements[0];
                        placed.add(single);
                        single.x = slot.x; single.y = slot.y; single.width = slot.width; single.height = slot.height;
                        if (slot.style) single.style = { ...single.style, ...slot.style };
                        if (anim) single.animation = { ...anim };
                    }
                };
                layoutCol(leftSlot, /left|col_?1/i);
                layoutCol(rightSlot, /right|col_?2/i);
            } else if (layoutId === 'title-content') {
                const bodySlot = placeholders.find(s => s.role === 'body' && s.kind === 'text');
                if (bodySlot) {
                    used.add(bodySlot.id);
                    const textElements = remaining.filter(el => el.type === 'text');
                    const points = textElements.filter(el => /point|bullet|item/i.test(el.id));
                    const notes = textElements.filter(el => /note|hint|source/i.test(el.id));
                    const regular = textElements.filter(el => !points.includes(el) && !notes.includes(el));
                    const ordered = [...points, ...regular, ...notes];
                    if (ordered.length === 1) {
                        const el = ordered[0]; placed.add(el);
                        el.x = bodySlot.x; el.y = bodySlot.y; el.width = bodySlot.width; el.height = bodySlot.height;
                        if (bodySlot.style) el.style = { ...el.style, ...bodySlot.style };
                        if (importedLayout.slotAnimations?.body) el.animation = { ...importedLayout.slotAnimations.body };
                    } else if (ordered.length > 1) {
                        const count = ordered.length;
                        const spacing = Math.min(105, Math.max(68, Math.floor((bodySlot.height - (notes.length ? 50 : 20)) / count)));
                        ordered.forEach((el, idx) => {
                            placed.add(el);
                            const isNote = notes.includes(el);
                            el.x = bodySlot.x; el.y = isNote ? (bodySlot.y + bodySlot.height - 40) : (bodySlot.y + idx * spacing);
                            el.width = bodySlot.width; el.height = isNote ? 36 : Math.min(80, spacing - 8);
                            el.style = { ...el.style, fontSize: isNote ? 14 : count <= 3 ? 22 : count <= 5 ? 19 : 17, fontWeight: isNote ? 400 : 500, lineHeight: 1.6, color: isNote ? '#64748B' : colors.text || '#1F2937', align: 'left' };
                            if (importedLayout.slotAnimations?.body) {
                                el.animation = { ...importedLayout.slotAnimations.body, delayMs: (importedLayout.slotAnimations.body.delayMs || 150) + idx * 90 };
                            }
                        });
                    }
                }
            } else if (layoutId === 'summary') {
                const sumSlot = placeholders.find(s => s.role === 'summary');
                const nextSlot = placeholders.find(s => s.role === 'nextSteps');
                const sumEl = remaining.find(el => /summary|recap/i.test(el.id)) || remaining.find(el => el.type === 'text' && !placed.has(el));
                if (sumEl && sumSlot) {
                    placed.add(sumEl); used.add(sumSlot.id);
                    sumEl.x = sumSlot.x; sumEl.y = sumSlot.y; sumEl.width = sumSlot.width; sumEl.height = sumSlot.height;
                    if (sumSlot.style) sumEl.style = { ...sumEl.style, ...sumSlot.style };
                    if (importedLayout.slotAnimations?.summary) sumEl.animation = { ...importedLayout.slotAnimations.summary };
                }
                const nextEl = remaining.find(el => /next|closing|action|step/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
                if (nextEl && nextSlot) {
                    placed.add(nextEl); used.add(nextSlot.id);
                    nextEl.x = nextSlot.x; nextEl.y = nextSlot.y; nextEl.width = nextSlot.width; nextEl.height = nextSlot.height;
                    if (nextSlot.style) nextEl.style = { ...nextEl.style, ...nextSlot.style };
                    if (importedLayout.slotAnimations?.nextSteps) nextEl.animation = { ...importedLayout.slotAnimations.nextSteps };
                }
            } else if (layoutId === 'image-focus') {
                const capSlot = placeholders.find(s => s.role === 'caption');
                const imgSlot = placeholders.find(s => s.role === 'image');
                const focusEl = remaining.find(el => /focus/i.test(el.id));
                const followupEl = remaining.find(el => /follow/i.test(el.id));
                if (capSlot) {
                    used.add(capSlot.id);
                    if (focusEl && followupEl && focusEl !== followupEl) {
                        placed.add(focusEl); placed.add(followupEl);
                        focusEl.x = capSlot.x; focusEl.y = capSlot.y; focusEl.width = capSlot.width; focusEl.height = 190;
                        focusEl.style = { ...focusEl.style, fontSize: 19, fontWeight: 600, lineHeight: 1.6 };
                        followupEl.x = capSlot.x; followupEl.y = capSlot.y + 210; followupEl.width = capSlot.width; followupEl.height = capSlot.height - 210;
                        followupEl.style = { ...followupEl.style, fontSize: 16, lineHeight: 1.6 };
                        if (importedLayout.slotAnimations?.caption) {
                            focusEl.animation = { ...importedLayout.slotAnimations.caption };
                            followupEl.animation = { ...importedLayout.slotAnimations.caption, delayMs: (importedLayout.slotAnimations.caption.delayMs || 150) + 120 };
                        }
                    } else {
                        const single = focusEl || followupEl || remaining.find(el => el.type === 'text' && !placed.has(el));
                        if (single) {
                            placed.add(single); single.x = capSlot.x; single.y = capSlot.y; single.width = capSlot.width; single.height = capSlot.height;
                            if (capSlot.style) single.style = { ...single.style, ...capSlot.style };
                            if (importedLayout.slotAnimations?.caption) single.animation = { ...importedLayout.slotAnimations.caption };
                        }
                    }
                }
                const imgEl = remaining.find(el => el.type === 'image' && !placed.has(el));
                if (imgEl && imgSlot) {
                    placed.add(imgEl); used.add(imgSlot.id);
                    imgEl.x = imgSlot.x; imgEl.y = imgSlot.y; imgEl.width = imgSlot.width; imgEl.height = imgSlot.height;
                    if (importedLayout.slotAnimations?.image) imgEl.animation = { ...importedLayout.slotAnimations.image };
                }
            } else if (layoutId === 'quote') {
                const quoteSlot = placeholders.find(s => s.role === 'quote');
                const attrSlot = placeholders.find(s => s.role === 'attribution');
                const quoteEl = remaining.find(el => /quote/i.test(el.id) && el.id !== 'quote_mark') || remaining.find(el => el.type === 'text' && (el.content?.text || '').length > 30 && !placed.has(el));
                if (quoteEl && quoteSlot) {
                    placed.add(quoteEl); used.add(quoteSlot.id);
                    quoteEl.x = quoteSlot.x; quoteEl.y = quoteSlot.y; quoteEl.width = quoteSlot.width; quoteEl.height = quoteSlot.height;
                    if (quoteSlot.style) quoteEl.style = { ...quoteEl.style, ...quoteSlot.style };
                    if (importedLayout.slotAnimations?.quote) quoteEl.animation = { ...importedLayout.slotAnimations.quote };
                }
                const attrEl = remaining.find(el => /attr|author|speaker|note|source/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
                if (attrEl && attrSlot) {
                    placed.add(attrEl); used.add(attrSlot.id);
                    attrEl.x = attrSlot.x; attrEl.y = attrSlot.y; attrEl.width = attrSlot.width; attrEl.height = attrSlot.height;
                    if (attrSlot.style) attrEl.style = { ...attrEl.style, ...attrSlot.style };
                    if (importedLayout.slotAnimations?.attribution) attrEl.animation = { ...importedLayout.slotAnimations.attribution };
                }
                editable = editable.filter(el => el.id !== 'quote_mark');
            } else if (layoutId === 'cover') {
                const subSlot = placeholders.find(s => s.role === 'subtitle');
                if (subSlot) {
                    used.add(subSlot.id);
                    const subtitles = remaining.filter(el => el.type === 'text');
                    if (subtitles.length === 1) {
                        const el = subtitles[0]; placed.add(el);
                        el.x = subSlot.x; el.y = subSlot.y; el.width = subSlot.width; el.height = subSlot.height;
                        if (subSlot.style) el.style = { ...el.style, ...subSlot.style };
                        if (importedLayout.slotAnimations?.subtitle) el.animation = { ...importedLayout.slotAnimations.subtitle };
                    } else if (subtitles.length > 1) {
                        subtitles.forEach((el, idx) => {
                            placed.add(el);
                            if (idx === 0) {
                                el.x = subSlot.x; el.y = subSlot.y; el.width = subSlot.width; el.height = 56;
                                el.style = { ...el.style, fontSize: 22, fontWeight: 600, color: colors.primary || '#1769AA', align: subSlot.style?.align || 'left', lineHeight: 1.4 };
                            } else if (idx === 1) {
                                el.x = subSlot.x; el.y = subSlot.y + 60; el.width = subSlot.width; el.height = 44;
                                el.style = { ...el.style, fontSize: 16, fontWeight: 400, color: colors.text || '#1F2937', align: subSlot.style?.align || 'left', lineHeight: 1.4 };
                            } else {
                                el.x = subSlot.x; el.y = 560 + (idx - 2) * 32; el.width = subSlot.width; el.height = 30;
                                el.style = { ...el.style, fontSize: 14, fontWeight: 400, color: '#64748B', align: subSlot.style?.align || 'left' };
                            }
                            if (importedLayout.slotAnimations?.subtitle) {
                                el.animation = { ...importedLayout.slotAnimations.subtitle, delayMs: (importedLayout.slotAnimations.subtitle.delayMs || 200) + idx * 100 };
                            }
                        });
                    }
                }
            }

            remaining.forEach(el => {
                if (placed.has(el)) return;
                const slot = placeholders.find(item => !used.has(item.id) && item.kind === el.type && item.role !== 'title');
                if (!slot) return;
                used.add(slot.id); placed.add(el);
                el.x = slot.x; el.y = slot.y; el.width = slot.width; el.height = slot.height; el.rotation = slot.rotation || 0;
                if (el.type === 'text' && slot.style && Object.keys(slot.style).length) el.style = { ...el.style, ...slot.style };
                if (slot.role && importedLayout.slotAnimations?.[slot.role]) el.animation = { ...importedLayout.slotAnimations[slot.role] };
            });

            // Only insert placeholders if no content element was provided for that slot
            importedLayout.placeholders.forEach(slot => {
                if (used.has(slot.id)) return;
                if (slot.kind === 'text') {
                    const textRole = slot.role;
                    const placeholderText = textRole === 'right' ? '在此输入右栏内容' : textRole === 'card2' ? '卡片二要点与说明' : textRole === 'card3' ? '卡片三要点与说明' : textRole === 'caption' ? '在此输入图解说明与洞察' : textRole === 'insight' ? '在此提炼核心数据结论' : textRole === 'attribution' ? '—— 来源或作者' : textRole === 'nextSteps' ? '下一步行动与时间计划' : '在此输入内容';
                    const newElem = {
                        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        type: 'text',
                        x: slot.x,
                        y: slot.y,
                        width: slot.width,
                        height: slot.height,
                        rotation: slot.rotation || 0,
                        zIndex: 10,
                        locked: false,
                        visible: true,
                        sourceRefs: [],
                        content: { text: placeholderText },
                        style: {
                            fontFamily: theme?.fonts?.body || 'Microsoft YaHei',
                            fontSize: slot.style?.fontSize || 18,
                            fontWeight: slot.style?.fontWeight || 400,
                            color: slot.style?.color || colors.text || '#1F2937',
                            align: slot.style?.align || 'left',
                            verticalAlign: slot.style?.verticalAlign || 'top',
                            lineHeight: slot.style?.lineHeight || 1.5,
                            italic: false,
                            underline: false,
                            bullet: false,
                            padding: 0,
                            ...(slot.style || {})
                        },
                        animation: { type: 'none', durationMs: 0, delayMs: 0, direction: '' }
                    };
                    used.add(slot.id);
                    editable.push(newElem);
                }
            });
            const masters = template?.definition?.masters || [];
            const master = masters.find(item => item.id === importedLayout.masterId) || null;
            const slideIndex = Math.max(0, state.active?.content?.slides?.indexOf(slide) ?? 0);
            const layers = [...(master?.decorations || []), ...(importedLayout.decorations || [])].map((item, itemIndex) => {
                const cloned = JSON.parse(JSON.stringify(item));
                if (cloned.content?.text) { cloned.content.text = cloned.content.text.replace(/^[★✦]\s*/, ''); }
                return {
                    ...cloned,
                    id: `pivotTemplate_${importedLayout.id || 'default'}_${slideIndex + 1}_${itemIndex + 1}`,
                    zIndex: Number(item.zIndex) || 1,
                    locked: item.locked !== false,
                    sourceRefs: []
                };
            });
            if (master?.background) {
                slide.background = {
                    fill: master.background.fill || slide.background?.fill || theme?.colors?.background || '#FFFFFF',
                    imageAssetRef: master.background.imageAssetRef || '',
                    opacity: master.background.opacity ?? 1
                };
            }
            slide.elements = [...layers, ...editable];
            slide.layoutId = layoutId;
            return;
        }
        const textElements = slide.elements.filter(element => element.type === 'text').sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
        const title = textElements[0];
        const body = textElements.filter(element => element !== title);
        const nonTitle = slide.elements.filter(element => element !== title);
        if (layoutId === 'cover' && title) {
            title.x = 88; title.y = 205; title.width = 1104; title.height = 96; title.style.align = 'center';
            body.forEach((element, index) => { element.x = 180; element.y = 345 + index * 72; element.width = 920; element.height = 54; if (element.type === 'text') element.style.align = 'center'; });
        }
        if (layoutId === 'section' && title) { title.x = 130; title.y = 280; title.width = 1020; title.height = 100; title.style.align = 'center'; title.style.fontSize = Math.max(36, title.style.fontSize); }
        if (layoutId === 'title-content' && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56; title.style.align = 'left';
            body.forEach((element, index) => { element.x = 116; element.y = 165 + index * 120; element.width = 1048; element.height = index ? 150 : 390; });
        }
        if (layoutId === 'two-column' && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56;
            nonTitle.forEach((element, index) => { const column = index % 2; const row = Math.floor(index / 2); element.x = 108 + column * 576; element.y = 165 + row * 250; element.width = 488; element.height = 220; });
        }
        if (layoutId === 'three-card' && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56;
            nonTitle.forEach((element, index) => { element.x = 104 + (index % 3) * 384; element.y = 165 + Math.floor(index / 3) * 240; element.width = 304; element.height = 210; });
        }
        if (layoutId === 'image-focus' && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56;
            nonTitle.forEach((element, index) => { element.x = index === 0 ? 108 : 570; element.y = index === 0 ? 165 : 155; element.width = index === 0 ? 384 : 610; element.height = index === 0 ? 445 : 465; });
        }
        if ((layoutId === 'chart' || layoutId === 'table') && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56;
            nonTitle.forEach((element, index) => { element.x = index === 0 ? 108 : 495; element.y = index === 0 ? 165 : 155; element.width = index === 0 ? 304 : 680; element.height = index === 0 ? 445 : 465; });
        }
        if (layoutId === 'quote') {
            if (title) { title.x = 100; title.y = 50; title.width = 1096; title.height = 56; }
            nonTitle.forEach((element, index) => { element.x = 190; element.y = 200 + index * 200; element.width = 900; element.height = 170; if (element.type === 'text') element.style.align = 'center'; });
        }
        if (layoutId === 'summary' && title) {
            title.x = 100; title.y = 50; title.width = 1096; title.height = 56;
            nonTitle.forEach((element, index) => { element.x = 115; element.y = 160 + index * 160; element.width = 1050; element.height = 125; });
        }
        slide.layoutId = layoutId;
    }

    const PRESENTATION_SVG_ICONS = {
        '💡': { color: '#D8A23A', svg: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/>' },
        '🎯': { color: '#C84A4A', svg: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>' },
        '✦': { color: '#1F5EA8', svg: '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" fill="currentColor"/>' },
        '★': { color: '#D8A23A', svg: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/>' },
        '☑': { color: '#2E8B57', svg: '<rect x="3" y="3" width="18" height="18" rx="4" fill="#E8F5E9" stroke="#2E8B57" stroke-width="2"/><path d="M9 12l2 2 4-4" stroke="#2E8B57" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' },
        '□': { color: '#94A3B8', svg: '<rect x="3" y="3" width="18" height="18" rx="4" fill="#FFFFFF" stroke="#94A3B8" stroke-width="2"/>' },
        '🚀': { color: '#1F5EA8', svg: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>' },
        '📌': { color: '#17A8C7', svg: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-2l-2-2V5a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v8l-2 2v2z"/>' },
        '⚠️': { color: '#D8A23A', svg: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
        '🛡️': { color: '#7A5AF8', svg: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' }
    };

    function renderPresentationTextWithSvgIcons(container, rawText, style = {}, zoom = 1) {
        container.replaceChildren();
        const text = String(rawText || '');
        const lines = text.split('\n');
        const iconKeys = Object.keys(PRESENTATION_SVG_ICONS);
        const hasIcons = iconKeys.some(k => text.includes(k));
        if (!hasIcons) {
            container.textContent = text;
            return;
        }
        lines.forEach(line => {
            const row = document.createElement('div');
            row.className = 'presentation-text-line';
            row.style.display = 'flex';
            row.style.width = '100%';
            row.style.alignItems = 'flex-start';
            row.style.gap = `${6 * zoom}px`;
            row.style.lineHeight = String(style.lineHeight || 1.35);
            if (!line.trim()) {
                row.style.minHeight = `${Math.round(Number(style.fontSize || 18) * zoom * 0.75)}px`;
                container.appendChild(row);
                return;
            }
            let foundKey = null;
            for (const k of iconKeys) {
                if (line.trim().startsWith(k)) { foundKey = k; break; }
            }
            if (foundKey) {
                const def = PRESENTATION_SVG_ICONS[foundKey];
                const iconWrap = document.createElement('span');
                iconWrap.className = 'presentation-svg-icon-wrap';
                iconWrap.style.display = 'inline-flex';
                iconWrap.style.alignItems = 'center';
                iconWrap.style.justifyContent = 'center';
                iconWrap.style.flexShrink = '0';
                const size = Math.max(12, Math.round(Number(style.fontSize || 18) * zoom * 0.95));
                PivotSafeHtml.setHtml(iconWrap, `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:${def.color};">${def.svg}</svg>`);
                const span = document.createElement('span');
                span.style.flex = '1';
                span.style.minWidth = '0';
                span.style.wordBreak = 'break-word';
                span.textContent = line.replace(foundKey, '').trim();
                row.append(iconWrap, span);
            } else {
                row.textContent = line;
            }
            container.appendChild(row);
        });
    }

    window.Pivot?.exposeModule?.('apps.presentations.templates', {
        applyLayoutToSlide,
        buildEmptySlide,
        presentationLayoutLabel,
        ready: true,
        renderTemplatePanel,
        saveAsTemplate,
        submitCurrentTemplateReview,
        reviewCurrentTemplate,
        exportCurrentTemplate,
        downloadCurrentTemplateSource,
        reparseCurrentTemplateSource,
        importTemplatePackage,
        cancelTemplateImport,
        renderTemplates,
        handleTemplateClick,
        renderPresentationTextWithSvgIcons
    });
})();
