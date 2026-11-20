(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const statuses = {
        draft: { label: '草稿', hint: '当前文稿可继续编辑。保存时系统重新检查内容。' },
        needs_attention: { label: '需处理', hint: '上次保存时发现阻断问题。打开文稿运行质量检查，修复并保存后可恢复为草稿。' },
        ready: { label: '已完成', hint: '此文稿已被标记为完成。再次编辑保存会重新评估状态。' },
        archived: { label: '已归档', hint: '此文稿已被标记为归档。' }
    };
    function setupStatusFilter(selected) {
        const filter = byId('presentation-library-status');
        if (!filter) return;
        filter.replaceChildren(new Option('全部状态', ''), ...Object.entries(statuses).map(([value, { label }]) => new Option(label, value)));
        filter.value = selected;
    }
    function render(state, options) {
        const { templateById, apiFetch, API } = options;
        setupStatusFilter(state.libraryFilters?.status || '');
        if (!(state.coverUrls instanceof Map)) state.coverUrls = new Map();
        state.coverUrls.forEach(url => URL.revokeObjectURL(url)); state.coverUrls.clear();
        const tableBody = byId('presentation-library-table-body'), legacyList = byId('presentation-library-list');
        if (legacyList) legacyList.replaceChildren();
        if (!tableBody) return;
        const focused = tableBody.contains(document.activeElement) ? document.activeElement : null;
        tableBody.replaceChildren();
        const total = state.documents.length, limit = Math.max(Number(state.libraryLimit) || 15, 1);
        const totalPages = Math.max(Math.ceil(total / limit), 1);
        state.libraryPage = Math.min(Math.max(Number(state.libraryPage) || 1, 1), totalPages);
        const startIndex = (state.libraryPage - 1) * limit;
        const pageDocs = state.documents.slice(startIndex, startIndex + limit);
        if (!total) {
            const tr = document.createElement('tr'), td = document.createElement('td');
            td.colSpan = 9; td.className = 'text-center presentation-table-empty';
            td.textContent = '暂无演示文稿。可从 AI 创建、空白创建或调整筛选条件开始。';
            tr.appendChild(td); tableBody.appendChild(tr);
            renderLibraryPagination(state, 0, limit, 1, options);
            return;
        }
        pageDocs.forEach((doc, idx) => {
            const action = doc.masterDraft ? 'open-master' : 'open';
            const tr = document.createElement('tr'); tr.dataset.presentationDocId = doc.id;
            if (doc.favorite) tr.classList.add('is-favorite');
            const tdIdx = document.createElement('td'); tdIdx.className = 'text-center'; tdIdx.textContent = String(startIndex + idx + 1);
            const tdTitle = document.createElement('td'), wrap = document.createElement('div'); wrap.className = 'presentation-table-title-cell';
            const dot = document.createElement('span'); dot.className = 'presentation-theme-dot';
            dot.style.backgroundColor = templateById(doc.template?.id)?.definition?.theme?.colors?.primary || 'var(--primary)';
            dot.title = templateById(doc.template?.id)?.name || doc.template?.name || '默认主题';
            wrap.appendChild(dot);
            const titleBtn = document.createElement('button'); titleBtn.type = 'button'; titleBtn.className = 'presentation-table-title-btn'; titleBtn.dataset.presentationAction = action; titleBtn.dataset.presentationId = doc.id; titleBtn.textContent = doc.title || '未命名演示文稿'; titleBtn.title = doc.title || '未命名演示文稿';
            wrap.appendChild(titleBtn);
            if (doc.favorite) { const fav = document.createElement('span'); fav.className = 'presentation-favorite-badge'; PivotSafeHtml.setHtml(fav, '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'); fav.title = '已收藏'; wrap.appendChild(fav); }
            tdTitle.appendChild(wrap);
            const tdTpl = document.createElement('td'); const tplName = templateById(doc.template?.id)?.name || doc.template?.name || '自定义主题'; tdTpl.textContent = tplName; tdTpl.title = tplName;
            const tdVer = document.createElement('td'); tdVer.className = 'text-center'; tdVer.textContent = doc.masterDraft ? '初稿' : 'v' + (doc.version || 1);
            const tdSt = document.createElement('td'), pill = document.createElement('span');
            tdSt.className = 'text-center';
            const status = doc.status || 'draft', { label, hint } = statuses[status] || statuses.draft;
            const pending = doc.generation?.pending.length;
            pill.className = 'presentation-status-pill ' + status;
            pill.textContent = pending ? `待补齐 ${pending} 页` : label;
            pill.title = pending ? '打开文稿并点击「补齐缺页」。' : hint;
            tdSt.appendChild(pill);
            const tdRole = document.createElement('td'); tdRole.className = 'text-center'; const badge = document.createElement('span');
            if (doc.isOwner !== false) { badge.className = 'presentation-role-badge is-owner'; badge.textContent = '我创建的'; }
            else { badge.className = 'presentation-role-badge is-shared'; const rt = ({ editor: '可编辑', commenter: '可评论', viewer: '只读' }[doc.collaboratorRole] || '协作者'); badge.textContent = '共享 · ' + rt; badge.title = '共享文档（' + rt + '）'; }
            tdRole.appendChild(badge);
            const tdTags = document.createElement('td'); const tags = Array.isArray(doc.tags) ? doc.tags : [];
            if (tags.length) { const sp = document.createElement('span'); sp.className = 'presentation-tag-text'; sp.textContent = tags.map(t => '#' + t).join(' '); sp.title = tags.join(', '); tdTags.appendChild(sp); }
            else { const em = document.createElement('span'); em.className = 'presentation-empty-dash'; em.textContent = '-'; tdTags.appendChild(em); }
            const tdTime = document.createElement('td'); const ft = formatTime(doc.updatedAt); tdTime.textContent = ft; tdTime.title = ft;
            const tdAct = document.createElement('td'); tdAct.className = 'text-center'; const acts = document.createElement('div'); acts.className = 'presentation-row-actions';
            const commands = [['打开', action, 'btn-primary']];
            if (!doc.masterDraft) {
                commands.push([doc.favorite ? '取消收藏' : '收藏', 'favorite', 'btn-secondary']);
                if (doc.isOwner !== false || doc.collaboratorRole === 'editor') commands.push(['标签', 'tags', 'btn-secondary']);
                if (doc.isOwner !== false) commands.push(['复制', 'duplicate', 'btn-secondary'], ['删除', 'delete', 'btn-secondary btn-danger-hover']);
            }
            commands.forEach(([lbl, act, cls]) => {
                const btn = document.createElement('button'); btn.type = 'button'; btn.className = cls; btn.textContent = lbl; btn.dataset.presentationAction = act; btn.dataset.presentationId = doc.id; btn.dataset.presentationFavorite = doc.favorite ? 'true' : 'false'; btn.dataset.presentationTags = JSON.stringify(tags); acts.appendChild(btn);
            });
            tdAct.appendChild(acts);
            tr.append(tdIdx, tdTitle, tdTpl, tdVer, tdSt, tdRole, tdTags, tdTime, tdAct); tableBody.appendChild(tr);
            if (doc.coverAssetRef) {
                apiFetch(API + '/assets/content/by-ref?ref=' + encodeURIComponent(doc.coverAssetRef) + '&presentationId=' + encodeURIComponent(doc.id)).then(res => res.ok ? res.blob() : null).then(blob => {
                    if (!blob || !tr.isConnected) return; const url = URL.createObjectURL(blob); state.coverUrls.set(doc.id, url); dot.style.backgroundImage = 'url(\"' + url + '\")'; dot.style.backgroundSize = 'cover'; dot.style.backgroundPosition = 'center';
                }).catch(() => { });
            }
        });
        renderLibraryPagination(state, total, limit, state.libraryPage, options);
        if (focused) {
            const replacement = [...tableBody.querySelectorAll('button')].find(button => button.dataset.presentationId === focused.dataset.presentationId
                && button.dataset.presentationAction === focused.dataset.presentationAction && button.className === focused.className);
            replacement?.focus({ preventScroll: true });
        }
    }
    function renderLibraryPagination(state, total, limit, page, options) {
        const pager = byId('presentation-library-pagination');
        if (!pager) return;
        const fn = window.Pivot?.legacy?.renderWorkspacePagination || window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
        if (typeof fn !== 'function') { pager.replaceChildren(); return; }
        fn(pager, { total, limit, page, onPageChange: p => { state.libraryPage = p; render(state, options); } });
    }
    function formatTime(value) {
        if (!value) return '刚刚更新';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }
    window.Pivot.exposeModule('apps.presentations.library', { render, formatTime });
})();
