/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderDocumentsReady) return;
    with (ns) {
            function renderDocuments() {
                        const target = document.getElementById('regulations-doc-list');
                        if (!target) return;
                        if (!state.documents.length) {
                            PivotSafeHtml.setHtml(target, '<tr><td colspan="11" class="text-center">暂无法规文档</td></tr>');
                        } else {
                            const startIndex = (Math.max(Number(state.page || 1), 1) - 1) * Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
                            PivotSafeHtml.setHtml(target, state.documents.map((doc, index) => {
                                const title = esc(cleanDisplayTitle(doc.title || '未命名法规'));
                                const rowIndex = startIndex + index + 1;
                                return `
                                <tr class="regulations-doc-row">
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
                    }
                    function renderDetail() {
                        const target = document.getElementById('regulations-detail-body');
                        if (!target) return;
                        const detail = state.detail;
                        const adminActions = document.getElementById('regulations-detail-admin-actions');
                        const formsHost = document.getElementById('regulations-detail-forms');
                        if (!detail?.document) {
                            PivotSafeHtml.setHtml(target, '<div class="regulations-placeholder">请选择法规文档查看正文。</div>');
                            if (adminActions) PivotSafeHtml.setHtml(adminActions, '');
                            if (formsHost) PivotSafeHtml.setHtml(formsHost, '');
                            return;
                        }
                        const doc = detail.document;
                        const articles = Array.isArray(detail.articles) ? detail.articles : [];
                        const title = cleanDisplayTitle(doc.title || '未命名法规');
                        // 管理员可在详情弹窗内编辑信息、追加版本；引用网络对所有人可见（只读）
                        if (adminActions) {
                            const graphBtn = `<button class="btn-secondary" type="button" data-regulation-graph="${esc(doc.id)}">引用网络</button>`;
                            const timelineBtn = (Array.isArray(detail.versions) && detail.versions.length >= 1)
                                ? `<button class="btn-secondary" type="button" data-regulation-timeline="${esc(doc.id)}">修订时间线</button>` : '';
                            PivotSafeHtml.setHtml(adminActions, graphBtn + timelineBtn + (canManage() ? `
                                <button class="btn-secondary" type="button" data-regulation-edit="${esc(doc.id)}">编辑信息</button>
                                <button class="btn-secondary" type="button" data-regulation-add-version="${esc(doc.id)}">追加版本</button>
                            ` : ''));
                        }
                        if (formsHost) {
                            PivotSafeHtml.setHtml(formsHost, canManage() ? renderInlineEditor(doc) + renderVersionUploader(doc) : '');
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
                                const articleAnchor = `${doc.id}.${article.id}`;
                                const annotateBtn = `<button class="regulations-article-tool regulations-article-annotate" type="button" data-regulation-annotate="${articleId}">批注${annotationCount ? ` · ${annotationCount}` : ''}</button>`;
                                const tools = [
                                    statusBadge,
                                    supersededBadge,
                                    `<button class="regulations-article-tool" type="button" data-article-copy="${articleId}">复制</button>`,
                                    `<button class="regulations-article-tool" type="button" data-article-ask="${articleId}">提问</button>`,
                                    `<button class="regulations-article-tool" type="button" data-article-link="${esc(articleAnchor)}">定位</button>`,
                                    `<button class="regulations-article-tool" type="button" data-regulation-similar="${articleId}">相似</button>`,
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
                            ? `${supersedeBanner}${bodyHtml}`
                            : `${supersedeBanner}<div class="regulations-empty compact">${esc(title)} 暂无可查看的法规原文</div>`);
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

                    function renderInlineEditor(doc) {
                        return `
                            <form id="regulations-edit-form" class="regulations-inline-form hidden" data-doc-id="${esc(doc.id)}">
                                <div class="regulations-dialog-head">
                                    <div>
                                        <h3>编辑法规信息</h3>
                                        <p>这些信息用于筛选、检索和问答引用。</p>
                                    </div>
                                </div>
                                <div class="regulations-admin-group">
                                    <div class="regulations-admin-grid">
                                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}" required></label>
                                        <label>\u7248\u672c\u6807\u8bc6<input name="versionLabel" class="form-input" maxlength="80" value="${esc(doc.current_version_label || '')}" placeholder="\u5982 2024\u5e74\u4fee\u6b63\u30012020\u5e74\u4fee\u8ba2"></label>
                                        <label>分类<input name="category" class="form-input" maxlength="120" value="${esc(doc.category || '')}" list="regulations-category-list"></label>
                                        <label>发布机构<input name="issuingBody" class="form-input" maxlength="120" value="${esc(doc.issuing_body || '')}"></label>
                                        <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" value="${esc(doc.jurisdiction || '')}" list="regulations-jurisdiction-list"></label>
                                        <label>状态<select name="status" class="form-input">
                                            <option value="active" ${doc.status !== 'archived' ? 'selected' : ''}>启用</option>
                                            <option value="archived" ${doc.status === 'archived' ? 'selected' : ''}>归档</option>
                                        </select></label>
                                    </div>
                                    <label>摘要<textarea name="summary" class="form-input" rows="3">${esc(doc.summary || '')}</textarea></label>
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
                                    </div>
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
            renderDocuments,
            renderDetail,
            renderArticleStatusBadge,
            renderInlineEditor,
            renderVersionUploader,
            renderDocumentsReady: true
        });
    }
})();
