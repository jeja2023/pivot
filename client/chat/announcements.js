/* 公告中心与后台公告管理 */
(function () {
    const TYPE_LABELS = {
        system: '系统',
        security: '安全',
        knowledge: '知识库',
        normal: '公告'
    };
    const PRIORITY_LABELS = {
        low: '低',
        normal: '普通',
        high: '重要',
        critical: '紧急'
    };
    const TARGET_LABELS = {
        all: '全员',
        unit: '单位',
        role: '角色',
        users: '用户'
    };
    const STATUS_LABELS = {
        draft: '草稿',
        published: '已发布',
        archived: '已归档'
    };

    const state = {
        items: [],
        polling: null,
        initialized: false,
        loginItems: [],
        adminRows: [],
        adminPermissions: null
    };

    const esc = (value) => (typeof escapeHtml === 'function')
        ? escapeHtml(value)
        : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

    const formatDate = (value) => {
        if (!value) return '-';
        return typeof formatDateToCN === 'function' ? formatDateToCN(value) : String(value);
    };

    const shouldShowAnnouncement = (item) => !item.dismissedAt || (item.requireAck && !item.acknowledgedAt);
    const canDismissAnnouncement = (item) => !(item.requireAck && !item.acknowledgedAt);

    const getCurrentUser = () => {
        if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
        return window.currentUser || null;
    };

    const apiJson = async (url, options = {}) => {
        const res = await apiFetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                ...(options.body ? { 'Content-Type': 'application/json' } : {})
            }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
    };

    function mountAnnouncementBell() {
        const bell = document.getElementById('announcement-bell');
        const brand = document.querySelector('.app-brand-mini');
        const brandText = brand?.querySelector('.brand-text-mini');
        if (!bell || !brand || bell.parentElement === brand) return;
        brand.insertBefore(bell, brandText?.nextSibling || null);
    }

    function ensureShell() {
        if (document.getElementById('announcement-root')) {
            mountAnnouncementBell();
            return;
        }
        const root = document.createElement('div');
        root.id = 'announcement-root';
        root.innerHTML = `
            <div id="announcement-banner" class="announcement-banner hidden"></div>
            <button id="announcement-bell" class="announcement-bell hidden" type="button" title="公告中心" aria-label="公告中心">
                <span class="announcement-bell-dot hidden" id="announcement-bell-dot"></span>
                <span>公告</span>
            </button>
            <aside id="announcement-center" class="announcement-center hidden" aria-label="公告中心">
                <div class="announcement-center-head">
                    <div>
                        <h3>公告中心</h3>
                        <p id="announcement-center-summary">暂无公告</p>
                    </div>
                    <button id="announcement-center-close" class="btn-secondary" type="button">关闭</button>
                </div>
                <div id="announcement-center-list" class="announcement-center-list"></div>
            </aside>
            <div id="announcement-ack-modal" class="announcement-ack-modal hidden">
                <div class="announcement-ack-dialog">
                    <span id="announcement-ack-type" class="announcement-chip">公告</span>
                    <h3 id="announcement-ack-title"></h3>
                    <div id="announcement-ack-content" class="announcement-ack-content"></div>
                    <button id="announcement-ack-btn" class="btn-primary" type="button">我已知晓并确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        mountAnnouncementBell();
        document.getElementById('announcement-bell')?.addEventListener('click', () => {
            document.getElementById('announcement-center')?.classList.toggle('hidden');
            markVisibleAnnouncementsRead();
        });
        document.getElementById('announcement-center-close')?.addEventListener('click', () => {
            document.getElementById('announcement-center')?.classList.add('hidden');
        });
        document.getElementById('announcement-ack-btn')?.addEventListener('click', async () => {
            const id = document.getElementById('announcement-ack-btn')?.dataset.id;
            if (!id) return;
            await ackAnnouncement(id);
        });
        document.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-announcement-action]');
            if (!action) return;
            const id = action.dataset.announcementId;
            if (action.dataset.announcementAction === 'dismiss') await dismissAnnouncement(id);
            if (action.dataset.announcementAction === 'ack') await ackAnnouncement(id);
            if (action.dataset.announcementAction === 'read') await markAnnouncementRead(id);
        });
    }

    function renderAnnouncements() {
        ensureShell();
        const active = state.items || [];
        const visible = active.filter(shouldShowAnnouncement);
        const unread = visible.filter(item => !item.readAt).length;
        const requiresAck = visible.filter(item => item.requireAck && !item.acknowledgedAt);
        const banner = document.getElementById('announcement-banner');
        const bell = document.getElementById('announcement-bell');
        const dot = document.getElementById('announcement-bell-dot');
        const summary = document.getElementById('announcement-center-summary');
        const list = document.getElementById('announcement-center-list');
        bell?.classList.toggle('hidden', visible.length === 0);
        dot?.classList.toggle('hidden', unread === 0);
        if (summary) summary.textContent = visible.length ? `${visible.length} 条有效公告，${unread} 条未读` : '暂无公告';

        const top = visible[0];
        if (banner) {
            banner.className = `announcement-banner ${top ? `is-${top.priority || 'normal'}` : 'hidden'}`;
            banner.innerHTML = top ? `
                <div>
                    <strong>${esc(top.title)}</strong>
                    <span>${esc(top.content)}</span>
                </div>
                <div class="announcement-banner-actions">
                    ${top.requireAck && !top.acknowledgedAt ? `<button class="btn-primary" type="button" data-announcement-action="ack" data-announcement-id="${top.id}">确认</button>` : ''}
                    ${canDismissAnnouncement(top) ? `<button class="btn-secondary" type="button" data-announcement-action="dismiss" data-announcement-id="${top.id}">不再提示</button>` : ''}
                </div>
            ` : '';
        }

        if (list) {
            if (!visible.length) {
                list.innerHTML = '<div class="announcement-empty">暂无有效公告</div>';
            } else {
                list.innerHTML = visible.map(item => `
                    <article class="announcement-card ${item.readAt ? '' : 'is-unread'} is-${esc(item.priority)}">
                        <div class="announcement-card-head">
                            <span class="announcement-chip">${TYPE_LABELS[item.type] || '公告'} · ${PRIORITY_LABELS[item.priority] || '普通'}</span>
                            <time>${formatDate(item.startsAt || item.createdAt)}</time>
                        </div>
                        <h4>${esc(item.title)}</h4>
                        <p>${esc(item.content)}</p>
                        <div class="announcement-card-actions">
                            ${item.requireAck && !item.acknowledgedAt ? `<button class="btn-primary" type="button" data-announcement-action="ack" data-announcement-id="${item.id}">确认</button>` : ''}
                            ${!item.readAt ? `<button class="btn-secondary" type="button" data-announcement-action="read" data-announcement-id="${item.id}">标为已读</button>` : ''}
                            ${canDismissAnnouncement(item) ? `<button class="btn-secondary" type="button" data-announcement-action="dismiss" data-announcement-id="${item.id}">不再提示</button>` : ''}
                        </div>
                    </article>
                `).join('');
            }
        }

        const ackModal = document.getElementById('announcement-ack-modal');
        const ackItem = requiresAck[0];
        if (ackModal && ackItem) {
            document.getElementById('announcement-ack-type').textContent = `${TYPE_LABELS[ackItem.type] || '公告'} · ${PRIORITY_LABELS[ackItem.priority] || '普通'}`;
            document.getElementById('announcement-ack-title').textContent = ackItem.title || '';
            document.getElementById('announcement-ack-content').textContent = ackItem.content || '';
            document.getElementById('announcement-ack-btn').dataset.id = String(ackItem.id);
            ackModal.classList.remove('hidden');
        } else {
            ackModal?.classList.add('hidden');
        }
    }

    function ensureLoginAnnouncementShell() {
        const authContainer = document.getElementById('auth-container');
        const authModal = authContainer?.querySelector('.modal');
        if (!authContainer) return null;
        let panel = document.getElementById('auth-announcements');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'auth-announcements';
        panel.className = 'auth-announcements hidden';
        panel.setAttribute('aria-label', '登录页公告');
        authContainer.insertBefore(panel, authModal || null);
        return panel;
    }

    function renderLoginAnnouncements() {
        const panel = ensureLoginAnnouncementShell();
        if (!panel) return;
        const items = state.loginItems || [];
        panel.classList.toggle('hidden', items.length === 0);
        panel.innerHTML = items.length ? `
            <div class="auth-announcements-head">
                <span>公告</span>
                <small>${items.length} 条</small>
            </div>
            <div class="auth-announcements-list">
                ${items.map(item => `
                    <article class="auth-announcement-item is-${esc(item.priority || 'normal')}">
                        <div>
                            <strong>${esc(item.title)}</strong>
                            <span>${esc(item.content)}</span>
                        </div>
                        <small>${esc(TYPE_LABELS[item.type] || '公告')} · ${esc(PRIORITY_LABELS[item.priority] || '普通')}</small>
                    </article>
                `).join('')}
            </div>
        ` : '';
    }

    async function loadLoginAnnouncements() {
        if (typeof apiFetch !== 'function') return;
        try {
            const data = await apiJson(`${API_BASE}/announcements/public`);
            state.loginItems = data.data || [];
            renderLoginAnnouncements();
        } catch (e) {
            state.loginItems = [];
            renderLoginAnnouncements();
            console.warn('Load login announcements failed:', e);
        }
    }

    async function loadActiveAnnouncements() {
        if (!getCurrentUser() || typeof apiFetch !== 'function') return;
        try {
            const data = await apiJson(`${API_BASE}/announcements/active`);
            state.items = data.data || [];
            renderAnnouncements();
        } catch (e) {
            console.warn('Load announcements failed:', e);
        }
    }

    async function markAnnouncementRead(id) {
        if (!id) return;
        await apiJson(`${API_BASE}/announcements/${encodeURIComponent(id)}/read`, { method: 'POST' });
        await loadActiveAnnouncements();
    }

    async function ackAnnouncement(id) {
        if (!id) return;
        await apiJson(`${API_BASE}/announcements/${encodeURIComponent(id)}/ack`, { method: 'POST' });
        await loadActiveAnnouncements();
    }

    async function dismissAnnouncement(id) {
        if (!id) return;
        await apiJson(`${API_BASE}/announcements/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
        await loadActiveAnnouncements();
    }

    async function markVisibleAnnouncementsRead() {
        const unread = (state.items || []).filter(item => shouldShowAnnouncement(item) && !item.readAt).slice(0, 20);
        await Promise.all(unread.map(item => apiJson(`${API_BASE}/announcements/${encodeURIComponent(item.id)}/read`, { method: 'POST' }).catch(() => null)));
        await loadActiveAnnouncements();
    }

    window.initAnnouncements = function () {
        ensureShell();
        if (!state.initialized) {
            state.initialized = true;
            state.polling = window.setInterval(loadActiveAnnouncements, 60000);
        }
        loadActiveAnnouncements();
    };
    window.loadLoginAnnouncements = loadLoginAnnouncements;

    const getFormPayload = () => ({
        title: document.getElementById('announcement-title')?.value.trim() || '',
        content: document.getElementById('announcement-content')?.value.trim() || '',
        type: document.getElementById('announcement-type')?.value || 'system',
        priority: document.getElementById('announcement-priority')?.value || 'normal',
        targetType: document.getElementById('announcement-target-type')?.value || 'all',
        targetValue: document.getElementById('announcement-target-value')?.value || '',
        startsAt: document.getElementById('announcement-starts-at')?.value || '',
        endsAt: document.getElementById('announcement-ends-at')?.value || '',
        status: document.getElementById('announcement-status')?.value || 'draft',
        requireAck: document.getElementById('announcement-require-ack')?.checked === true,
        showOnLogin: document.getElementById('announcement-show-login')?.checked === true
    });

    const toDateInput = (value) => value ? String(value).replace(' ', 'T').slice(0, 16) : '';

    function openAnnouncementModal(row = {}) {
        resetAnnouncementForm(row);
        applyAnnouncementPermissions(row);
        const modal = document.getElementById('announcement-modal');
        const title = document.getElementById('announcement-modal-title');
        if (title) title.textContent = row.id ? '编辑公告' : '新建公告';
        modal?.classList.remove('hidden');
        setTimeout(() => document.getElementById('announcement-title')?.focus(), 0);
    }

    function closeAnnouncementModal() {
        document.getElementById('announcement-modal')?.classList.add('hidden');
    }

    function closeAnnouncementDetailModal() {
        document.getElementById('announcement-detail-modal')?.classList.add('hidden');
    }

    function resetAnnouncementForm(row = {}) {
        const permissions = state.adminPermissions || {};
        const isNew = !row.id;
        const targetType = row.targetType || (isNew ? permissions.defaultTargetType : '') || 'all';
        const targetValue = row.targetValue ?? (isNew ? permissions.defaultTargetValue : '') ?? '';
        document.getElementById('announcement-id').value = row.id || '';
        document.getElementById('announcement-title').value = row.title || '';
        document.getElementById('announcement-content').value = row.content || '';
        document.getElementById('announcement-type').value = row.type || 'system';
        document.getElementById('announcement-priority').value = row.priority || 'normal';
        document.getElementById('announcement-target-type').value = targetType;
        document.getElementById('announcement-target-value').value = targetValue;
        document.getElementById('announcement-starts-at').value = toDateInput(row.startsAt);
        document.getElementById('announcement-ends-at').value = toDateInput(row.endsAt);
        document.getElementById('announcement-status').value = row.status || 'draft';
        document.getElementById('announcement-require-ack').checked = row.requireAck === true;
        document.getElementById('announcement-show-login').checked = row.showOnLogin === true;
        document.getElementById('announcement-target-value').disabled = targetType === 'all';
    }

    function applyAnnouncementPermissions(row = {}) {
        const permissions = state.adminPermissions || {};
        const allowedTargetTypes = permissions.allowedTargetTypes || ['all', 'unit', 'role', 'users'];
        const targetTypeSelect = document.getElementById('announcement-target-type');
        const targetValueInput = document.getElementById('announcement-target-value');
        const showLoginInput = document.getElementById('announcement-show-login');
        const showLoginRow = showLoginInput?.closest('.announcement-login-row');
        const saveBtn = document.getElementById('announcement-save-btn');
        if (targetTypeSelect) {
            Array.from(targetTypeSelect.options).forEach(option => {
                option.hidden = !allowedTargetTypes.includes(option.value);
                option.disabled = !allowedTargetTypes.includes(option.value);
            });
            if (!allowedTargetTypes.includes(targetTypeSelect.value)) {
                targetTypeSelect.value = permissions.defaultTargetType || allowedTargetTypes[0] || 'all';
            }
            targetTypeSelect.disabled = allowedTargetTypes.length === 1;
        }
        if (targetValueInput) {
            const lockedUnitTarget = !permissions.canManageAll && (targetTypeSelect?.value || '') === 'unit';
            targetValueInput.disabled = targetTypeSelect?.value === 'all';
            targetValueInput.readOnly = lockedUnitTarget;
            if (!row.id && permissions.defaultTargetValue && targetTypeSelect?.value === permissions.defaultTargetType) {
                targetValueInput.value = permissions.defaultTargetValue;
            }
        }
        if (showLoginInput) {
            const canShowOnLogin = permissions.canShowOnLogin === true;
            const canUseCurrentTarget = (targetTypeSelect?.value || 'all') === 'all';
            showLoginRow?.classList.toggle('hidden', !canShowOnLogin);
            showLoginInput.disabled = !canShowOnLogin || !canUseCurrentTarget;
            if (!canShowOnLogin || !canUseCurrentTarget) showLoginInput.checked = false;
        }
        if (saveBtn) saveBtn.disabled = row.id ? row.canEdit === false : permissions.canCreate === false;
    }

    function openAnnouncementDetailModal(row) {
        if (!row) return;
        const title = document.getElementById('announcement-detail-title');
        const summary = document.getElementById('announcement-detail-summary');
        const meta = document.getElementById('announcement-detail-meta');
        const content = document.getElementById('announcement-detail-content');
        if (title) title.textContent = row.title || '公告详情';
        if (summary) {
            summary.textContent = `${TYPE_LABELS[row.type] || row.type || '公告'} · ${PRIORITY_LABELS[row.priority] || row.priority || '普通'} · ${STATUS_LABELS[row.status] || row.status || '草稿'}`;
        }
        if (meta) {
            const targetText = row.targetType === 'all'
                ? '全员'
                : `${TARGET_LABELS[row.targetType] || row.targetType || '范围'}：${row.targetValue || '-'}`;
            meta.innerHTML = [
                ['投放范围', targetText],
                ['登录页展示', row.showOnLogin ? '是' : '否'],
                ['确认要求', row.requireAck ? `需要确认，已确认 ${row.ackCount || 0} 人` : '无需确认'],
                ['阅读情况', `已读 ${row.readCount || 0} 人`],
                ['开始时间', formatDate(row.startsAt)],
                ['结束时间', formatDate(row.endsAt)],
                ['创建人', row.createdByName || '-'],
                ['创建时间', formatDate(row.createdAt)],
                ['更新时间', formatDate(row.updatedAt)]
            ].map(([label, value]) => `
                <div class="announcement-detail-meta-item">
                    <span>${esc(label)}</span>
                    <strong>${esc(value)}</strong>
                </div>
            `).join('');
        }
        if (content) content.textContent = row.content || '';
        document.getElementById('announcement-detail-modal')?.classList.remove('hidden');
    }

    window.loadAnnouncementsAdmin = async function (page = 1) {
        if (currentUser?.role !== 'admin') return;
        const body = document.getElementById('announcement-list-body');
        if (!body) return;
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(pageState?.limit || 15),
                status: document.getElementById('announcement-status-filter')?.value || '',
                search: document.getElementById('announcement-search')?.value || ''
            });
            const data = await apiJson(`${API_BASE}/admin/announcements?${params.toString()}`);
            state.adminRows = data.data || [];
            state.adminPermissions = data.permissions || null;
            const offset = ((data.page || page || 1) - 1) * (data.limit || pageState?.limit || 15);
            document.getElementById('announcement-new-btn')?.toggleAttribute('disabled', data.permissions?.canCreate === false);
            if (!state.adminRows.length) {
                renderTableMessage(body, 10, '暂无公告', { color: 'var(--text-muted)' });
            } else {
                body.innerHTML = state.adminRows.map((row, index) => {
                    const typeClass = esc(row.type);
                    const priorityClass = esc(row.priority);
                    const isAll = row.targetType === 'all';
                    return `
                        <tr>
                            <td class="text-center announcement-index">${offset + index + 1}</td>
                            <td title="${esc(row.title)}">
                                <strong>${esc(row.title)}</strong>
                            </td>
                            <td><span class="announcement-tag type-${typeClass}">${esc(TYPE_LABELS[row.type] || row.type)}</span></td>
                            <td><span class="announcement-tag priority-${priorityClass}">${esc(PRIORITY_LABELS[row.priority] || row.priority)}</span></td>
                            <td>
                                ${isAll 
                                    ? `<span class="announcement-target-badge is-all">全员</span>` 
                                    : `<span class="announcement-target-badge is-specific">${esc(TARGET_LABELS[row.targetType] || row.targetType)}</span><br><small class="text-muted" title="${esc(row.targetValue)}">${esc(row.targetValue)}</small>`
                                }
                            </td>
                            <td class="text-center">
                                <span class="announcement-login-pill ${row.showOnLogin ? 'is-visible' : 'is-hidden'}">
                                    ${row.showOnLogin ? '是' : '否'}
                                </span>
                            </td>
                            <td><span class="announcement-status-pill is-${esc(row.status)}">${STATUS_LABELS[row.status] || row.status}</span></td>
                            <td>${row.requireAck ? `${row.ackCount || 0} 人` : '<span class="text-muted">无需</span>'}</td>
                            <td>${formatDate(row.updatedAt)}</td>
                            <td class="text-center announcement-actions-cell">
                                <button class="btn-secondary" type="button" data-announcement-admin="detail" data-id="${row.id}">详情</button>
                                ${row.canEdit === false ? '' : `
                                    <button class="btn-secondary" type="button" data-announcement-admin="toggle-status" data-id="${row.id}" data-status="${row.status}">
                                        ${row.status === 'published' ? '撤下' : '发布'}
                                    </button>
                                `}
                                ${row.canEdit === false ? '' : `<button class="btn-secondary" type="button" data-announcement-admin="edit" data-id="${row.id}">编辑</button>`}
                                ${row.canDelete === false ? '' : `<button class="btn-danger" type="button" data-announcement-admin="delete" data-id="${row.id}">删除</button>`}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
            renderPagination?.('announcements', data.total || 0, page);
            window.scheduleSettingsWorkspaceScale?.();
        } catch (e) {
            renderTableMessage(body, 10, e.message, { color: 'var(--danger)' });
        }
    };

    async function saveAnnouncement(event) {
        event.preventDefault();
        const id = document.getElementById('announcement-id')?.value || '';
        const payload = getFormPayload();
        if (!payload.title || !payload.content) return showToast?.('请填写公告标题和内容', 'error');
        if (payload.targetType !== 'all' && !payload.targetValue.trim()) return showToast?.('请填写投放范围', 'error');
        if (payload.showOnLogin && payload.targetType !== 'all') return showToast?.('登录页公告必须面向全员投放', 'error');
        try {
            await apiJson(id ? `${API_BASE}/admin/announcements/${encodeURIComponent(id)}` : `${API_BASE}/admin/announcements`, {
                method: id ? 'PUT' : 'POST',
                body: JSON.stringify(payload)
            });
            showToast?.('公告已保存', 'success');
            resetAnnouncementForm();
            closeAnnouncementModal();
            await window.loadAnnouncementsAdmin?.(1);
            await loadActiveAnnouncements();
            await loadLoginAnnouncements();
        } catch (e) {
            showToast?.(e.message || '公告保存失败', 'error');
        }
    }

    document.addEventListener('submit', (event) => {
        if (event.target?.id === 'announcement-form') saveAnnouncement(event);
    });
    document.addEventListener('click', async (event) => {
        if (event.target?.id === 'announcement-new-btn') {
            openAnnouncementModal();
            return;
        }
        if (event.target?.id === 'announcement-modal-close') {
            closeAnnouncementModal();
            return;
        }
        if (event.target?.id === 'announcement-modal') {
            closeAnnouncementModal();
            return;
        }
        if (event.target?.id === 'announcement-detail-close' || event.target?.id === 'announcement-detail-modal') {
            closeAnnouncementDetailModal();
            return;
        }
        if (event.target?.id === 'announcement-reset-btn') {
            resetAnnouncementForm();
            applyAnnouncementPermissions();
            return;
        }
        const action = event.target.closest('[data-announcement-admin]');
        if (!action) return;
        const id = Number(action.dataset.id);
        const row = state.adminRows.find(item => Number(item.id) === id);
        if (action.dataset.announcementAdmin === 'detail' && row) {
            openAnnouncementDetailModal(row);
        }
        if (action.dataset.announcementAdmin === 'toggle-status' && row) {
            if (row.canEdit === false) return showToast?.('无权编辑该公告', 'error');
            const currentStatus = action.dataset.status;
            const newStatus = currentStatus === 'published' ? 'draft' : 'published';
            const actionText = newStatus === 'published' ? '发布' : '撤下';
            const ok = await (window.showConfirm?.(`${actionText}公告`, `确定要${actionText}这条公告吗？`) || Promise.resolve(window.confirm(`确定要${actionText}这条公告吗？`)));
            if (!ok) return;
            try {
                await apiJson(`${API_BASE}/admin/announcements/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ status: newStatus })
                });
                showToast?.(`公告已${actionText}`, 'success');
                await window.loadAnnouncementsAdmin?.(1);
                await loadActiveAnnouncements();
                await loadLoginAnnouncements();
            } catch (e) {
                showToast?.(e.message || `公告${actionText}失败`, 'error');
            }
        }
        if (action.dataset.announcementAdmin === 'edit' && row) {
            if (row.canEdit === false) return showToast?.('无权编辑该公告', 'error');
            openAnnouncementModal(row);
        }
        if (action.dataset.announcementAdmin === 'delete') {
            if (row?.canDelete === false) return showToast?.('无权删除该公告', 'error');
            const ok = await (window.showConfirm?.('删除公告', '确定要删除这条公告吗？') || Promise.resolve(window.confirm('确定要删除这条公告吗？')));
            if (!ok) return;
            try {
                await apiJson(`${API_BASE}/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' });
                showToast?.('公告已删除', 'success');
                await window.loadAnnouncementsAdmin?.(1);
                await loadActiveAnnouncements();
                await loadLoginAnnouncements();
            } catch (e) {
                showToast?.(e.message || '公告删除失败', 'error');
            }
        }
    });
    document.addEventListener('change', (event) => {
        if (event.target?.id === 'announcement-target-type') {
            const targetValue = document.getElementById('announcement-target-value');
            if (targetValue) {
                targetValue.disabled = event.target.value === 'all';
                if (event.target.value === 'all') targetValue.value = '';
                if (state.adminPermissions?.defaultTargetValue && event.target.value === state.adminPermissions.defaultTargetType) {
                    targetValue.value = state.adminPermissions.defaultTargetValue;
                }
            }
            applyAnnouncementPermissions({ id: document.getElementById('announcement-id')?.value });
        }
        if (event.target?.id === 'announcement-status-filter') window.loadAnnouncementsAdmin?.(1);
    });
    document.addEventListener('input', (event) => {
        if (event.target?.id !== 'announcement-search') return;
        clearTimeout(window.announcementSearchTimer);
        window.announcementSearchTimer = setTimeout(() => window.loadAnnouncementsAdmin?.(1), 300);
    });
    loadLoginAnnouncements();
}());
