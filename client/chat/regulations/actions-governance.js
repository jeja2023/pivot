(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsGovernanceReady) return;

    const { API, state, esc, toast, fetchJson, regulationConfirm, fmtDate } = ns;
    const setBusy = (...args) => ns.setBusy?.(...args);
    const collectForm = (...args) => ns.collectForm?.(...args);

    async function showAnnotations(articleId) {
        const panel = document.getElementById('regulations-annotation-panel');
        const body = document.getElementById('regulations-annotation-body');
        if (!panel || !body) return;
        panel.dataset.articleId = articleId;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载批注…</div>');
        try {
            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`);
            renderAnnotations(body, Array.isArray(resp.annotations) ? resp.annotations : [], articleId);
        } catch (e) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(e.message || '加载批注失败')}</div>`);
        }
    }

    async function showAccessLogs(documentId) {
        const panel = document.getElementById('regulations-access-log-panel');
        const body = document.getElementById('regulations-access-log-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载访问记录…</div>');
        try {
            const data = await fetchJson(`${API}/access-logs?documentId=${encodeURIComponent(documentId)}&limit=100`);
            const rows = Array.isArray(data.data) ? data.data : [];
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead>
                        <tbody>${rows.map(row => `<tr><td>${esc(fmtDate(row.created_at))}</td><td>${esc(row.user_name || '-')}</td><td>${esc(row.action || '-')}</td><td>${esc(row.detail || '-')}</td></tr>`).join('')}</tbody>
                    </table>
                </div>` : '<div class="regulations-empty compact">暂无访问记录</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载访问记录失败')}</div>`);
        }
    }

    async function showRegulationAiLogs(documentId) {
        const panel = document.getElementById('regulations-ai-log-panel');
        const body = document.getElementById('regulations-ai-log-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取问答审计记录…</div>');
        try {
            const data = await fetchJson(`${API}/ai-logs?documentId=${encodeURIComponent(documentId)}&limit=30`);
            const rows = Array.isArray(data.data) ? data.data : [];
            const sourceLabels = item => {
                const sources = Array.isArray(item.sources_json) ? item.sources_json : [];
                return sources.map(source => source.label || '').filter(Boolean).join('；') || '未命中可用依据';
            };
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="regulations-ai-audit-list">
                    ${rows.map(row => `<article class="regulations-ai-audit-item">
                        <div class="regulations-annotation-meta"><strong>${esc(row.question || '未命名问题')}</strong><span>${esc(fmtDate(row.created_at))}</span></div>
                        <div class="regulations-ai-audit-model">模型：${esc(row.model_name || '-')} · 依据：${esc(sourceLabels(row))}</div>
                        <details><summary>查看回答与依据快照</summary><div class="regulations-ai-audit-answer">${esc(row.answer || '模型未返回正文')}</div><div class="regulations-ai-audit-context">${esc(row.context_snapshot || '未保存上下文快照')}</div></details>
                    </article>`).join('')}
                </div>` : '<div class="regulations-empty compact">该法规暂无你的问答记录。</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载问答记录失败')}</div>`);
        }
    }

    async function showArticleLocations(articleId) {
        const panel = document.getElementById('regulations-location-panel');
        const body = document.getElementById('regulations-location-body');
        if (!panel || !body || !articleId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取条文来源定位…</div>');
        try {
            const data = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/locations`);
            const locations = Array.isArray(data.locations) ? data.locations : [];
            const source = data.source || {};
            const firstPage = Number(locations[0]?.page_number || 1);
            const sourceAction = source.downloadUrl ? `
                <div class="regulations-admin-actions regulations-source-actions">
                    ${source.previewUrl ? `<a class="btn-secondary" href="${esc(source.previewUrl)}#page=${firstPage}" target="_blank" rel="noopener">打开来源 PDF（第 ${firstPage} 页）</a>` : ''}
                    <a class="btn-secondary" href="${esc(source.downloadUrl)}" target="_blank" rel="noopener">下载同版本原文件${source.fileName ? `：${esc(source.fileName)}` : ''}</a>
                </div>` : '';
            PivotSafeHtml.setHtml(body, locations.length ? `
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>页码</th><th>字符范围</th><th>定位置信度</th></tr></thead>
                        <tbody>${locations.map(location => `<tr><td>第 ${Number(location.page_number || 1)} 页</td><td>${Number(location.char_start || 0)} - ${Number(location.char_end || 0)}</td><td>${Math.round(Number(location.confidence || 0) * 100)}%</td></tr>`).join('')}</tbody>
                    </table>
                </div>${sourceAction}` : `<div class="regulations-empty compact">该条文尚未生成可用来源定位。重新导入或完成页级文字识别后可补全。</div>${sourceAction}`);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载条文来源定位失败')}</div>`);
        }
    }

    function renderQualityMetric(label, value, hint = '') {
        return `<div class="regulations-quality-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
    }

    async function showQualitySummary() {
        const panel = document.getElementById('regulations-quality-panel');
        const body = document.getElementById('regulations-quality-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在汇总法规质量信息…</div>');
        try {
            const data = await fetchJson(`${API}/quality-summary`);
            const summary = data.summary || {};
            const documents = summary.documents || {};
            const versions = summary.versions || {};
            const links = summary.links || {};
            const locations = summary.locations || {};
            const obligations = summary.obligations || {};
            PivotSafeHtml.setHtml(body, `
                <div class="regulations-quality-grid">
                    ${renderQualityMetric('法规文档', documents.total)}
                    ${renderQualityMetric('元数据待审核', documents.metadataNeedsReview, '含缺少层级、来源或审核信息')}
                    ${renderQualityMetric('缺少维护人', documents.missingMaintainer)}
                    ${renderQualityMetric('版本待治理', versions.governanceNeedsReview, '效力或审核状态未确认')}
                    ${renderQualityMetric('索引未完成', versions.indexingIncomplete)}
                    ${renderQualityMetric('未解析引用', links.unresolved)}
                    ${renderQualityMetric('引用待审核', links.needsReview)}
                    ${renderQualityMetric('条文缺少定位', locations.articlesWithoutLocation)}
                    ${renderQualityMetric('义务待审核', obligations.needsReview)}
                </div>
                <div class="regulations-quality-note">“现行有效”仅表示已由管理员填写并审核的版本状态；请继续以权威来源和组织正式意见为准。</div>
            `);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载质量概览失败')}</div>`);
        }
    }

    async function toggleRegulationSubscription(documentId) {
        if (!documentId) return;
        try {
            const subscriptions = await fetchJson(`${API}/subscriptions?documentId=${encodeURIComponent(documentId)}`);
            const active = Array.isArray(subscriptions.subscriptions) && subscriptions.subscriptions.length > 0;
            if (active) {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, { method: 'DELETE' });
                toast('已取消关注法规更新', 'success');
            } else {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approvedOnly: true })
                });
                toast('已关注审核通过的法规更新', 'success');
            }
            const button = document.querySelector(`[data-regulation-subscribe="${String(documentId).replace(/"/g, '\\"')}"]`);
            if (button) button.textContent = active ? '关注更新' : '取消关注';
        } catch (error) {
            toast(error.message || '关注法规更新失败', 'error');
        }
    }

    async function toggleRegulationBookmark(documentId) {
        if (!documentId) return;
        try {
            const data = await fetchJson(`${API}/bookmarks?documentId=${encodeURIComponent(documentId)}`);
            const existing = Array.isArray(data.bookmarks) ? data.bookmarks[0] : null;
            if (existing?.id) {
                await fetchJson(`${API}/bookmarks/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
                toast('已取消收藏法规', 'success');
            } else {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                toast('已收藏法规，可在“我的收藏”中设置专题', 'success');
            }
            const button = document.querySelector(`[data-regulation-bookmark="${String(documentId).replace(/"/g, '\\"')}"]`);
            if (button) button.textContent = existing?.id ? '收藏法规' : '取消收藏';
        } catch (error) {
            toast(error.message || '更新法规收藏失败', 'error');
        }
    }

    function renderRegulationBookmarks(bookmarks) {
        if (!bookmarks.length) return '<div class="regulations-empty compact">暂无收藏。打开法规原文后，点击“收藏法规”即可加入这里。</div>';
        return `<div class="regulations-bookmark-list">${bookmarks.map(item => `
            <article class="regulations-bookmark-item">
                <div><strong>${esc(item.document_title || '未命名法规')}</strong><span>${esc([item.category, item.issuing_body, item.current_version_label].filter(Boolean).join(' · ') || '未设置分类')}</span></div>
                <label>专题<input class="form-input" data-regulation-bookmark-topic="${esc(item.id)}" value="${esc(item.topic || '')}" maxlength="80" placeholder="如 人事、采购、财务"></label>
                <div class="regulations-admin-actions">
                    <button type="button" class="btn-secondary" data-regulation-bookmark-open="${esc(item.document_id)}">打开法规</button>
                    <button type="button" class="btn-secondary" data-regulation-bookmark-save="${esc(item.id)}" data-regulation-bookmark-document="${esc(item.document_id)}">保存专题</button>
                    <button type="button" class="btn-secondary" data-regulation-bookmark-delete="${esc(item.id)}">取消收藏</button>
                </div>
            </article>`).join('')}</div>`;
    }

    async function showRegulationBookmarks() {
        const panel = document.getElementById('regulations-bookmarks-panel');
        const body = document.getElementById('regulations-bookmarks-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取收藏法规…</div>');
        try {
            const data = await fetchJson(`${API}/bookmarks`);
            PivotSafeHtml.setHtml(body, renderRegulationBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []));
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载收藏法规失败')}</div>`);
        }
    }

    async function saveRegulationBookmarkTopic(bookmarkId, documentId) {
        const field = document.querySelector(`[data-regulation-bookmark-topic="${String(bookmarkId).replace(/"/g, '\\"')}"]`);
        if (!bookmarkId || !documentId || !field) return;
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: field.value.trim() })
            });
            toast('收藏专题已保存', 'success');
            await showRegulationBookmarks();
        } catch (error) {
            toast(error.message || '保存收藏专题失败', 'error');
        }
    }

    async function deleteRegulationBookmark(bookmarkId) {
        if (!bookmarkId) return;
        try {
            await fetchJson(`${API}/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' });
            toast('已取消收藏法规', 'success');
            await showRegulationBookmarks();
        } catch (error) {
            toast(error.message || '取消收藏失败', 'error');
        }
    }

    async function showRegulationRecycleBin() {
        if (!ns.canDeleteDocuments?.()) return;
        const panel = document.getElementById('regulations-recycle-bin-panel');
        const body = document.getElementById('regulations-recycle-bin-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取法规回收站…</div>');
        try {
            const data = await fetchJson(`${API}/recycle-bin?limit=100`);
            const rows = Array.isArray(data.data) ? data.data : [];
            PivotSafeHtml.setHtml(body, rows.length ? `
                <div class="table-container workspace-table-wrap"><table class="data-table compact-table">
                    <thead><tr><th>法规</th><th>分类</th><th>删除时间</th><th>操作</th></tr></thead>
                    <tbody>${rows.map(item => `<tr><td>${esc(item.title || '-')}</td><td>${esc(item.category || '-')}</td><td>${esc(fmtDate(item.deleted_at))}</td><td><button type="button" class="btn-secondary" data-regulation-restore="${esc(item.id)}">恢复</button></td></tr>`).join('')}</tbody>
                </table></div>` : '<div class="regulations-empty compact">回收站为空。</div>');
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载法规回收站失败')}</div>`);
        }
    }

    async function requestRegulationReindex(documentId, versionId) {
        if (!documentId || !versionId || !ns.canManage?.()) return;
        setBusy(true, '正在重新排队向量索引…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/reindex`, { method: 'POST' });
            toast('向量索引已重新排队；失败时会按退避策略有限重试', 'success');
            await ns.loadDetail?.(documentId, versionId);
        } catch (error) {
            toast(error.message || '重新建立向量索引失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function restoreRegulationFromRecycleBin(documentId) {
        if (!documentId || !ns.canDeleteDocuments?.()) return;
        if (!(await regulationConfirm('恢复法规', '恢复后该法规会重新出现在法规目录和检索结果中。确认恢复？'))) return;
        setBusy(true, '正在恢复法规…');
        try {
            await fetchJson(`${API}/recycle-bin/${encodeURIComponent(documentId)}/restore`, { method: 'POST' });
            toast('法规已恢复', 'success');
            await showRegulationRecycleBin();
            await ns.loadDocuments?.({ keepActive: true, page: state.page });
            await ns.loadFacets?.();
        } catch (error) {
            toast(error.message || '恢复法规失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderObligationForm(documentId, versionId, articleId, assignees = []) {
        const assigneeOptions = (Array.isArray(assignees) ? assignees : []).map(item => {
            const label = [item.nickname || item.username || `用户 ${item.id}`, item.unit].filter(Boolean).join(' · ');
            return `<option value="${esc(item.id)}">${esc(label)}</option>`;
        }).join('');
        return `
            <form class="regulations-obligation-form" data-obligation-document="${esc(documentId)}" data-obligation-version="${esc(versionId)}" data-obligation-article="${esc(articleId)}">
                <div class="regulations-admin-group">
                    <div class="regulations-admin-grid">
                        <label>适用主体<input name="subject" class="form-input" maxlength="240" placeholder="如 用人单位"></label>
                        <label>触发条件<input name="triggerCondition" class="form-input" maxlength="1000" placeholder="如 发生法定备案事项"></label>
                        <label>要求动作<input name="requiredAction" class="form-input" maxlength="1000" placeholder="必填，如 完成备案" required></label>
                        <label>期限规则<input name="dueRule" class="form-input" maxlength="500" placeholder="如 三十日内"></label>
                        <label>责任人<select name="ownerUserId" class="form-input"><option value="">审核后待分派</option>${assigneeOptions}</select></label>
                    </div>
                    <label>留存凭证<input name="evidenceRequirement" class="form-input" maxlength="1000" placeholder="如 备案回执"></label>
                </div>
                <div class="regulations-admin-actions"><button class="btn-primary" type="submit">保存为待审核义务</button></div>
            </form>`;
    }

    async function showRegulationObligations(documentId, articleId = '') {
        const panel = document.getElementById('regulations-obligation-panel');
        const body = document.getElementById('regulations-obligation-body');
        if (!panel || !body || !documentId) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载合规义务…</div>');
        try {
            const query = articleId ? `?articleId=${encodeURIComponent(articleId)}` : '';
            const data = await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations${query}`);
            const obligations = Array.isArray(data.obligations) ? data.obligations : [];
            const assignees = Array.isArray(data.assignees) ? data.assignees : [];
            const versionId = state.detail?.currentVersion?.id || '';
            const canCreate = Boolean(articleId && versionId && ns.canManage?.());
            const reviewLabel = item => item.review_status === 'approved' ? '已审核' : (item.review_status === 'rejected' ? '已驳回' : '待审核');
            const reviewAction = item => ns.canManage?.() && item.review_status !== 'approved'
                ? `<button type="button" class="btn-secondary regulations-obligation-review" data-regulation-obligation-review="${esc(item.id)}" data-regulation-obligation-document="${esc(documentId)}">审核并转为待办</button>`
                : '';
            const obligationRows = obligations.length
                ? obligations.map(item => {
                    const ownerLabel = item.owner_nickname || item.owner_username || '-';
                    return `<tr><td>${esc(item.article_label || '-')}</td><td>${esc(item.subject || '-')}</td><td>${esc(item.required_action || '-')}</td><td>${esc(item.due_rule || '-')}</td><td>${esc(ownerLabel)}</td><td><span>${esc(reviewLabel(item))}</span>${reviewAction(item)}</td></tr>`;
                }).join('')
                : '<tr><td colspan="6" class="text-center">暂无义务事项</td></tr>';
            PivotSafeHtml.setHtml(body, `
                ${canCreate ? renderObligationForm(documentId, versionId, articleId, assignees) : ''}
                <div class="table-container workspace-table-wrap">
                    <table class="data-table compact-table">
                        <thead><tr><th>条文</th><th>主体</th><th>要求动作</th><th>期限</th><th>责任人</th><th>审核/待办</th></tr></thead>
                        <tbody>${obligationRows || '暂无义务事项'}</tbody>
                    </table>
                </div>
            `);
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载合规义务失败')}</div>`);
        }
    }

    async function submitRegulationObligation(form) {
        const documentId = form.dataset.obligationDocument;
        const versionId = form.dataset.obligationVersion;
        const articleId = form.dataset.obligationArticle;
        const payload = collectForm(form);
        setBusy(true, '正在保存合规义务…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/articles/${encodeURIComponent(articleId)}/obligations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            toast('义务事项已保存，等待人工审核', 'success');
            await showRegulationObligations(documentId, articleId);
        } catch (error) {
            toast(error.message || '保存合规义务失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function reviewRegulationObligation(documentId, obligationId) {
        if (!documentId || !obligationId) return;
        setBusy(true, '正在确认合规义务…');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations/${encodeURIComponent(obligationId)}/review`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reviewStatus: 'approved', status: 'active' })
            });
            toast('义务已审核通过，可作为后续任务分派依据', 'success');
            await showRegulationObligations(documentId);
        } catch (error) {
            toast(error.message || '审核合规义务失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderAnnotations(body, annotations, articleId) {
        const currentUserId = (typeof currentUser !== 'undefined' ? currentUser : window.Pivot.legacy.currentUser)?.id;
        PivotSafeHtml.setHtml(body, `
            <form class="regulations-annotation-form" data-annotation-article="${esc(articleId)}">
                <textarea class="form-input" name="content" rows="3" placeholder="输入内部理解、适用案例或注意事项…" required></textarea>
                <div class="regulations-admin-actions">
                    <button type="submit" class="btn-primary">提交批注</button>
                </div>
            </form>
            <div class="regulations-annotation-list">
                ${annotations.length ? annotations.map(a => `
                    <div class="regulations-annotation-item">
                        <div class="regulations-annotation-meta">
                            <strong>${esc(a.user_name || '匿名')}</strong>
                            <span>${esc(a.updated_at || a.created_at || '')}</span>
                            ${Number(a.user_id) === Number(currentUserId) ? `<button class="btn-secondary regulations-annotation-delete" type="button" data-annotation-delete="${esc(a.id)}" data-annotation-article="${esc(articleId)}">删除</button>` : ''}
                        </div>
                        <div class="regulations-annotation-content">${esc(a.content)}</div>
                    </div>
                `).join('') : '<div class="regulations-empty compact">暂无批注，添加第一条吧</div>'}
            </div>
        `);
    }

    async function submitAnnotation(form) {
        const articleId = form.dataset.annotationArticle;
        const content = form.querySelector('[name="content"]')?.value?.trim();
        if (!content) {
            toast('请输入批注内容', 'warning');
            return;
        }
        try {
            await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            toast('批注已提交', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '提交失败', 'error');
        }
    }

    async function deleteAnnotation(annotationId, articleId) {
        if (!(await regulationConfirm('删除批注', '确定删除该批注吗？'))) return;
        try {
            await fetchJson(`${API}/annotations/${encodeURIComponent(annotationId)}`, { method: 'DELETE' });
            toast('批注已删除', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        }
    }

    Object.assign(ns, {
        showAnnotations,
        showAccessLogs,
        showRegulationAiLogs,
        showArticleLocations,
        renderQualityMetric,
        showQualitySummary,
        toggleRegulationSubscription,
        toggleRegulationBookmark,
        renderRegulationBookmarks,
        showRegulationBookmarks,
        saveRegulationBookmarkTopic,
        deleteRegulationBookmark,
        showRegulationRecycleBin,
        requestRegulationReindex,
        restoreRegulationFromRecycleBin,
        renderObligationForm,
        showRegulationObligations,
        submitRegulationObligation,
        reviewRegulationObligation,
        renderAnnotations,
        submitAnnotation,
        deleteAnnotation,
        actionsGovernanceReady: true
    });
})();
