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
        canImportDocuments,
        renderRichText
    } = ns;

    const renderRegulationStatusCell = (...args) => ns.renderRegulationStatusCell?.(...args);
    const renderRegulationActions = (...args) => ns.renderRegulationActions?.(...args);
    const renderRegulationsSummary = (...args) => ns.renderRegulationsSummary?.(...args);
    const renderDocumentsPagination = (...args) => ns.renderDocumentsPagination?.(...args);

    function getCategoryFolderTheme(title, isUncategorized) {
                if (isUncategorized || title === '未分类') {
                    return {
                        themeClass: 'folder-theme-slate',
                        icon: 'folder',
                        tag: '未分类'
                    };
                }
                const t = String(title || '').trim();
                if (/测试|试验|demo|test/i.test(t)) {
                    return { themeClass: 'folder-theme-fuchsia', icon: 'folder', tag: '测试试验' };
                }
                if (/刑法|刑事|治安|惩戒|监察|纪检/i.test(t)) {
                    return { themeClass: 'folder-theme-rose', icon: 'shield', tag: '刑事安全' };
                }
                if (/宪法|民法|法律|基本法|法典/i.test(t)) {
                    return { themeClass: 'folder-theme-blue', icon: 'scales', tag: '国家法律' };
                }
                if (/行政|规章|国务院|政务|部门/i.test(t)) {
                    return { themeClass: 'folder-theme-cyan', icon: 'building', tag: '行政规章' };
                }
                if (/地方|省|市|区|特区|自治/i.test(t)) {
                    return { themeClass: 'folder-theme-emerald', icon: 'pin', tag: '地方规范' };
                }
                if (/行业|规范|行业标准|国标|行标/i.test(t)) {
                    return { themeClass: 'folder-theme-amber', icon: 'book', tag: '行业规范' };
                }
                if (/司法|解释|判例|最高法|最高检/i.test(t)) {
                    return { themeClass: 'folder-theme-purple', icon: 'file-text', tag: '司法解释' };
                }
                if (/团体|企业|制度|内控|章程/i.test(t)) {
                    return { themeClass: 'folder-theme-indigo', icon: 'folder', tag: '企团标准' };
                }
                const palettes = [
                    { themeClass: 'folder-theme-blue', icon: 'scales', tag: '法规分类' },
                    { themeClass: 'folder-theme-emerald', icon: 'pin', tag: '法规分类' },
                    { themeClass: 'folder-theme-amber', icon: 'book', tag: '法规分类' },
                    { themeClass: 'folder-theme-purple', icon: 'file-text', tag: '法规分类' },
                    { themeClass: 'folder-theme-rose', icon: 'shield', tag: '法规分类' },
                    { themeClass: 'folder-theme-cyan', icon: 'building', tag: '法规分类' }
                ];
                let hash = 0;
                for (let i = 0; i < t.length; i++) hash = (hash << 5) - hash + t.charCodeAt(i);
                return palettes[Math.abs(hash) % palettes.length];
            }

            function getCategoryFolderIconSvg(iconType) {
                switch (iconType) {
                    case 'scales':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v17M5 7h14M5 7l-3 6h6L5 7ZM19 7l-3 6h6l-3-6Z"/></svg>';
                    case 'shield':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>';
                    case 'building':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18M5 21V9l7-6 7 6v12M9 21v-6h6v6"/></svg>';
                    case 'pin':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
                    case 'book':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5ZM6 6h10M6 10h10"/></svg>';
                    case 'file-text':
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>';
                    default:
                        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
                }
            }

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
                        const rawTitle = folder.title || fallbackTitle;
                        const folderTitle = esc(rawTitle);
                        const docCount = Number(folder.documentCount || 0);
                        const articleCount = Number(folder.articleCount || 0);
                        const effectiveCount = Number(folder.effectiveCount || 0);
                        const reviewCount = Number(folder.needsReviewCount || 0);
                        const theme = getCategoryFolderTheme(rawTitle, folder.isUncategorized);
                        const iconSvg = getCategoryFolderIconSvg(theme.icon);
                        const effectiveRate = docCount > 0 ? Math.round((effectiveCount / docCount) * 100) : 0;

                        return `
                            <button type="button" class="btn-secondary regulations-folder-card ${theme.themeClass}" data-regulation-folder-category="${esc(folder.category || '')}" data-regulation-folder-uncategorized="${folder.isUncategorized ? 'true' : 'false'}" data-regulation-folder-custom="${folder.isCustom ? 'true' : 'false'}" data-regulation-folder-title="${folderTitle}" data-regulation-folder-documents="${docCount}" data-regulation-folder-articles="${articleCount}" data-regulation-folder-effective="${effectiveCount}" data-regulation-folder-review="${reviewCount}" data-regulation-folder-updated="${esc(folder.latestUpdatedAt || '')}">
                                <div class="regulations-folder-card-top">
                                    <div class="regulations-folder-icon-wrap">
                                        ${iconSvg}
                                    </div>
                                    <div class="regulations-folder-title-block">
                                        <strong class="regulations-folder-title" title="${folderTitle}">${folderTitle}</strong>
                                    </div>
                                </div>

                                <div class="regulations-folder-stats-row">
                                    <span class="regulations-folder-stat-item">
                                        <strong class="regulations-folder-stat-val ${docCount === 0 ? 'is-zero' : ''}">${docCount}</strong>
                                        <span class="regulations-folder-stat-lbl">份法规</span>
                                    </span>
                                    <span class="regulations-folder-stat-sep">·</span>
                                    <span class="regulations-folder-stat-item">
                                        <strong class="regulations-folder-stat-val ${articleCount === 0 ? 'is-zero' : ''}">${articleCount}</strong>
                                        <span class="regulations-folder-stat-lbl">条文</span>
                                    </span>
                                </div>

                                <div class="regulations-folder-footer-row">
                                    <span class="regulations-health-pill is-effective ${effectiveCount > 0 ? 'has-count' : ''}">
                                        <span class="regulations-health-dot"></span>已核验现行 ${effectiveCount}
                                    </span>
                                    <span class="regulations-health-pill ${reviewCount > 0 ? 'is-warning' : 'is-muted'}">
                                        <span class="regulations-health-dot"></span>待治理 ${reviewCount}
                                    </span>
                                </div>

                                <div class="regulations-folder-progress-track" title="现行核验率: ${effectiveRate}%">
                                    <div class="regulations-folder-progress-bar" data-progress-rate="${docCount > 0 ? (effectiveCount === 0 && reviewCount === 0 ? 0 : effectiveRate) : 0}"></div>
                                </div>
                            </button>
                        `;
                    }).join('')
                    : `<div class="regulations-empty compact">${emptyText}</div>`;
                // 分类目录会影响全库导入时的归档口径，仅 super admin 可维护。
                const canAdd = canImportDocuments();
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
                    </div>
                `);
                target.querySelectorAll('.regulations-folder-progress-bar').forEach(bar => {
                    const rate = Math.max(0, Math.min(100, Number(bar.getAttribute('data-progress-rate')) || 0));
                    bar.style.setProperty('width', `${rate}%`);
                });
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
                const canDeleteFolder = canImportDocuments() && folder && folder.isCustom && Number(folder.documentCount || 0) === 0;
                const governanceConfig = getGovernanceWorklistConfig(state.governanceScope);
                const isGovernanceWorklist = Boolean(governanceConfig);
                const folderTitle = governanceConfig?.title || (folder ? folder.title : '全部法规');
                const subTitle = isGovernanceWorklist ? '治理队列' : (folder ? '分类目录' : '文档目录');
                const descText = governanceConfig
                    ? governanceConfig.description
                    : (folder
                    ? '目录由当前数据库实时生成，可继续检索、批量治理或打开具体法规。'
                    : '展示法规库内全部法规文档，可进行检索、批量治理或查看正文。');
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
                            <button type="button" class="btn-secondary" data-regulation-folder-back>${isGovernanceWorklist ? '退出治理队列' : '返回分类目录'}</button>
                        </div>
                    </div>
                    ${statsHtml}
                `);
            }

            function getGovernanceWorklistConfig(scope) {
                const key = String(scope || '');
                return {
                    metadata: { title: '元数据待审核法规', description: '补齐法规层级、权威来源等字段后确认元数据审核状态。' },
                    maintainer: { title: '缺少维护人法规', description: '为每份法规指派明确维护人，形成后续维护责任链。' },
                    version: { title: '待治理法规', description: '仅显示当前版本效力待核验、审核未通过或缺少当前版本的法规；请逐条确认后保存。' },
                    index: { title: '索引未完成法规', description: '可重新加入向量索引队列；不会重新 OCR 或解析原文件。' },
                    location: { title: '条文缺少定位法规', description: '依据当前版本已抽取正文重新生成条文页码和字符位置。' }
                }[key] || null;
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
                    const canImportThisCategory = canImportDocuments() && folderCat;
                    const emptyAction = canImportThisCategory ? `
                        <div class="regulations-empty-actions">
                            <button type="button" class="btn-primary" data-regulation-import-folder="${esc(folderCat)}">导入此分类法规</button>
                        </div>
                    ` : '';
                    const governanceConfig = getGovernanceWorklistConfig(state.governanceScope);
                    const emptyText = governanceConfig ? `暂无${governanceConfig.title}` : '暂无法规文档';
                    PivotSafeHtml.setHtml(target, `<tr><td colspan="${canSelect ? 11 : 10}" class="text-center"><div class="regulations-empty compact">${emptyText}${emptyAction}</div></td></tr>`);
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
                        const detailPanel = document.getElementById('regulations-detail-panel');
                        const adminActions = document.getElementById('regulations-detail-admin-actions');
                        const formsHost = document.getElementById('regulations-detail-forms');
                        const docBadge = document.getElementById('regulations-detail-doc-badge');
                        if (!detail?.document) {
                            detailPanel?.classList.remove('regulations-metadata-review-mode');
                            PivotSafeHtml.setHtml(target, '<div class="regulations-placeholder">请选择法规文档查看正文。</div>');
                            if (docBadge) PivotSafeHtml.setHtml(docBadge, '');
                            if (adminActions) PivotSafeHtml.setHtml(adminActions, '');
                            if (formsHost) PivotSafeHtml.setHtml(formsHost, '');
                            return;
                        }
                        const doc = detail.document;
                        const metadataReviewMode = Boolean(state.metadataReviewMode && canManage());
                        detailPanel?.classList.toggle('regulations-metadata-review-mode', metadataReviewMode);
                        const articles = Array.isArray(detail.articles) ? detail.articles : [];
                        const title = cleanDisplayTitle(doc.title || '未命名法规');
                        const verLabel = detail.currentVersion?.version_label || doc.current_version_label || '';
                        if (docBadge) {
                            const effectiveAtBadge = state.effectiveAt ? `<span class="regulations-detail-badge-filtered" title="当前根据适用基准日 ${esc(state.effectiveAt)} 定位有效版本">基准日: ${esc(state.effectiveAt)}</span>` : '';
                            PivotSafeHtml.setHtml(docBadge, `
                                <span class="regulations-detail-badge-title" title="${esc(title)}">${esc(title)}</span>
                                ${verLabel ? `<span class="regulations-detail-badge-version">${esc(verLabel)}</span>` : ''}
                                ${effectiveAtBadge}
                            `);
                        }
                        const indexStatus = String(detail.currentVersion?.index_status || 'lexical_ready');
                        const indexLabels = { vector_ready: '向量索引已就绪', indexing: '正在建立向量索引', retry_wait: '向量索引等待重试', lexical_ready: '当前使用关键词检索' };
                        const indexNotice = indexStatus === 'vector_ready' ? '' : `<div class="regulations-index-notice"><strong>${esc(indexLabels[indexStatus] || '索引状态待核验')}</strong><span>${esc(detail.currentVersion?.index_error || '法规正文已可使用关键词检索；可在向量服务恢复后手动重建索引。')}</span></div>`;
                        // 结构化渲染顶部操作栏：划分为版本与时效、关联网络、协同追踪和治理管理集群
                        if (adminActions) {
                            const isDateFiltered = Boolean(state.effectiveAt);
                            const hasVersions = Array.isArray(detail.versions) && detail.versions.length >= 1;
                            const hasMultipleVersions = Array.isArray(detail.versions) && detail.versions.length >= 2;
                            const versionValidityCluster = `
                                <div class="regulations-toolbar-cluster regulations-version-validity-cluster${isDateFiltered ? ' is-filtered' : ''}" role="group" aria-label="法规版本与时效">
                                    <div class="regulations-effective-date-group">
                                        <label for="regulations-effective-date" class="regulations-effective-date-label" title="选择或输入日期，快速查阅历史上该日期适用的有效版本">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                                <line x1="3" y1="10" x2="21" y2="10"></line>
                                            </svg>
                                            <span>适用日期</span>
                                        </label>
                                        <input id="regulations-effective-date" class="form-input regulations-effective-date-input" type="date" value="${esc(state.effectiveAt || '')}" aria-label="按日期查看适用版本" title="选择日期查阅当时有效版本">
                                        ${isDateFiltered ? `<button class="btn-secondary regulations-effective-date-clear-btn" type="button" data-regulation-effective-date-clear="${esc(doc.id)}" title="清除日期筛选，恢复现行最新版本" aria-label="恢复现行版本">恢复现行</button>` : ''}
                                        <button class="btn-secondary regulations-effective-date-btn" type="button" data-regulation-effective-date="${esc(doc.id)}" title="定位并查阅指定日期生效版本">查询</button>
                                    </div>
                                    ${hasVersions ? `
                                        <span class="regulations-toolbar-inner-divider" aria-hidden="true"></span>
                                        <button class="btn-secondary" type="button" data-regulation-timeline="${esc(doc.id)}" title="查看该法规所有历史修订时间线">修订时间线</button>
                                        ${hasMultipleVersions ? `<button class="btn-secondary" type="button" data-regulation-compare="${esc(doc.id)}" title="对比不同版本条文差异">版本对比</button>` : ''}
                                    ` : ''}
                                </div>
                            `;
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
                                    ${versionValidityCluster}
                                    ${relationCluster}
                                    ${collabCluster}
                                </div>
                                ${adminCluster ? `<div class="regulations-toolbar-right-group">${adminCluster}</div>` : ''}
                            `);
                        }
                        if (formsHost) {
                            PivotSafeHtml.setHtml(formsHost, canManage() ? renderInlineEditor(doc, detail.currentVersion, { metadataReviewMode }) + renderVersionUploader(doc) : '');
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
                        const reviewEvidenceHeader = metadataReviewMode ? `
                            <div class="regulations-review-evidence-head">
                                <div><strong>法规原文</strong><span>审核依据</span></div>
                                <small>核对原文后再确认标题、层级、发布机构、效力日期与权威来源。</small>
                            </div>
                        ` : '';
                        const moreArticles = detail.articlesTruncated && articles.length
                            ? `<button type="button" class="btn-secondary regulations-load-more-articles" data-regulation-load-more="${esc(doc.id)}" data-regulation-load-more-offset="${articles.length}">加载更多条文</button>`
                            : '';
                        PivotSafeHtml.setHtml(target, bodyHtml
                            ? `${reviewEvidenceHeader}${indexNotice}${supersedeBanner}${bodyHtml}${moreArticles}`
                            : `${reviewEvidenceHeader}${indexNotice}${supersedeBanner}<div class="regulations-empty compact">${esc(title)} 暂无可查看的法规原文</div>`);
                        if (metadataReviewMode) {
                            target.scrollTop = Math.max(0, Number(state.metadataReviewEvidenceScrollTop) || 0);
                            target.onscroll = () => { state.metadataReviewEvidenceScrollTop = target.scrollTop; };
                        } else {
                            target.onscroll = null;
                        }
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

                    function renderInlineEditor(doc, version = {}, { metadataReviewMode = false } = {}) {
                        const assignees = Array.isArray(state.governanceAssignees) ? state.governanceAssignees : [];
                        const hasCurrentAssignee = assignees.some(item => Number(item.id) === Number(doc.maintainer_user_id));
                        const unavailableAssigneeOption = doc.maintainer_user_id && !hasCurrentAssignee
                            ? `<option value="${esc(doc.maintainer_user_id)}" selected>当前维护人（账户不可用）</option>`
                            : '';
                        const assigneeOptions = assignees.map(item => {
                            const label = [item.nickname || item.username || `用户 ${item.id}`, item.unit].filter(Boolean).join(' · ');
                            return `<option value="${esc(item.id)}" ${Number(item.id) === Number(doc.maintainer_user_id) ? 'selected' : ''}>${esc(label)}</option>`;
                        }).join('');
                        return `
                            <form id="regulations-edit-form" class="regulations-inline-form${metadataReviewMode ? ' regulations-metadata-review-form' : ''} hidden" data-doc-id="${esc(doc.id)}" data-version-id="${esc(version?.id || '')}">
                                <div class="regulations-dialog-head">
                                    <div>
                                        <h3>${metadataReviewMode ? '审核法规元数据' : '编辑法规信息'}</h3>
                                        <p>${metadataReviewMode ? '请以左侧法规原文为依据；确认必填信息完整、准确后再标记为已审核。' : '这些信息用于筛选、检索和问答引用。'}</p>
                                    </div>
                                </div>
                                ${metadataReviewMode ? '<div class="regulations-review-form-notice"><strong>审核提示</strong><span>“已审核”表示已根据当前版本原文完成核验；无法确认时请保留待审核或标记驳回。</span></div>' : ''}
                                <div class="regulations-admin-group">
                                    <div class="regulations-admin-grid">
                                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}" required></label>
                                        <label>法规层级<input name="legalLevel" class="form-input" maxlength="80" value="${esc(doc.legal_level || '')}" placeholder="如 法律、行政法规、部门规章" list="regulations-legal-level-list"></label>
                                        <label>分类<input name="category" class="form-input" maxlength="120" value="${esc(doc.category || '')}" list="regulations-category-list"></label>
                                        <label>发布机构（可多个）<input name="issuingBody" class="form-input" maxlength="120" value="${esc(doc.issuing_body || '')}" placeholder="用顿号或逗号分隔"></label>
                                        <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" value="${esc(doc.jurisdiction || '')}" list="regulations-jurisdiction-list"></label>
                                        <label>主题标签<input name="subjectTags" class="form-input" maxlength="300" value="${esc(Array.isArray(doc.subject_tags) ? doc.subject_tags.join('、') : doc.subject_tags || '')}" placeholder="用顿号或逗号分隔"></label>
                                        <label>维护人<select name="maintainerUserId" class="form-input"><option value="">未指派</option>${unavailableAssigneeOption}${assigneeOptions}</select></label>
                                        <label>元数据审核<select name="metadataReviewStatus" class="form-input"><option value="unreviewed" ${doc.metadata_review_status === 'unreviewed' ? 'selected' : ''}>待审核</option><option value="approved" ${doc.metadata_review_status === 'approved' ? 'selected' : ''}>已审核</option><option value="rejected" ${doc.metadata_review_status === 'rejected' ? 'selected' : ''}>驳回</option></select></label>
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
