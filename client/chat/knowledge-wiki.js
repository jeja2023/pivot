// 知识 LLM Wiki 工作台：只管理派生页面和编译任务，原始资料仍由知识库文档工作台管理。
(() => {
    const request = async (path, options = {}) => {
        const response = await apiFetch(`${API_BASE}${path}`, {
            ...options,
            headers: { ...authHeaders(), ...(options.headers || {}) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) throw new Error(data.error || '知识 Wiki 请求失败');
        return data;
    };

    const text = value => String(value ?? '');
    const byId = id => document.getElementById(id);
    let selectedSpaceId = 0;

    function ensureModal() {
        let modal = byId('knowledge-wiki-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'knowledge-wiki-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
        const panel = document.createElement('section');
        panel.className = 'modal rag-detail-modal knowledge-wiki-modal';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        const header = document.createElement('div');
        header.className = 'rag-detail-header';
        const titleGroup = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = '知识 Wiki 综合';
        const hint = document.createElement('p');
        hint.className = 'model-modal-desc';
        hint.textContent = '综合页由已发布原始资料编译而成；发布前必须保留可访问来源。';
        titleGroup.append(title, hint);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-danger-outline';
        close.textContent = '关闭';
        close.addEventListener('click', () => window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false));
        header.append(titleGroup, close);
        const toolbar = document.createElement('div');
        toolbar.className = 'workspace-toolbar';
        const create = document.createElement('button');
        create.type = 'button'; create.className = 'btn-primary'; create.id = 'knowledge-wiki-create'; create.textContent = '新建 Wiki Space';
        create.addEventListener('click', () => void openWikiSetupForm('space'));
        const importMarkdown = document.createElement('button');
        importMarkdown.type = 'button'; importMarkdown.className = 'btn-secondary'; importMarkdown.id = 'knowledge-wiki-import'; importMarkdown.textContent = '导入 Markdown Wiki';
        importMarkdown.addEventListener('click', () => void openWikiSetupForm('markdown'));
        const compile = document.createElement('button');
        compile.type = 'button'; compile.className = 'btn-secondary'; compile.textContent = '编译当前 Space';
        compile.id = 'knowledge-wiki-compile';
        compile.addEventListener('click', () => void compileSpace());
        toolbar.append(create, importMarkdown, compile);
        const body = document.createElement('div');
        body.id = 'knowledge-wiki-body';
        body.className = 'knowledge-wiki-body';
        panel.append(header, toolbar, body);
        modal.appendChild(panel);
        modal.addEventListener('click', event => { if (event.target === modal) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false); });
        document.body.appendChild(modal);
        setCompileAvailability(false);
        return modal;
    }

    function clear(node) { while (node?.firstChild) node.removeChild(node.firstChild); }
    function appendText(node, tag, value, className = '') {
        const child = document.createElement(tag);
        if (className) child.className = className;
        child.textContent = text(value);
        node.appendChild(child);
        return child;
    }

    function setCompileAvailability(enabled) {
        const compile = byId('knowledge-wiki-compile');
        if (!compile) return;
        compile.disabled = enabled !== true;
        compile.textContent = enabled === true ? '编译当前 Space' : '先新建 Wiki Space';
        compile.title = enabled === true ? '使用当前聊天模型编译选中的 Wiki Space' : '请先新建或选择一个 Wiki Space';
        compile.setAttribute('aria-label', compile.title);
    }

    async function render() {
        const body = byId('knowledge-wiki-body');
        if (!body) return;
        clear(body);
        appendText(body, 'p', '正在加载 Wiki Space…', 'muted-text');
        try {
            const data = await request('/knowledge/wiki/spaces');
            clear(body);
            const spaces = Array.isArray(data.data) ? data.data : [];
            if (!spaces.length) {
                appendText(body, 'p', '暂无 Wiki Space。请先选择一个有权管理的专题库创建。', 'muted-text');
                setCompileAvailability(false);
                return;
            }
            if (!spaces.some(space => Number(space.id) === selectedSpaceId)) selectedSpaceId = Number(spaces[0].id);
            const layout = document.createElement('div');
            layout.className = 'knowledge-wiki-layout';
            const list = document.createElement('div');
            list.className = 'knowledge-wiki-spaces';
            spaces.forEach(space => {
                const button = document.createElement('button');
                button.type = 'button'; button.className = `knowledge-wiki-space${Number(space.id) === selectedSpaceId ? ' active' : ''}`;
                appendText(button, 'strong', space.name);
                appendText(button, 'small', `已发布 ${Number(space.publishedPages || 0)} · 待审核 ${Number(space.pendingPages || 0)} · 已过期 ${Number(space.stalePages || 0)}`);
                button.addEventListener('click', () => { selectedSpaceId = Number(space.id); void render(); });
                list.appendChild(button);
                const configure = document.createElement('button');
                configure.type = 'button'; configure.className = 'btn-secondary'; configure.textContent = space.compilePolicy?.autoCompile ? '自动编译已启用' : '配置自动编译';
                configure.addEventListener('click', event => { event.stopPropagation(); void openAutoCompileForm(space); });
                list.appendChild(configure);
            });
            const detail = document.createElement('div');
            detail.className = 'knowledge-wiki-pages';
            const selectedSpace = spaces.find(space => Number(space.id) === selectedSpaceId) || null;
            const readinessQuery = selectedSpace?.compilePolicy?.autoCompile ? '?requireModel=true' : '';
            const [pagesResult, metricsResult, runsResult, readinessResult] = await Promise.all([
                request(`/knowledge/wiki/spaces/${selectedSpaceId}/pages?limit=100`),
                request(`/knowledge/wiki/spaces/${selectedSpaceId}/metrics?lookbackDays=30`),
                request(`/knowledge/wiki/spaces/${selectedSpaceId}/runs?limit=8`),
                request(`/knowledge/wiki/spaces/${selectedSpaceId}/compile-readiness${readinessQuery}`)
            ]);
            const pages = Array.isArray(pagesResult.data) ? pagesResult.data : [];
            appendText(detail, 'h4', '页面与审核');
            const metrics = metricsResult.metrics || {};
            appendText(detail, 'p', `已发布 ${Number(metrics.pages?.published || 0)} · 待审核 ${Number(metrics.pages?.review || 0)} · 已失效 ${Number(metrics.pages?.stale || 0)} · 近 30 天编译完成 ${Number(metrics.compileRuns?.completed || 0)} · 评测 ${Number(metrics.evaluation?.totalResults || 0)} 条`, 'muted-text');
            const readiness = readinessResult.readiness || {};
            const readinessText = readiness.ready
                ? `编译前检查通过：可用原始资料区块 ${Number(readiness.sourceBlocks || 0)}${readiness.model?.name ? ` · 自动模型 ${readiness.model.name}` : ''}`
                : `编译前检查未通过：${(readiness.messages || []).join('；') || '请检查原始资料和模型设置。'}`;
            appendText(detail, 'p', readinessText, readiness.ready ? 'knowledge-wiki-diagnostic is-ready' : 'knowledge-wiki-diagnostic is-error');
            const runs = Array.isArray(runsResult.data) ? runsResult.data : [];
            if (runs.length) {
                appendText(detail, 'h4', '最近编译任务');
                runs.forEach(run => {
                    const runItem = document.createElement('div'); runItem.className = `knowledge-wiki-page status-${text(run.status)}`;
                    appendText(runItem, 'span', `${run.status} · ${run.stage} · ${run.completedAt || run.createdAt || ''}`, 'muted-text');
                    if (run.status === 'failed') {
                        appendText(runItem, 'p', `失败原因：${run.errorMessage || '编译任务失败，请检查模型服务、原始资料和运行日志后重试。'}`, 'knowledge-wiki-run-error');
                    }
                    if (['queued', 'running'].includes(run.status)) {
                        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = '取消';
                        cancel.addEventListener('click', () => void cancelRun(run.id)); runItem.appendChild(cancel);
                    }
                    detail.appendChild(runItem);
                });
            }
            if (!pages.length) appendText(detail, 'p', '尚无候选页面。选择模型后点击“编译当前 Space”生成待审核草稿。', 'muted-text');
            pages.forEach(page => {
                const item = document.createElement('article');
                item.className = `knowledge-wiki-page status-${text(page.status)}`;
                appendText(item, 'strong', page.title);
                appendText(item, 'span', `${page.pageType} · ${page.status} · 来源 ${Number(page.sourceCoverage?.sourceCount || 0)} · 冲突 ${Number(page.sourceCoverage?.conflictCount || 0)}`, 'muted-text');
                if (page.summary) appendText(item, 'p', page.summary);
                const actions = document.createElement('div');
                actions.className = 'rag-actions';
                const view = document.createElement('button'); view.type = 'button'; view.className = 'btn-secondary'; view.textContent = '查看来源';
                view.addEventListener('click', () => void openPage(page.id)); actions.appendChild(view);
                if (page.status === 'review' || page.status === 'draft') {
                    const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'btn-primary'; publish.textContent = '发布';
                    publish.addEventListener('click', () => void publishPage(page.id)); actions.appendChild(publish);
                }
                item.appendChild(actions); detail.appendChild(item);
            });
            layout.append(list, detail); body.appendChild(layout);
            setCompileAvailability(true);
        } catch (error) {
            clear(body); appendText(body, 'p', error.message || '加载知识 Wiki 失败。', 'text-danger'); setCompileAvailability(false);
        }
    }

    function createSetupField(labelText, input, fieldId = '') {
        const field = document.createElement('div');
        field.className = 'form-item knowledge-wiki-setup-field';
        const label = document.createElement('label');
        label.className = 'knowledge-wiki-setup-label';
        label.textContent = text(labelText);
        const resolvedId = fieldId || input.id;
        if (resolvedId) {
            input.id = resolvedId;
            label.htmlFor = resolvedId;
        }
        field.append(label, input);
        return field;
    }

    function createSetupInput({ id = '', type = 'text', placeholder = '', value = '' } = {}) {
        const input = document.createElement('input');
        if (id) input.id = id;
        input.type = type;
        input.className = 'form-input';
        input.placeholder = placeholder;
        input.value = value;
        return input;
    }

    async function getWritableCollections() {
        const data = await request('/rag/collections');
        const canManageAll = typeof isSuperAdminUser === 'function' && isSuperAdminUser();
        return (Array.isArray(data.data) ? data.data : []).filter(collection => collection
            && Number.isSafeInteger(Number(collection.id)) && Number(collection.id) > 0
            && (collection.can_edit === true || canManageAll));
    }

    async function openWikiSetupForm(kind) {
        const body = byId('knowledge-wiki-body');
        if (!body) return;
        clear(body);
        appendText(body, 'p', '正在加载可管理的专题库…', 'muted-text');
        let collections = [];
        try {
            collections = await getWritableCollections();
        } catch (error) {
            clear(body); appendText(body, 'p', error.message || '无法加载可管理的专题库。', 'text-danger');
            return;
        }
        clear(body);
        const isMarkdownImport = kind === 'markdown';
        appendText(body, 'h4', isMarkdownImport ? '导入只读 Markdown Wiki' : '新建 Wiki Space');
        appendText(body, 'p', isMarkdownImport
            ? '外部目录只会被只读扫描和版本化投影，不会向源目录写回任何内容。'
            : 'Wiki Space 绑定一个专题库；综合页始终回链到原始资料，不能替代原始依据。', 'muted-text');
        if (!collections.length) {
            appendText(body, 'p', '没有可管理的专题库。请先在知识库中创建专题库，或联系其所有者授予管理权限。', 'text-danger');
            const back = document.createElement('button');
            back.type = 'button'; back.className = 'btn-secondary'; back.textContent = '返回 Wiki 列表';
            back.addEventListener('click', () => void render()); body.appendChild(back);
            return;
        }
        const form = document.createElement('form');
        form.className = 'knowledge-wiki-setup-form';
        const collection = document.createElement('select');
        collection.id = 'knowledge-wiki-setup-collection';
        collection.className = 'form-input';
        collection.setAttribute('aria-label', '绑定专题库');
        const currentCollectionId = Number(byId('rag-collection-filter')?.value || 0);
        collections.forEach(item => {
            const option = document.createElement('option');
            option.value = String(item.id);
            option.textContent = `${item.name || `专题库 ${item.id}`}（${Number(item.doc_count || 0)} 份资料）`;
            option.selected = Number(item.id) === currentCollectionId;
            collection.appendChild(option);
        });
        form.appendChild(createSetupField('绑定专题库', collection, 'knowledge-wiki-setup-collection'));
        const name = createSetupInput({
            id: 'knowledge-wiki-setup-name',
            placeholder: isMarkdownImport ? '例如：研发手册 Markdown Wiki' : '例如：研发知识综合',
            value: isMarkdownImport ? '外部 Markdown Wiki' : ''
        });
        form.appendChild(createSetupField(isMarkdownImport ? '数据源名称' : 'Wiki Space 名称', name, 'knowledge-wiki-setup-name'));
        let rootPath = null;
        if (isMarkdownImport) {
            rootPath = createSetupInput({
                id: 'knowledge-wiki-setup-root-path',
                placeholder: '已列入 KNOWLEDGE_LOCAL_SOURCE_ROOTS 白名单的目录'
            });
            form.appendChild(createSetupField('只读目录', rootPath, 'knowledge-wiki-setup-root-path'));
        }
        const status = appendText(form, 'p', '', 'knowledge-wiki-setup-status');
        status.hidden = true;
        const actions = document.createElement('div');
        actions.className = 'knowledge-wiki-setup-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'btn-secondary knowledge-wiki-setup-cancel-btn'; cancel.textContent = '取消';
        cancel.addEventListener('click', () => void render());
        const submit = document.createElement('button');
        submit.type = 'submit'; submit.className = 'btn-primary knowledge-wiki-setup-submit-btn'; submit.textContent = isMarkdownImport ? '导入并同步' : '创建 Wiki Space';
        actions.append(cancel, submit); form.appendChild(actions); body.appendChild(form);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const collectionId = Number(collection.value || 0);
            const sourceName = text(name.value).trim();
            const sourcePath = text(rootPath?.value).trim();
            if (!Number.isSafeInteger(collectionId) || collectionId <= 0 || !sourceName || (isMarkdownImport && !sourcePath)) {
                status.hidden = false;
                status.textContent = isMarkdownImport ? '请选择专题库，并填写数据源名称和白名单目录。' : '请选择专题库并填写 Wiki Space 名称。';
                return;
            }
            [collection, name, rootPath, submit, cancel].filter(Boolean).forEach(control => { control.disabled = true; });
            status.hidden = false; status.textContent = isMarkdownImport ? '正在创建只读数据源并同步…' : '正在创建 Wiki Space…';
            try {
                if (isMarkdownImport) {
                    const created = await request('/knowledge/sources', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ kind: 'wiki_markdown', name: sourceName, collectionId, syncMode: 'manual', config: { rootPath: sourcePath, recursive: true, syncDeletes: true } })
                    });
                    await request(`/knowledge/sources/${created.source.id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    showToast('外部 Markdown Wiki 已加入只读同步队列，页面将保持与正式资料隔离。');
                    await render();
                    return;
                }
                const data = await request('/knowledge/wiki/spaces', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId, name: sourceName })
                });
                selectedSpaceId = Number(data.space.id);
                showToast('Wiki Space 已创建，选择聊天模型后即可编译。');
                await render();
            } catch (error) {
                [collection, name, rootPath, submit, cancel].filter(Boolean).forEach(control => { control.disabled = false; });
                status.textContent = error.message || (isMarkdownImport ? '导入外部 Markdown Wiki 失败' : '创建 Wiki Space 失败');
            }
        });
        name.focus();
    }

    async function compileSpace() {
        if (!selectedSpaceId) {
            showToast('请先新建或选择一个 Wiki Space。', 'warning');
            return;
        }
        try {
            const model = text(byId('model-selector')?.value).trim();
            if (!model) {
                showToast('请先在聊天输入框选择用于编译的模型。', 'warning');
                return;
            }
            const data = await request(`/knowledge/wiki/spaces/${selectedSpaceId}/compile`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model })
            });
            showToast(`Wiki 编译任务已创建：${data.run.id}`); window.setTimeout(() => void render(), 1200);
        } catch (error) { showToast(error.message || '启动 Wiki 编译失败', 'error'); }
    }

    function wikiCompilerModelLabel(model = {}) {
        const name = text(model.name || model.model_name || `模型 ${model.id}`);
        const modelName = text(model.model_name);
        return modelName && modelName !== name ? `${name}（${modelName}）` : name;
    }

    async function getAvailableWikiCompilerModels() {
        const data = await request('/models/available');
        const items = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
        return items.filter(model => model?.type === 'chat'
            && Number.isSafeInteger(Number(model.id)) && Number(model.id) > 0);
    }

    async function openAutoCompileForm(space) {
        const body = byId('knowledge-wiki-body');
        if (!body || !space?.id) return;
        clear(body);
        appendText(body, 'p', '正在加载当前账号可用于编译的模型…', 'muted-text');
        let models = [];
        try {
            models = await getAvailableWikiCompilerModels();
        } catch (error) {
            clear(body); appendText(body, 'p', error.message || '加载可用模型失败。', 'text-danger');
            return;
        }
        clear(body);
        appendText(body, 'h4', '配置自动编译');
        appendText(body, 'p', '仅可选择当前账号已获授权、可运行的对话模型。启用后，资料变更会创建后台编译任务；不会使用未明确指定的聊天默认模型。', 'muted-text');
        const form = document.createElement('form');
        form.className = 'knowledge-wiki-setup-form';
        const modelSelect = document.createElement('select');
        modelSelect.className = 'form-input';
        modelSelect.setAttribute('aria-label', '自动编译模型');
        const disabledOption = document.createElement('option');
        disabledOption.value = '';
        disabledOption.textContent = '关闭自动编译（仅标记过期，不自动创建任务）';
        modelSelect.appendChild(disabledOption);
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = String(model.id);
            option.textContent = wikiCompilerModelLabel(model);
            modelSelect.appendChild(option);
        });
        const currentModelRef = text(space.compilePolicy?.modelRef).trim();
        const selectedModel = models.find(model => String(model.id) === currentModelRef || text(model.model_name) === currentModelRef);
        if (selectedModel) modelSelect.value = String(selectedModel.id);
        else if (currentModelRef) {
            const unavailable = document.createElement('option');
            unavailable.value = '__unavailable__';
            unavailable.disabled = true;
            unavailable.selected = true;
            unavailable.textContent = '当前配置的模型已不可访问，请重新选择';
            modelSelect.appendChild(unavailable);
        }
        form.appendChild(createSetupField('自动编译模型', modelSelect));
        if (!models.length) appendText(form, 'p', '当前没有可用于编译的模型。请先在模型管理中配置并授权一个对话模型。', 'text-danger');
        const status = appendText(form, 'p', '', 'knowledge-wiki-setup-status');
        status.hidden = true;
        const actions = document.createElement('div');
        actions.className = 'rag-actions';
        const submit = document.createElement('button');
        submit.type = 'submit'; submit.className = 'btn-primary'; submit.textContent = '保存设置';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = '取消';
        cancel.addEventListener('click', () => void render());
        actions.append(submit, cancel); form.appendChild(actions); body.appendChild(form);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const modelRef = text(modelSelect.value).trim();
            if (modelRef === '__unavailable__') {
                status.hidden = false;
                status.textContent = '当前配置的模型不可访问，请从下拉列表重新选择或关闭自动编译。';
                return;
            }
            if (modelRef && !models.some(model => String(model.id) === modelRef)) {
                status.hidden = false;
                status.textContent = '请选择下拉列表中的可用模型。';
                return;
            }
            [modelSelect, submit, cancel].forEach(control => { control.disabled = true; });
            status.hidden = false; status.textContent = '正在保存自动编译设置…';
            try {
                const compilePolicy = { ...(space.compilePolicy || {}), modelRef, autoCompile: Boolean(modelRef) };
                await request(`/knowledge/wiki/spaces/${space.id}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ compilePolicy })
                });
                showToast(compilePolicy.autoCompile ? '资料变更后将按所选模型创建增量 Wiki 编译任务。' : '已关闭该 Space 的自动编译。');
                await render();
            } catch (error) {
                [modelSelect, submit, cancel].forEach(control => { control.disabled = false; });
                status.textContent = error.message || '更新自动编译配置失败';
            }
        });
        modelSelect.focus();
    }

    async function publishPage(pageId) {
        try {
            await request(`/knowledge/wiki/pages/${pageId}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            showToast('Wiki 页面已发布。'); await render();
        } catch (error) { showToast(error.message || '发布失败：请确认来源完整且不存在冲突。', 'error'); }
    }

    async function cancelRun(runId) {
        try {
            await request(`/knowledge/wiki/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            showToast('Wiki 编译任务已取消。'); await render();
        } catch (error) { showToast(error.message || '取消编译任务失败', 'error'); }
    }

    async function openPage(pageId) {
        try {
            const [data, versionsResult] = await Promise.all([
                request(`/knowledge/wiki/pages/${pageId}`),
                request(`/knowledge/wiki/pages/${pageId}/versions?limit=20`)
            ]);
            const body = byId('knowledge-wiki-body'); if (!body) return;
            clear(body); appendText(body, 'h4', data.page.title); appendText(body, 'pre', data.page.markdown || '', 'knowledge-wiki-markdown');
            appendText(body, 'h4', '原始来源');
            (data.sources || []).forEach(source => appendText(body, 'p', `${source.title} v${source.versionNo}${source.headingPath ? ` / ${source.headingPath}` : ''} · ${source.supportType}`));
            const versions = Array.isArray(versionsResult.data) ? versionsResult.data : [];
            if (versions.length > 1) {
                appendText(body, 'h4', '版本差异');
                const actions = document.createElement('div'); actions.className = 'rag-actions';
                versions.filter(version => Number(version.id) !== Number(pageId)).forEach(version => {
                    const diff = document.createElement('button'); diff.type = 'button'; diff.className = 'btn-secondary'; diff.textContent = `与 v${version.versionNo} 对比`;
                    diff.addEventListener('click', () => void openDiff(pageId, version.id)); actions.appendChild(diff);
                });
                body.appendChild(actions);
            }
            const back = document.createElement('button'); back.type = 'button'; back.className = 'btn-secondary'; back.textContent = '返回列表'; back.addEventListener('click', () => void render()); body.appendChild(back);
        } catch (error) { showToast(error.message || '读取 Wiki 页面失败', 'error'); }
    }

    async function openDiff(pageId, fromPageId) {
        try {
            const data = await request(`/knowledge/wiki/pages/${pageId}/diff?fromPageId=${encodeURIComponent(fromPageId)}&toPageId=${encodeURIComponent(pageId)}`);
            const body = byId('knowledge-wiki-body'); if (!body) return;
            const diffText = (data.diff?.changes || []).map(change => `${change.type === 'added' ? '+' : '-'} ${change.line}: ${change.text}`).join('\n') || '两个版本没有可展示的文本差异。';
            appendText(body, 'h4', `版本差异：v${fromPageId} → 当前`);
            appendText(body, 'pre', diffText, 'knowledge-wiki-markdown');
        } catch (error) { showToast(error.message || '读取版本差异失败', 'error'); }
    }

    document.addEventListener('click', event => {
        if (event.target?.closest?.('#knowledge-wiki-open')) {
            const modal = ensureModal(); window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true); void render();
        }
    });
    window.Pivot.exposeModule('knowledge.wiki', { open: () => byId('knowledge-wiki-open')?.click(), refresh: render });
})();
