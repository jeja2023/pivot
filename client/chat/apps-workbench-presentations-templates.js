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

    window.Pivot?.exposeModule?.('apps.presentations.templates', {
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
        renderTemplates
    });
})();
