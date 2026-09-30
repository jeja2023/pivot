// 知识 LLM Wiki 工作台：只管理派生页面和编译任务，原始资料仍由知识库文档工作台管理。
(() => {
    const request = async (path, options = {}) => {
        const response = await apiFetch(`${API_BASE}${path}`, {
            ...options,
            headers: { ...authHeaders(), ...(options.headers || {}) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) throw new Error(data.error || '知识库综合页请求失败');
        return data;
    };

    const text = value => String(value ?? '');
    const byId = id => document.getElementById(id);
    let selectedSpaceId = 0;
    let refreshTimer = null;
    const pageTypeLabels = {
        overview: '概览页', topic: '主题页', entity: '实体页', concept: '概念页',
        conflict: '冲突页', change_digest: '变更摘要页'
    };
    const pageStatusLabels = {
        draft: '草稿', review: '待审核', published: '已发布', stale: '已失效',
        superseded: '已被新版本替代', deleted: '已删除'
    };
    const runStatusLabels = {
        queued: '等待执行', running: '正在编译', completed: '编译完成', failed: '编译失败', cancelled: '已取消'
    };
    const runStageLabels = {
        queued: '等待执行', collecting_sources: '收集原始资料', generating_candidate: '生成候选页面',
        validating_sources: '核验来源与结构', awaiting_review: '等待人工审核', completed: '编译完成',
        failed: '编译失败', cancelled: '已取消'
    };
    const runTriggerLabels = {
        manual: '手动编译', source_changed: '资料变更', source_reindexed: '资料重建',
        manual_version_published: '版本发布', source_archived: '资料归档', source_deleted: '资料删除',
        source_sync_deleted: '来源同步删除', scheduled: '定时任务', review_retry: '审核重试', full_rebuild: '完整重建'
    };
    const validationReasonLabels = {
        invalid_json_structure: '未识别到 JSON 页面结构', missing_title: '缺少页面标题',
        invalid_markdown: '正文不符合安全格式', missing_valid_source_refs: '来源未匹配本轮资料'
    };
    const supportTypeLabels = {
        supports: '支持依据', defines: '概念定义', contradicts: '冲突矛盾',
        supersedes: '更新替代', background: '背景参考'
    };
    const verifiedStatusLabels = {
        verified: '已核验', auto_checked: '自动核验', human_verified: '人工核验',
        pending: '待确认', unverified: '未核验', invalid: '已失效', conflict: '存疑冲突',
        expired: '已过期'
    };

    function wikiPageTypeLabel(value) { return pageTypeLabels[text(value)] || '综合页面'; }
    function wikiPageStatusLabel(value) { return pageStatusLabels[text(value)] || '状态未知'; }
    function wikiRunStatusLabel(value) { return runStatusLabels[text(value)] || '状态未知'; }
    function wikiRunStageLabel(value) { return runStageLabels[text(value)] || '处理中'; }
    function wikiRunTriggerLabel(value) { return runTriggerLabels[text(value)] || '后台任务'; }
    function wikiSupportTypeLabel(value) { return supportTypeLabels[text(value)] || text(value) || '引用来源'; }
    function wikiVerifiedStatusLabel(value) { return verifiedStatusLabels[text(value)] || text(value) || '已校验'; }
    function wikiValidationSummary(value) {
        const validation = value && typeof value === 'object' ? value : {};
        const rejected = validation.rejected && typeof validation.rejected === 'object' ? validation.rejected : {};
        const reasons = Object.entries(rejected).map(([reason, count]) => `${validationReasonLabels[reason] || '其他校验未通过'} ${Number(count || 0)} 项`);
        if (!Number(validation.receivedCandidates || 0) && !reasons.length) return '';
        return `候选页面 ${Number(validation.receivedCandidates || 0)} 个 · 通过 ${Number(validation.acceptedCandidates || 0)} 个${reasons.length ? ` · ${reasons.join('，')}` : ''}`;
    }

    function clearScheduledRefresh() {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    function scheduleActiveRunRefresh() {
        clearScheduledRefresh();
        refreshTimer = window.setTimeout(() => {
            refreshTimer = null;
            const modal = byId('knowledge-wiki-modal');
            if (modal && !modal.classList.contains('hidden')) void render();
        }, 2500);
    }

    function closeWikiModal(modal) {
        clearScheduledRefresh();
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
    }

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
        title.textContent = '知识库综合页';
        const hint = document.createElement('p');
        hint.className = 'model-modal-desc';
        hint.textContent = '综合页由已发布原始资料编译而成；发布前必须保留可访问来源。';
        titleGroup.append(title, hint);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-danger-outline';
        close.textContent = '关闭';
        close.addEventListener('click', () => closeWikiModal(modal));
        header.append(titleGroup, close);
        const toolbar = document.createElement('div');
        toolbar.className = 'workspace-toolbar';
        const create = document.createElement('button');
        create.type = 'button'; create.className = 'btn-primary'; create.id = 'knowledge-wiki-create'; create.textContent = '新建知识空间';
        create.addEventListener('click', () => void openWikiSetupForm('space'));
        const importMarkdown = document.createElement('button');
        importMarkdown.type = 'button'; importMarkdown.className = 'btn-secondary'; importMarkdown.id = 'knowledge-wiki-import'; importMarkdown.textContent = '导入 Markdown 文档库';
        importMarkdown.addEventListener('click', () => void openWikiSetupForm('markdown'));
        const compile = document.createElement('button');
        compile.type = 'button'; compile.className = 'btn-secondary'; compile.textContent = '编译当前空间';
        compile.id = 'knowledge-wiki-compile';
        compile.addEventListener('click', () => void compileSpace());
        toolbar.append(create, importMarkdown, compile);
        const body = document.createElement('div');
        body.id = 'knowledge-wiki-body';
        body.className = 'knowledge-wiki-body';
        panel.append(header, toolbar, body);
        modal.appendChild(panel);
        modal.addEventListener('click', event => { if (event.target === modal) closeWikiModal(modal); });
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
        compile.textContent = enabled === true ? '编译当前空间' : '先新建知识空间';
        compile.title = enabled === true ? '使用当前聊天模型编译选中的知识空间' : '请先新建或选择一个知识空间';
        compile.setAttribute('aria-label', compile.title);
    }

    async function render() {
        const body = byId('knowledge-wiki-body');
        if (!body) return;
        clear(body);
        appendText(body, 'p', '正在加载知识空间…', 'muted-text');
        try {
            const data = await request('/knowledge/wiki/spaces');
            clear(body);
            const spaces = Array.isArray(data.data) ? data.data : [];
            if (!spaces.length) {
                appendText(body, 'p', '暂无知识空间。请先选择一个有管理权的专题库创建。', 'muted-text');
                setCompileAvailability(false);
                return;
            }
            if (!spaces.some(space => Number(space.id) === selectedSpaceId)) selectedSpaceId = Number(spaces[0].id);
            const layout = document.createElement('div');
            layout.className = 'knowledge-wiki-layout';
            const list = document.createElement('div');
            list.className = 'knowledge-wiki-spaces';
            spaces.forEach(space => {
                const spaceCard = document.createElement('div');
                spaceCard.className = `knowledge-wiki-space-card${Number(space.id) === selectedSpaceId ? ' active' : ''}`;
                const spaceInfo = document.createElement('div');
                spaceInfo.className = 'knowledge-wiki-space-info';
                appendText(spaceInfo, 'strong', space.name);
                appendText(spaceInfo, 'small', `已发布 ${Number(space.publishedPages || 0)} · 待审核 ${Number(space.pendingPages || 0)} · 已失效 ${Number(space.stalePages || 0)}`);
                spaceInfo.addEventListener('click', () => { selectedSpaceId = Number(space.id); void render(); });
                spaceCard.appendChild(spaceInfo);
                const configure = document.createElement('button');
                configure.type = 'button';
                configure.className = `space-config-btn${space.compilePolicy?.autoCompile ? ' is-enabled' : ''}`;
                configure.textContent = space.compilePolicy?.autoCompile ? '自动编译已启用' : '配置自动编译';
                configure.addEventListener('click', event => { event.stopPropagation(); void openAutoCompileForm(space); });
                spaceCard.appendChild(configure);
                list.appendChild(spaceCard);
            });
            const detail = document.createElement('div');
            detail.id = 'knowledge-wiki-pages-pane';
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
            const sectionHeader = document.createElement('div');
            sectionHeader.className = 'knowledge-wiki-section-header';
            const sectionTitle = document.createElement('h4');
            sectionTitle.className = 'knowledge-wiki-section-title';
            sectionTitle.textContent = '页面与审核';
            const metrics = metricsResult.metrics || {};
            const metricsDesc = document.createElement('p');
            metricsDesc.className = 'muted-text';
            metricsDesc.textContent = `已发布 ${Number(metrics.pages?.published || 0)} · 待审核 ${Number(metrics.pages?.review || 0)} · 已失效 ${Number(metrics.pages?.stale || 0)} · 近 30 天编译完成 ${Number(metrics.compileRuns?.completed || 0)} · 评测 ${Number(metrics.evaluation?.totalResults || 0)} 条`;
            sectionHeader.append(sectionTitle, metricsDesc);
            detail.appendChild(sectionHeader);

            const readiness = readinessResult.readiness || {};
            const readinessText = readiness.ready
                ? `编译前检查通过：可用原始资料区块 ${Number(readiness.sourceBlocks || 0)}${readiness.model?.name ? ` · 自动模型 ${readiness.model.name}` : ''}`
                : `编译前检查未通过：${(readiness.messages || []).join('；') || '请检查原始资料和模型设置。'}`;
            const diag = document.createElement('div');
            diag.className = `knowledge-wiki-diagnostic ${readiness.ready ? 'is-ready' : 'is-error'}`;
            diag.textContent = readinessText;
            detail.appendChild(diag);

            const runs = Array.isArray(runsResult.data) ? runsResult.data : [];
            if (runs.length) {
                appendText(detail, 'h4', '最近编译任务', 'knowledge-wiki-subhead');
                const taskList = document.createElement('div');
                taskList.className = 'knowledge-wiki-task-list';
                runs.forEach(run => {
                    const runItem = document.createElement('div');
                    runItem.className = `knowledge-wiki-task-card status-${text(run.status)}`;
                    const headerRow = document.createElement('div');
                    headerRow.className = 'knowledge-wiki-task-header';

                    const statusBadge = document.createElement('span');
                    const statusClass = run.status === 'completed' ? 'tag-success' : run.status === 'failed' ? 'tag-danger' : ['queued', 'running'].includes(run.status) ? 'tag-primary' : 'tag-neutral';
                    statusBadge.className = `wiki-tag ${statusClass}`;
                    statusBadge.textContent = wikiRunStatusLabel(run.status);

                    const metaSpan = document.createElement('span');
                    metaSpan.className = 'knowledge-wiki-task-meta';
                    const status = wikiRunStatusLabel(run.status);
                    const stage = wikiRunStageLabel(run.stage);
                    const trigger = wikiRunTriggerLabel(run.triggerType);
                    metaSpan.textContent = `${stage === status ? '' : `${stage} · `}${trigger} · ${run.completedAt || run.createdAt || ''}`;

                    headerRow.append(statusBadge, metaSpan);
                    if (['queued', 'running'].includes(run.status)) {
                        const cancel = document.createElement('button');
                        cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = '取消';
                        cancel.addEventListener('click', () => void cancelRun(run.id)); headerRow.appendChild(cancel);
                    }
                    runItem.appendChild(headerRow);
                    if (run.status === 'failed') {
                        const errP = document.createElement('p');
                        errP.className = 'knowledge-wiki-run-error';
                        errP.textContent = `失败原因：${run.errorMessage || '编译任务失败，请检查模型服务、原始资料和运行日志后重试。'}`;
                        runItem.appendChild(errP);
                        const validation = wikiValidationSummary(run.summary?.validation);
                        if (validation) {
                            const valP = document.createElement('p');
                            valP.className = 'knowledge-wiki-run-error';
                            valP.textContent = `校验摘要：${validation}`;
                            runItem.appendChild(valP);
                        }
                    }
                    taskList.appendChild(runItem);
                });
                detail.appendChild(taskList);
                if (runs.some(run => ['queued', 'running'].includes(run.status))) scheduleActiveRunRefresh();
            }

            appendText(detail, 'h4', '综合页面列表', 'knowledge-wiki-subhead');
            if (!pages.length) appendText(detail, 'p', '尚无候选页面。选择模型后点击“编译当前空间”生成待审核草稿。', 'muted-text');
            const pagesList = document.createElement('div');
            pagesList.className = 'knowledge-wiki-page-list-wrap';
            pages.forEach(page => {
                const item = document.createElement('article');
                item.className = `knowledge-wiki-page-card status-${text(page.status)}`;

                const cardHeader = document.createElement('div');
                cardHeader.className = 'knowledge-wiki-page-card-header';
                const cardTitle = document.createElement('strong');
                cardTitle.className = 'knowledge-wiki-page-card-title';
                cardTitle.textContent = page.title;
                cardTitle.title = page.title;

                const badgeGroup = document.createElement('div');
                badgeGroup.className = 'knowledge-wiki-badge-group';
                const typeTag = document.createElement('span');
                typeTag.className = `wiki-tag ${page.pageType === 'conflict' ? 'tag-warning' : page.pageType === 'overview' ? 'tag-primary' : 'tag-neutral'}`;
                typeTag.textContent = wikiPageTypeLabel(page.pageType);
                const statusTag = document.createElement('span');
                statusTag.className = `wiki-tag ${page.status === 'published' ? 'tag-success' : page.status === 'review' ? 'tag-primary' : page.status === 'stale' ? 'tag-warning' : 'tag-neutral'}`;
                statusTag.textContent = wikiPageStatusLabel(page.status);
                badgeGroup.append(typeTag, statusTag);
                cardHeader.append(cardTitle, badgeGroup);
                item.appendChild(cardHeader);

                const metaRow = document.createElement('div');
                metaRow.className = 'knowledge-wiki-page-card-meta';
                const sourceCount = Number(page.sourceCoverage?.sourceCount || 0);
                const sourceChip = document.createElement('span');
                sourceChip.className = 'wiki-meta-chip';
                sourceChip.textContent = `原始来源 ${sourceCount} 条`;
                metaRow.appendChild(sourceChip);

                const conflictCount = Number(page.sourceCoverage?.conflictCount || 0);
                if (conflictCount > 0) {
                    const conflictChip = document.createElement('span');
                    conflictChip.className = 'wiki-meta-chip chip-warning';
                    conflictChip.textContent = `冲突 ${conflictCount} 项`;
                    metaRow.appendChild(conflictChip);
                }
                item.appendChild(metaRow);

                if (page.summary) {
                    const descP = document.createElement('p');
                    descP.className = 'knowledge-wiki-page-card-desc';
                    descP.textContent = page.summary;
                    item.appendChild(descP);
                }

                const actions = document.createElement('div');
                actions.className = 'knowledge-wiki-page-card-actions';
                const view = document.createElement('button');
                view.type = 'button'; view.className = 'btn-secondary'; view.textContent = '查看来源';
                view.addEventListener('click', () => void openPage(page.id)); actions.appendChild(view);
                if (page.status === 'review' || page.status === 'draft') {
                    const publish = document.createElement('button');
                    publish.type = 'button'; publish.className = 'btn-primary'; publish.textContent = '发布';
                    publish.addEventListener('click', () => void publishPage(page.id)); actions.appendChild(publish);
                }
                item.appendChild(actions);
                pagesList.appendChild(item);
            });
            detail.appendChild(pagesList);
            layout.append(list, detail);
            body.appendChild(layout);
            setCompileAvailability(true);
        } catch (error) {
            clear(body); appendText(body, 'p', error.message || '加载知识库综合页失败。', 'text-danger'); setCompileAvailability(false);
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
        clearScheduledRefresh();
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
        appendText(body, 'h4', isMarkdownImport ? '导入只读 Markdown 文档库' : '新建知识空间');
        appendText(body, 'p', isMarkdownImport
            ? '外部目录只会被只读扫描和版本化投影，不会向源目录写回任何内容。'
            : '知识空间绑定一个专题库；综合页始终回链到原始资料，不能替代原始依据。', 'muted-text');
        if (!collections.length) {
            appendText(body, 'p', '没有可管理的专题库。请先在知识库中创建专题库，或联系其所有者授予管理权限。', 'text-danger');
            const back = document.createElement('button');
            back.type = 'button'; back.className = 'btn-secondary'; back.textContent = '返回知识空间列表';
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
            placeholder: isMarkdownImport ? '例如：研发手册 Markdown 文档库' : '例如：研发知识综合',
            value: isMarkdownImport ? '外部 Markdown 文档库' : ''
        });
        form.appendChild(createSetupField(isMarkdownImport ? '数据源名称' : '知识空间名称', name, 'knowledge-wiki-setup-name'));
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
        submit.type = 'submit'; submit.className = 'btn-primary knowledge-wiki-setup-submit-btn'; submit.textContent = isMarkdownImport ? '导入并同步' : '创建知识空间';
        actions.append(cancel, submit); form.appendChild(actions); body.appendChild(form);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const collectionId = Number(collection.value || 0);
            const sourceName = text(name.value).trim();
            const sourcePath = text(rootPath?.value).trim();
            if (!Number.isSafeInteger(collectionId) || collectionId <= 0 || !sourceName || (isMarkdownImport && !sourcePath)) {
                status.hidden = false;
                status.textContent = isMarkdownImport ? '请选择专题库，并填写数据源名称和白名单目录。' : '请选择专题库并填写知识空间名称。';
                return;
            }
            [collection, name, rootPath, submit, cancel].filter(Boolean).forEach(control => { control.disabled = true; });
            status.hidden = false; status.textContent = isMarkdownImport ? '正在创建只读数据源并同步…' : '正在创建知识空间…';
            try {
                if (isMarkdownImport) {
                    const created = await request('/knowledge/sources', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ kind: 'wiki_markdown', name: sourceName, collectionId, syncMode: 'manual', config: { rootPath: sourcePath, recursive: true, syncDeletes: true } })
                    });
                    await request(`/knowledge/sources/${created.source.id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                    showToast('外部 Markdown 文档库已加入只读同步队列，页面将保持与正式资料隔离。');
                    await render();
                    return;
                }
                const data = await request('/knowledge/wiki/spaces', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId, name: sourceName })
                });
                selectedSpaceId = Number(data.space.id);
                showToast('知识空间已创建，选择聊天模型后即可编译。');
                await render();
            } catch (error) {
                [collection, name, rootPath, submit, cancel].filter(Boolean).forEach(control => { control.disabled = false; });
                status.textContent = error.message || (isMarkdownImport ? '导入外部 Markdown 文档库失败' : '创建知识空间失败');
            }
        });
        name.focus();
    }

    async function compileSpace() {
        if (!selectedSpaceId) {
            showToast('请先新建或选择一个知识空间。', 'warning');
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
            showToast(`知识空间编译任务已创建：${data.run.id}`); window.setTimeout(() => void render(), 1200);
        } catch (error) { showToast(error.message || '启动知识空间编译失败', 'error'); }
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
        clearScheduledRefresh();
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
                showToast(compilePolicy.autoCompile ? '资料变更后将按所选模型创建增量知识空间编译任务。' : '已关闭该知识空间的自动编译。');
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
            showToast('综合页面已发布。'); await render();
        } catch (error) { showToast(error.message || '发布失败：请确认来源完整且不存在冲突。', 'error'); }
    }

    async function cancelRun(runId) {
        try {
            await request(`/knowledge/wiki/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            showToast('知识空间编译任务已取消。'); await render();
        } catch (error) { showToast(error.message || '取消编译任务失败', 'error'); }
    }

    async function openPage(pageId) {
        try {
            const [data, versionsResult] = await Promise.all([
                request(`/knowledge/wiki/pages/${pageId}`),
                request(`/knowledge/wiki/pages/${pageId}/versions?limit=20`)
            ]);
            let detail = byId('knowledge-wiki-pages-pane');
            if (!detail) {
                const body = byId('knowledge-wiki-body');
                if (!body) return;
                clear(body);
                detail = document.createElement('div');
                detail.id = 'knowledge-wiki-pages-pane';
                body.appendChild(detail);
            } else {
                clear(detail);
            }
            detail.className = 'knowledge-wiki-pages is-detail-mode';

            // 1. 顶部导航与状态条
            const navBar = document.createElement('div');
            navBar.className = 'knowledge-wiki-detail-nav';

            const navLeft = document.createElement('div');
            navLeft.className = 'knowledge-wiki-detail-nav-left';

            const backBtn = document.createElement('button');
            backBtn.type = 'button';
            backBtn.className = 'btn-secondary knowledge-wiki-back-btn';
            backBtn.textContent = '‹ 返回列表';
            backBtn.addEventListener('click', () => void render());

            const pageTitle = document.createElement('h4');
            pageTitle.className = 'knowledge-wiki-detail-title';
            pageTitle.textContent = data.page.title;
            pageTitle.title = data.page.title;

            const badgeGroup = document.createElement('div');
            badgeGroup.className = 'knowledge-wiki-badge-group';
            const typeTag = document.createElement('span');
            typeTag.className = `wiki-tag ${data.page.pageType === 'conflict' ? 'tag-warning' : data.page.pageType === 'overview' ? 'tag-primary' : 'tag-neutral'}`;
            typeTag.textContent = wikiPageTypeLabel(data.page.pageType);
            const statusTag = document.createElement('span');
            statusTag.className = `wiki-tag ${data.page.status === 'published' ? 'tag-success' : data.page.status === 'review' ? 'tag-primary' : data.page.status === 'stale' ? 'tag-warning' : 'tag-neutral'}`;
            statusTag.textContent = wikiPageStatusLabel(data.page.status);
            badgeGroup.append(typeTag, statusTag);

            navLeft.append(backBtn, pageTitle, badgeGroup);

            const navRight = document.createElement('div');
            navRight.className = 'knowledge-wiki-detail-nav-right';
            if (data.page.status === 'review' || data.page.status === 'draft') {
                const publishBtn = document.createElement('button');
                publishBtn.type = 'button';
                publishBtn.className = 'btn-primary';
                publishBtn.textContent = '发布此页面';
                publishBtn.addEventListener('click', () => void publishPage(data.page.id));
                navRight.appendChild(publishBtn);
            }
            navBar.append(navLeft, navRight);
            detail.appendChild(navBar);

            // 2. 页面摘要
            if (data.page.summary) {
                const summaryBox = document.createElement('div');
                summaryBox.className = 'knowledge-wiki-summary-box';
                appendText(summaryBox, 'span', '页面摘要：', 'knowledge-wiki-summary-label');
                appendText(summaryBox, 'span', data.page.summary, 'knowledge-wiki-summary-text');
                detail.appendChild(summaryBox);
            }

            // 3. 综合正文预览
            const contentSec = document.createElement('div');
            contentSec.className = 'knowledge-wiki-section';
            appendText(contentSec, 'h5', '综合页正文', 'knowledge-wiki-subhead');
            if (data.page.markdown) {
                const markdownBox = document.createElement('div');
                markdownBox.className = 'knowledge-wiki-markdown-box';
                markdownBox.textContent = data.page.markdown;
                contentSec.appendChild(markdownBox);
            } else {
                appendText(contentSec, 'p', '该页面尚未生成正文内容。', 'muted-text');
            }
            detail.appendChild(contentSec);

            // 4. 原始依据来源标准数据表格（分页展示以杜绝双重垂直与横向滚动条）
            const sourcesSec = document.createElement('div');
            sourcesSec.className = 'knowledge-wiki-section sources-section';
            const sources = Array.isArray(data.sources) ? data.sources : [];
            const sourcesHeader = document.createElement('h5');
            sourcesHeader.className = 'knowledge-wiki-subhead';
            sourcesHeader.textContent = `原始依据来源（共 ${sources.length} 条）`;
            sourcesSec.appendChild(sourcesHeader);

            if (sources.length > 0) {
                const tableWrap = document.createElement('div');
                tableWrap.className = 'knowledge-wiki-table-wrap';
                const tableContainer = document.createElement('div');
                tableContainer.className = 'table-container';
                const table = document.createElement('table');
                table.className = 'data-table';

                const thead = document.createElement('thead');
                const headerRow = document.createElement('tr');
                const cols = [
                    { label: '序号', width: '42px', align: 'text-center' },
                    { label: '来源资料 / 文档', width: '26%', align: '' },
                    { label: '版本', width: '48px', align: 'text-center' },
                    { label: '章节 / 区块路径', width: 'auto', align: '' },
                    { label: '引用性质', width: '84px', align: 'text-center' },
                    { label: '核验状态', width: '88px', align: 'text-center' }
                ];
                cols.forEach(col => {
                    const th = document.createElement('th');
                    th.textContent = col.label;
                    if (col.align) th.className = col.align;
                    if (col.width) th.style.width = col.width;
                    headerRow.appendChild(th);
                });
                thead.appendChild(headerRow);
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                table.appendChild(tbody);
                tableContainer.appendChild(table);
                tableWrap.appendChild(tableContainer);
                sourcesSec.appendChild(tableWrap);

                const paginationWrap = document.createElement('div');
                paginationWrap.className = 'knowledge-wiki-pagination pagination';
                sourcesSec.appendChild(paginationWrap);

                const renderPagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination
                    || window.Pivot?.legacy?.renderWorkspacePagination;

                const sourcesLimit = 6;
                let currentSourcesPage = 1;

                function renderSourcesTablePage(page) {
                    clear(tbody);
                    currentSourcesPage = page;
                    const startIdx = (page - 1) * sourcesLimit;
                    const pageSources = sources.slice(startIdx, startIdx + sourcesLimit);

                    pageSources.forEach((source, index) => {
                        const tr = document.createElement('tr');

                        const tdIdx = document.createElement('td');
                        tdIdx.className = 'text-center';
                        tdIdx.textContent = String(startIdx + index + 1);
                        tr.appendChild(tdIdx);

                        const tdDoc = document.createElement('td');
                        tdDoc.textContent = source.title || `文档 #${source.documentId}`;
                        tdDoc.title = source.title || `文档 #${source.documentId}`;
                        tr.appendChild(tdDoc);

                        const tdVer = document.createElement('td');
                        tdVer.className = 'text-center';
                        const verPill = document.createElement('span');
                        verPill.className = 'wiki-tag tag-neutral';
                        verPill.textContent = `v${source.versionNo || 1}`;
                        tdVer.appendChild(verPill);
                        tr.appendChild(tdVer);

                        const tdPath = document.createElement('td');
                        const headingText = source.headingPath || source.sectionAnchor || '正文区块';
                        tdPath.textContent = headingText;
                        tdPath.title = headingText;
                        tr.appendChild(tdPath);

                        const tdType = document.createElement('td');
                        tdType.className = 'text-center';
                        const typePill = document.createElement('span');
                        const supportClass = source.supportType === 'supports' ? 'tag-success'
                            : source.supportType === 'contradicts' ? 'tag-warning'
                            : source.supportType === 'defines' ? 'tag-primary'
                            : 'tag-neutral';
                        typePill.className = `wiki-tag ${supportClass}`;
                        typePill.textContent = wikiSupportTypeLabel(source.supportType);
                        tdType.appendChild(typePill);
                        tr.appendChild(tdType);

                        const tdStatus = document.createElement('td');
                        tdStatus.className = 'text-center';
                        const statusPill = document.createElement('span');
                        const statusClass = ['verified', 'auto_checked', 'human_verified'].includes(source.verifiedStatus) ? 'tag-success'
                            : ['conflict', 'invalid', 'expired'].includes(source.verifiedStatus) ? 'tag-warning'
                            : 'tag-neutral';
                        statusPill.className = `wiki-tag ${statusClass}`;
                        statusPill.textContent = wikiVerifiedStatusLabel(source.verifiedStatus);
                        tdStatus.appendChild(statusPill);
                        tr.appendChild(tdStatus);

                        tbody.appendChild(tr);
                    });

                    if (sources.length > sourcesLimit) {
                        paginationWrap.hidden = false;
                        if (typeof renderPagination === 'function') {
                            renderPagination(paginationWrap, {
                                total: sources.length,
                                limit: sourcesLimit,
                                page: currentSourcesPage,
                                onPageChange: targetPage => renderSourcesTablePage(targetPage)
                            });
                        } else {
                            clear(paginationWrap);
                            const totalPages = Math.ceil(sources.length / sourcesLimit);
                            const prevBtn = document.createElement('button');
                            prevBtn.type = 'button'; prevBtn.className = 'btn-secondary'; prevBtn.textContent = '上一页';
                            prevBtn.disabled = currentSourcesPage <= 1;
                            prevBtn.addEventListener('click', () => renderSourcesTablePage(currentSourcesPage - 1));
                            const info = document.createElement('span');
                            info.textContent = `第 ${currentSourcesPage} / ${totalPages} 页（共 ${sources.length} 条）`;
                            const nextBtn = document.createElement('button');
                            nextBtn.type = 'button'; nextBtn.className = 'btn-secondary'; nextBtn.textContent = '下一页';
                            nextBtn.disabled = currentSourcesPage >= totalPages;
                            nextBtn.addEventListener('click', () => renderSourcesTablePage(currentSourcesPage + 1));
                            paginationWrap.append(prevBtn, info, nextBtn);
                        }
                    } else {
                        paginationWrap.hidden = true;
                    }
                }

                renderSourcesTablePage(1);
            } else {
                appendText(sourcesSec, 'p', '暂无可访问的原始来源记录。', 'muted-text');
            }
            detail.appendChild(sourcesSec);

            // 5. 版本差异对比
            const versions = Array.isArray(versionsResult.data) ? versionsResult.data : [];
            if (versions.length > 1) {
                const diffSec = document.createElement('div');
                diffSec.className = 'knowledge-wiki-section';
                appendText(diffSec, 'h5', '版本差异对比', 'knowledge-wiki-subhead');
                const diffActions = document.createElement('div');
                diffActions.className = 'rag-actions';
                versions.filter(version => Number(version.id) !== Number(pageId)).forEach(version => {
                    const diffBtn = document.createElement('button');
                    diffBtn.type = 'button';
                    diffBtn.className = 'btn-secondary';
                    diffBtn.textContent = `与 v${version.versionNo} 对比`;
                    diffBtn.addEventListener('click', () => void openDiff(pageId, version.id));
                    diffActions.appendChild(diffBtn);
                });
                diffSec.appendChild(diffActions);
                const diffContent = document.createElement('div');
                diffContent.id = 'knowledge-wiki-diff-content';
                diffSec.appendChild(diffContent);
                detail.appendChild(diffSec);
            }

            // 6. 底部操作栏
            const footer = document.createElement('div');
            footer.className = 'knowledge-wiki-detail-footer';
            const backBottom = document.createElement('button');
            backBottom.type = 'button';
            backBottom.className = 'btn-secondary';
            backBottom.textContent = '‹ 返回页面列表';
            backBottom.addEventListener('click', () => void render());
            footer.appendChild(backBottom);
            if (data.page.status === 'review' || data.page.status === 'draft') {
                const publishBottom = document.createElement('button');
                publishBottom.type = 'button';
                publishBottom.className = 'btn-primary';
                publishBottom.textContent = '发布此页面';
                publishBottom.addEventListener('click', () => void publishPage(data.page.id));
                footer.appendChild(publishBottom);
            }
            detail.appendChild(footer);
        } catch (error) {
            showToast(error.message || '读取综合页面失败', 'error');
        }
    }

    async function openDiff(pageId, fromPageId) {
        try {
            const data = await request(`/knowledge/wiki/pages/${pageId}/diff?fromPageId=${encodeURIComponent(fromPageId)}&toPageId=${encodeURIComponent(pageId)}`);
            const container = byId('knowledge-wiki-diff-content');
            if (!container) return;
            clear(container);
            const changes = Array.isArray(data.diff?.changes) ? data.diff.changes : [];
            if (!changes.length) {
                appendText(container, 'p', '两个版本之间未检测到文本差异。', 'muted-text');
                return;
            }
            const diffPre = document.createElement('pre');
            diffPre.className = 'knowledge-wiki-markdown';
            diffPre.textContent = changes.map(change => `${change.type === 'added' ? '+' : '-'} ${change.line}: ${change.text}`).join('\n');
            container.appendChild(diffPre);
        } catch (error) { showToast(error.message || '读取版本差异失败', 'error'); }
    }

    document.addEventListener('click', event => {
        if (event.target?.closest?.('#knowledge-wiki-open')) {
            const modal = ensureModal(); window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true); void render();
        }
    });
    window.Pivot.exposeModule('knowledge.wiki', { open: () => byId('knowledge-wiki-open')?.click(), refresh: render });
})();
