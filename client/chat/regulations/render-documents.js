(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderDocumentsReady) return;

    const {
        FILE_ACCEPT,
        SUPPORTED_FORMATS,
        state,
        REGULATIONS_PAGE_SIZE,
        esc,
        cleanDisplayTitle,
        fmtDate,
        canManage,
        renderRichText
    } = ns;

    const renderRegulationStatusCell = (...args) => ns.renderRegulationStatusCell?.(...args);
    const renderRegulationActions = (...args) => ns.renderRegulationActions?.(...args);
    const renderRegulationsSummary = (...args) => ns.renderRegulationsSummary?.(...args);
    const renderDocumentsPagination = (...args) => ns.renderDocumentsPagination?.(...args);
            function renderCategoryDirectory() {
                const target = document.getElementById('regulations-folder-directory');
                const folderIndex = document.getElementById('regulations-folder-index');
                const tableWrap = document.getElementById('regulations-doc-table-wrap');
                const pagination = document.getElementById('regulations-pagination');
                if (!target) return;
                if (state.libraryView !== 'folders') {
                    target.classList.add('hidden');
                    tableWrap?.classList.remove('hidden');
                    pagination?.classList.remove('hidden');
                    return;
                }
                target.classList.remove('hidden');
                folderIndex?.classList.add('hidden');
                if (folderIndex) PivotSafeHtml.setHtml(folderIndex, '');
                tableWrap?.classList.add('hidden');
                pagination?.classList.add('hidden');
                const folders = Array.isArray(state.categoryFolders) ? state.categoryFolders : [];
                const fallbackTitle = '未分类';
                const emptyText = '暂无可访问的法规分类。';
                const folderListHtml = folders.length
                    ? folders.map(folder => {
                        const folderTitle = esc(folder.title || fallbackTitle);
                        return `
                            <button type="button" class="btn-secondary regulations-folder-card" data-regulation-folder-category="${esc(folder.category || '')}" data-regulation-folder-uncategorized="${folder.isUncategorized ? 'true' : 'false'}" data-regulation-folder-custom="${folder.isCustom ? 'true' : 'false'}" data-regulation-folder-title="${folderTitle}" data-regulation-folder-documents="${Number(folder.documentCount || 0)}" data-regulation-folder-articles="${Number(folder.articleCount || 0)}" data-regulation-folder-effective="${Number(folder.effectiveCount || 0)}" data-regulation-folder-review="${Number(folder.needsReviewCount || 0)}" data-regulation-folder-updated="${esc(folder.latestUpdatedAt || '')}">
                                <strong>${folderTitle}</strong>
                                <span>${Number(folder.documentCount || 0)} 份法规 · ${Number(folder.articleCount || 0)} 条文</span>
                                <small>已核验现行 ${Number(folder.effectiveCount || 0)} · 待治理 ${Number(folder.needsReviewCount || 0)}</small>
                            </button>
                        `;
                    }).join('')
                    : `<div class="regulations-empty compact">${emptyText}</div>`;
                const canAdd = canManage();
                PivotSafeHtml.setHtml(target, `
                    <div class="regulations-folder-heading">
                        <div>
                            <h3>法规分类目录</h3>
                            <p>分类目录为动态索引页，展示该分类中的法规、版本和治理状态，不会生成重复的法规文档。</p>
                        </div>
                        <div class="regulations-folder-actions">
                            <span class="regulations-folder-count">${folders.length} 个分类</span>
                            ${canAdd ? '<button type="button" class="btn-primary" id="regulations-create-folder-btn" data-regulation-create-folder>+ 新建分类</button>' : ''}
                        </div>
                    </div>
                    <div class="regulations-folder-grid">
                        ${folderListHtml}
                        ${canAdd ? `
                            <button type="button" class="btn-secondary regulations-folder-card regulations-folder-card-add" data-regulation-create-folder aria-label="新建法规分类目录">
                                <strong>+ 新建分类目录</strong>
                                <span>自定义法规层级与业务分类</span>
                            </button>
                        ` : ''}
                    </div>
                `);
            }

            function renderActiveFolderIndex() {
                const target = document.getElementById('regulations-folder-index');
                if (!target) return;
                if (state.libraryView !== 'documents') {
                    target.classList.add('hidden');
                    PivotSafeHtml.setHtml(target, '');
                    return;
                }
                target.classList.remove('hidden');
                const folder = state.activeFolder;
                const canBatch = canManage();
                const canDeleteFolder = canManage() && folder && folder.isCustom && Number(folder.documentCount || 0) === 0;
                const folderTitle = folder ? folder.title : '全部法规';
                const subTitle = folder ? '分类目录' : '文档目录';
                const descText = folder
                    ? '目录由当前数据库实时生成，可继续检索、批量治理或打开具体法规。'
                    : '展示法规库内全部法规文档，可进行检索、批量治理或查看正文。';
                const statsHtml = folder ? `
                    <div class="regulations-folder-stats">
                        <span>${Number(state.total || 0)} 份法规</span>
                        <span>${Number(folder.articleCount || 0)} 条文</span>
                        <span>已核验现行 ${Number(folder.effectiveCount || 0)}</span>
                        <span>待治理 ${Number(folder.needsReviewCount || 0)}</span>
                    </div>
                ` : '';
                PivotSafeHtml.setHtml(target, `
                    <div class="regulations-folder-heading">
                        <div>
                            <h3>${esc(folderTitle)} · ${subTitle}</h3>
                            <p>${descText}</p>
                        </div>
                        <div class="regulations-folder-actions">
                            ${canBatch ? `<button id="regulations-batch-mode-btn" class="btn-secondary" type="button" aria-pressed="${state.batchMode ? 'true' : 'false'}">${state.batchMode ? '退出批量处理' : '批量处理'}</button>` : ''}
                            ${canDeleteFolder ? `<button type="button" class="btn-secondary text-danger" data-regulation-folder-delete="${esc(folder.category || '')}">删除分类</button>` : ''}
                            <button type="button" class="btn-secondary" data-regulation-folder-back>返回分类目录</button>
                        </div>
                    </div>
                    ${statsHtml}
                `);
            }
            function renderDocuments() {
                const target = document.getElementById('regulations-doc-list');
                if (!target) return;
                renderCategoryDirectory();
                renderActiveFolderIndex();
                const foldersBtn = document.getElementById('regulations-folders-btn');
                if (foldersBtn) {
                    const isFolders = state.libraryView === 'folders';
                    foldersBtn.classList.toggle('is-active', isFolders);
                    foldersBtn.setAttribute('aria-pressed', isFolders ? 'true' : 'false');
                    if (isFolders) {
                        foldersBtn.setAttribute('aria-current', 'page');
                    } else {
                        foldersBtn.removeAttribute('aria-current');
                    }
                }
                if (state.libraryView === 'folders') {
                    renderRegulationsSummary();
                    return;
                }
                const canSelect = canManage() && state.batchMode;
                if (!state.documents.length) {
                    const folderCat = state.activeFolder?.category;
                    const canImportThisCategory = canManage() && folderCat;
                    const emptyAction = canImportThisCategory ? `
                        <div class="regulations-empty-actions">
                            <button type="button" class="btn-primary" data-regulation-import-folder="${esc(folderCat)}">导入此分类法规</button>
                        </div>
                    ` : '';
                    PivotSafeHtml.setHtml(target, `<tr><td colspan="${canSelect ? 11 : 10}" class="text-center"><div class="regulations-empty compact">暂无法规文档${emptyAction}</div></td></tr>`);
                } else {
                            const startIndex = (Math.max(Number(state.page || 1), 1) - 1) * Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
                            PivotSafeHtml.setHtml(target, state.documents.map((doc, index) => {
                                const title = esc(cleanDisplayTitle(doc.title || '未命名法规'));
                                const rowIndex = startIndex + index + 1;
                                return `
                                <tr class="regulations-doc-row">
                                    ${canSelect ? `<td class="text-center"><input type="checkbox" data-regulation-select="${esc(doc.id)}" aria-label="选择 ${title}" ${state.selectedDocumentIds.has(String(doc.id)) ? 'checked' : ''}></td>` : ''}
                                    <td class="text-center">${rowIndex}</td>
                                    <td title="${title}">
                                        <strong class="regulations-doc-title">${title}</strong>
                                    </td>
                                    <td title="${esc(doc.category || '')}">${esc(doc.category || '-')}</td>
                                    <td title="${esc(doc.issuing_body || '')}">${esc(doc.issuing_body || '-')}</td>
                                    <td title="${esc(doc.jurisdiction || '')}">${esc(doc.jurisdiction || '-')}</td>
                                    <td class="text-center">${renderRegulationStatusCell(doc)}</td>
                                    <td class="text-center"><span class="regulations-article-count">${Number(doc.article_count || 0)}</span></td>
                                    <td title="${esc(doc.current_version_label || '')}">${esc(doc.current_version_label || '-')}</td>
                                    <td title="${esc(fmtDate(doc.updated_at || doc.current_version_updated_at || doc.created_at))}">${esc(fmtDate(doc.updated_at || doc.current_version_updated_at || doc.created_at))}</td>
                                    <td class="text-center">${renderRegulationActions(doc)}</td>
                                </tr>`;
                            }).join(''));
                        }
                        renderRegulationsSummary();
                        renderDocumentsPagination();
                        ns.syncDocumentSelection?.();
                    }
                    function renderDetail() {
                        const target = document.getElementById('regulations-detail-body');
                        if (!target) return;
                        const detail = state.detail;
                        const adminActions = document.getElementById('regulations-detail-admin-actions');
                        const formsHost = document.getElementById('regulations-detail-forms');
                        const docBadge = document.getElementById('regulations-detail-doc-badge');
                        if (!detail?.document) {
                            PivotSafeHtml.setHtml(target, '<div class="regulations-placeholder">请选择法规文档查看正文。</div>');
                            if (docBadge) PivotSafeHtml.setHtml(docBadge, '');
                            if (adminActions) PivotSafeHtml.setHtml(adminActions, '');
                            if (formsHost) PivotSafeHtml.setHtml(formsHost, '');
                            return;
                        }
                        const doc = detail.document;
                        const articles = Array.isArray(detail.articles) ? detail.articles : [];
                        const title = cleanDisplayTitle(doc.title || '未命名法规');
                        const verLabel = detail.currentVersion?.version_label || doc.current_version_label || '';
                        if (docBadge) {
                            PivotSafeHtml.setHtml(docBadge, `
                                <span class="regulations-detail-badge-title" title="${esc(title)}">${esc(title)}</span>
                                ${verLabel ? `<span class="regulations-detail-badge-version">${esc(verLabel)}</span>` : ''}
                            `);
                        }
                        const indexStatus = String(detail.currentVersion?.index_status || 'lexical_ready');
                        const indexLabels = { vector_ready: '向量索引已就绪', indexing: '正在建立向量索引', retry_wait: '向量索引等待重试', lexical_ready: '当前使用关键词检索' };
                        const indexNotice = indexStatus === 'vector_ready' ? '' : `<div class="regulations-index-notice"><strong>${esc(indexLabels[indexStatus] || '索引状态待核验')}</strong><span>${esc(detail.currentVersion?.index_error || '法规正文已可使用关键词检索；可在向量服务恢复后手动重建索引。')}</span></div>`;
                        // 结构化渲染顶部操作栏：划分为时间适用、演进对比、协同追溯和治理管理集群
                        if (adminActions) {
                            const effectiveDateControl = `
                                <div class="regulations-toolbar-cluster">
                                    <label class="regulations-effective-date-control">
                                        <span>适用日期</span>
                                        <input id="regulations-effective-date" class="form-input" type="date" aria-label="按日期查看适用版本">
                                        <button class="btn-secondary" type="button" data-regulation-effective-date="${esc(doc.id)}">查看</button>
                                    </label>
                                </div>
                            `;
                            const versionCluster = (Array.isArray(detail.versions) && detail.versions.length >= 1) ? `
                                <div class="regulations-toolbar-cluster">
                                    <button class="btn-secondary" type="button" data-regulation-timeline="${esc(doc.id)}">修订时间线</button>
                                    ${detail.versions.length >= 2 ? `<button class="btn-secondary" type="button" data-regulation-compare="${esc(doc.id)}">版本对比</button>` : ''}
                                </div>
                            ` : '';
                            const relationCluster = `
                                <div class="regulations-toolbar-cluster">
                                    <button class="btn-secondary" type="button" data-regulation-graph="${esc(doc.id)}">引用网络</button>
                                    <button class="btn-secondary" type="button" data-regulation-ai-logs="${esc(doc.id)}">问答记录</button>
                                    <button class="btn-secondary" type="button" data-regulation-obligations="${esc(doc.id)}">义务清单</button>
                                </div>
                            `;
                            const collabCluster = `
                                <div class="regulations-toolbar-cluster">
                                    <button class="btn-secondary" type="button" data-regulation-subscribe="${esc(doc.id)}">关注更新</button>
                                    <button class="btn-secondary" type="button" data-regulation-bookmark="${esc(doc.id)}">收藏法规</button>
                                    ${canManage() ? `<button class="btn-secondary" type="button" data-regulation-access-log="${esc(doc.id)}">访问记录</button>` : ''}
                                </div>
                            `;
                            const adminCluster = canManage() ? `
                                <div class="regulations-toolbar-cluster admin-cluster">
                                    ${detail.currentVersion?.id ? `<button class="btn-secondary" type="button" data-regulation-reindex-document="${esc(doc.id)}" data-regulation-reindex-version="${esc(detail.currentVersion.id)}">重建向量索引</button>` : ''}
                                    <button class="btn-secondary" type="button" data-regulation-edit="${esc(doc.id)}">编辑信息</button>
                                    <button class="btn-secondary" type="button" data-regulation-add-version="${esc(doc.id)}">追加版本</button>
                                </div>
                            ` : '';
                            PivotSafeHtml.setHtml(adminActions, `
                                <div class="regulations-toolbar-left-group">
                                    ${effectiveDateControl}
                                    ${versionCluster}
                                    ${relationCluster}
                                    ${collabCluster}
                                </div>
                                ${adminCluster ? `<div class="regulations-toolbar-right-group">${adminCluster}</div>` : ''}
                            `);
                        }
                        if (formsHost) {
                            PivotSafeHtml.setHtml(formsHost, canManage() ? renderInlineEditor(doc, detail.currentVersion) + renderVersionUploader(doc) : '');
                        }
                        // #5 废止/修订提醒横幅：汇总被其它法律 supersede 的条文
                        const superseded = articles.filter(a => Array.isArray(a.supersededBy) && a.supersededBy.length);
                        const supersedeBanner = superseded.length ? `
                            <div class="regulations-supersede-banner">
                                <strong>修订提醒</strong>
                                <span>本法以下条文已被其它法规废止或修订：</span>
                                <ul>
                                    ${superseded.map(a => a.supersededBy.map(s => `
                                        <li>${esc(a.article_label)} ← <button class="regulations-supersede-link" type="button" data-regulation-match-doc="${esc(s.sourceDocumentId)}">${esc(s.sourceDocumentTitle)} ${esc(s.sourceArticleLabel || '')}</button></li>
                                    `).join('')).join('')}
                                </ul>
                            </div>
                        ` : '';
                        // 分条渲染：每条带 regulation-article-{id} 锚点，便于引用图/废止/AI依据精确跳转
                        // 单条「全文」时退化为整篇展示
                        const isWhole = articles.length === 1 && (articles[0].article_label === '全文' || !articles[0].article_label);
                        let bodyHtml;
                        if (isWhole) {
                            bodyHtml = `<article id="regulation-article-${esc(articles[0].id)}" class="regulations-original-document">
                                <div class="regulations-article-body">${renderRichText(articles[0].content || '')}</div>
                            </article>`;
                        } else {
                            bodyHtml = articles.map(article => {
                                const content = String(article.content || '').trim();
                                if (!content) return '';
                                const label = cleanDisplayTitle(article.article_label || '', '');
                                const statusBadge = renderArticleStatusBadge(article);
                                const supersededBadge = (Array.isArray(article.supersededBy) && article.supersededBy.length)
                                    ? '<span class="regulations-article-badge superseded">被修订</span>' : '';
                                const annotationCount = Number(article.annotationCount || 0);
                                const articleId = esc(article.id);
                                const articleAnchor = `${doc.id}.${state.detail?.currentVersion?.id || ''}.${article.id}`;
                                const annotateBtn = `<button class="regulations-article-tool regulations-article-annotate" type="button" data-regulation-annotate="${articleId}">批注${annotationCount ? ` · ${annotationCount}` : ''}</button>`;
                                const tools = [
                                    statusBadge,
                                    supersededBadge,
                                    `<button class="regulations-article-tool" type="button" data-article-copy="${articleId}">复制</button>`,
                                    `<button class="regulations-article-tool" type="button" data-article-ask="${articleId}">提问</button>`,
                                    `<button class="regulations-article-tool" type="button" data-article-link="${esc(articleAnchor)}">定位</button>`,
                                    `<button class="btn-secondary regulations-article-tool" type="button" data-regulation-location="${articleId}">来源</button>`,
                                    `<button class="btn-secondary regulations-article-tool" type="button" data-regulation-similar="${articleId}">相似</button>`,
                                    canManage() ? `<button class="btn-secondary regulations-article-tool" type="button" data-regulation-obligation="${articleId}">义务</button>` : '',
                                    annotateBtn
                                ].filter(Boolean).join('');
                                // 正文若已以条号开头则不重复标题
                                const showLabel = label && label !== '全文' && !content.startsWith(label);
                                return `
                                    <article id="regulation-article-${articleId}" class="regulations-article-block">
                                        <div class="regulations-article-block-head">
                                            ${showLabel ? `<strong>${esc(label)}</strong>` : '<span></span>'}
                                            <span class="regulations-article-block-tools">
                                                ${tools}
                                            </span>
                                        </div>
                                        <div class="regulations-article-body">${renderRichText(content)}</div>
                                    </article>
                                `;
                            }).filter(Boolean).join('');
                        }
                        PivotSafeHtml.setHtml(target, bodyHtml
                            ? `${indexNotice}${supersedeBanner}${bodyHtml}`
                            : `${indexNotice}${supersedeBanner}<div class="regulations-empty compact">${esc(title)} 暂无可查看的法规原文</div>`);
                    }

                    // #8 条文状态徽章：amended（已修正）/ repealed（已废止），active 不显示
                    function renderArticleStatusBadge(article) {
                        const status = String(article?.status || 'active');
                        if (status === 'repealed') {
                            return `<span class="regulations-article-badge repealed">已废止${article.amended_date ? ` · ${esc(article.amended_date)}` : ''}</span>`;
                        }
                        if (status === 'amended') {
                            return `<span class="regulations-article-badge amended">已修正${article.amended_date ? ` · ${esc(article.amended_date)}` : ''}</span>`;
                        }
                        return '';
                    }

                    function renderInlineEditor(doc, version = {}) {
                        return `
                            <form id="regulations-edit-form" class="regulations-inline-form hidden" data-doc-id="${esc(doc.id)}" data-version-id="${esc(version?.id || '')}">
                                <div class="regulations-dialog-head">
                                    <div>
                                        <h3>编辑法规信息</h3>
                                        <p>这些信息用于筛选、检索和问答引用。</p>
                                    </div>
                                </div>
                                <div class="regulations-admin-group">
                                    <div class="regulations-admin-grid">
                                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}" required></label>
                                        <label>法规层级<input name="legalLevel" class="form-input" maxlength="80" value="${esc(doc.legal_level || '')}" placeholder="如 法律、行政法规、部门规章" list="regulations-legal-level-list"></label>
                                        <label>分类<input name="category" class="form-input" maxlength="120" value="${esc(doc.category || '')}" list="regulations-category-list"></label>
                                        <label>发布机构（可多个）<input name="issuingBody" class="form-input" maxlength="120" value="${esc(doc.issuing_body || '')}" placeholder="用顿号或逗号分隔"></label>
                                        <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" value="${esc(doc.jurisdiction || '')}" list="regulations-jurisdiction-list"></label>
                                        <label>主题标签<input name="subjectTags" class="form-input" maxlength="300" value="${esc(Array.isArray(doc.subject_tags) ? doc.subject_tags.join('、') : doc.subject_tags || '')}" placeholder="用顿号或逗号分隔"></label>
                                        <label>状态<select name="status" class="form-input">
                                            <option value="active" ${doc.status !== 'archived' ? 'selected' : ''}>启用</option>
                                            <option value="archived" ${doc.status === 'archived' ? 'selected' : ''}>归档</option>
                                        </select></label>
                                    </div>
                                    <label>官方来源地址<input name="officialSourceUrl" class="form-input" maxlength="1000" value="${esc(doc.official_source_url || '')}" placeholder="可选；用于来源追溯"></label>
                                    <label>摘要<textarea name="summary" class="form-input" rows="3">${esc(doc.summary || '')}</textarea></label>
                                    ${version?.id ? `<div class="regulations-admin-group">
                                        <div class="regulations-admin-group-head"><strong>当前版本效力与审核</strong><span>管理状态不等同于法律效力</span></div>
                                        <div class="regulations-admin-grid">
                                            <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" value="${esc(version.version_label || '')}" placeholder="如 2024年修正"></label>
                                            <label>效力状态<select name="effectStatus" class="form-input"><option value="unverified" ${version.effect_status === 'unverified' ? 'selected' : ''}>待核验</option><option value="pending" ${version.effect_status === 'pending' ? 'selected' : ''}>待生效</option><option value="effective" ${version.effect_status === 'effective' ? 'selected' : ''}>现行有效</option><option value="expired" ${version.effect_status === 'expired' ? 'selected' : ''}>失效</option><option value="repealed" ${version.effect_status === 'repealed' ? 'selected' : ''}>废止</option></select></label>
                                            <label>发布日期<input name="publishedAt" class="form-input" type="date" value="${esc(version.published_at || '')}"></label>
                                            <label>生效日期<input name="effectiveFrom" class="form-input" type="date" value="${esc(version.effective_from || '')}"></label>
                                            <label>失效日期<input name="effectiveTo" class="form-input" type="date" value="${esc(version.effective_to || '')}"></label>
                                            <label>审核状态<select name="reviewStatus" class="form-input"><option value="pending" ${version.review_status === 'pending' ? 'selected' : ''}>待审核</option><option value="approved" ${version.review_status === 'approved' ? 'selected' : ''}>已审核</option><option value="rejected" ${version.review_status === 'rejected' ? 'selected' : ''}>驳回</option></select></label>
                                        </div>
                                        <label>版本来源地址<input name="sourceUrl" class="form-input" maxlength="1000" value="${esc(version.source_url || '')}" placeholder="可选；版本的权威来源地址"></label>
                                    </div>` : ''}
                                </div>
                                <div class="regulations-admin-actions">
                                    <button class="btn-secondary" type="button" data-regulation-cancel-inline>取消</button>
                                    <button class="btn-primary" type="submit">保存</button>
                                </div>
                            </form>
                        `;
                    }

                    function renderVersionUploader(doc) {
                        return `
                            <form id="regulations-version-form" class="regulations-inline-form hidden" data-doc-id="${esc(doc.id)}">
                                <div class="regulations-dialog-head">
                                    <div>
                                        <h3>追加版本</h3>
                                        <p>上传新版本后会重新解析条文，并设为当前版本。</p>
                                    </div>
                                </div>
                                <div class="regulations-admin-group">
                                    <div class="regulations-admin-grid">
                                        <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正；留空按文件名日期识别"></label>
                                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}"></label>
                                        <label>效力状态<select name="effectStatus" class="form-input"><option value="unverified" selected>待核验</option><option value="pending">待生效</option><option value="effective">现行有效</option><option value="expired">失效</option><option value="repealed">废止</option></select></label>
                                        <label>生效日期<input name="effectiveFrom" class="form-input" type="date"></label>
                                    </div>
                                    <label>版本来源地址<input name="sourceUrl" class="form-input" maxlength="1000" placeholder="可选；版本的权威来源地址"></label>
                                    <label>摘要<textarea name="summary" class="form-input" rows="3" placeholder="可选；留空时从新版本正文生成摘要"></textarea></label>
                                    <label class="regulations-file-field">
                                        <span>新版本文件</span>
                                        <span class="regulations-file-control">
                                            <input name="file" class="regulations-file-input" type="file" accept="${FILE_ACCEPT}" required>
                                            <span class="regulations-file-button">选择文件</span>
                                            <span class="regulations-file-summary">未选择文件</span>
                                        </span>
                                        <small class="regulations-file-hint">支持 ${SUPPORTED_FORMATS}。</small>
                                    </label>
                                </div>
                                <div class="regulations-admin-actions">
                                    <button class="btn-secondary" type="button" data-regulation-cancel-inline>取消</button>
                                    <button class="btn-primary" type="submit">上传版本</button>
                                </div>
                            </form>
                        `;
                    }

        Object.assign(ns, {
            renderCategoryDirectory,
            renderActiveFolderIndex,
            renderDocuments,
            renderDetail,
            renderArticleStatusBadge,
            renderInlineEditor,
            renderVersionUploader,
            renderDocumentsReady: true
        });
})();
