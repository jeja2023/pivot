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
    window.PivotAnnouncements = {
        state,
        TYPE_LABELS,
        PRIORITY_LABELS,
        TARGET_LABELS,
        STATUS_LABELS,
        esc,
        formatDate,
        shouldShowAnnouncement,
        canDismissAnnouncement,
        getCurrentUser,
        apiJson,
        renderAnnouncements,
        renderLoginAnnouncements,
        loadLoginAnnouncements,
        loadActiveAnnouncements,
        markAnnouncementRead,
        ackAnnouncement,
        dismissAnnouncement,
        markVisibleAnnouncementsRead
    };

    loadLoginAnnouncements();
}());