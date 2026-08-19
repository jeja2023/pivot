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
        PivotSafeHtml.setHtml(root, `
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
        `);
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
            PivotSafeHtml.setHtml(banner, top ? `
                <div>
                    <strong>${esc(top.title)}</strong>
                    <span>${esc(top.content)}</span>
                </div>
                <div class="announcement-banner-actions">
                    ${top.requireAck && !top.acknowledgedAt ? `<button class="btn-primary" type="button" data-announcement-action="ack" data-announcement-id="${top.id}">确认</button>` : ''}
                    ${canDismissAnnouncement(top) ? `<button class="btn-secondary" type="button" data-announcement-action="dismiss" data-announcement-id="${top.id}">不再提示</button>` : ''}
                </div>
            ` : '');
        }

        if (list) {
            if (!visible.length) {
                PivotSafeHtml.setHtml(list, '<div class="announcement-empty">暂无有效公告</div>');
            } else {
                PivotSafeHtml.setHtml(list, visible.map(item => `
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
                `).join(''));
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
        if (!authContainer) return null;
        let panel = document.getElementById('auth-announcements');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'auth-announcements';
        panel.className = 'auth-announcements hidden';
        panel.setAttribute('aria-label', '登录页公告');
        authContainer.appendChild(panel);
        return panel;
    }

    function startAnnouncementsFloating() {
        const el = document.getElementById('auth-announcements');
        if (!el) return;

        if (el.dataset.floatingInitialized) return;
        el.dataset.floatingInitialized = 'true';

        let parent = el.offsetParent || document.getElementById('auth-container') || document.body;
        let rect = el.getBoundingClientRect();
        let pRect = parent.getBoundingClientRect();

        let x = 0;
        let y = 0;
        let vx = 0.4; // 水平速度 (像素/帧)
        let vy = 0.3; // 垂直速度 (像素/帧)
        let isFloating = false;

        // 初始化或重置位置
        function initPosition() {
            pRect = parent.getBoundingClientRect();
            rect = el.getBoundingClientRect();

            // 如果屏幕宽度小于等于 980px，则还原样式交给 CSS，不启动漂浮
            if (window.innerWidth <= 980) {
                if (isFloating) {
                    el.style.position = '';
                    el.style.left = '';
                    el.style.bottom = '';
                    el.style.top = '';
                    el.style.transform = '';
                    el.style.animation = '';
                    isFloating = false;
                }
                return;
            }

            if (!isFloating) {
                // 开启大屏下的自由漫游定位
                el.style.position = 'absolute';
                el.style.bottom = 'auto';
                el.style.left = '0px';
                el.style.top = '0px';
                el.style.animation = 'none'; // 禁用 CSS 的垂直小幅度抖动
                
                // 随机初始坐标，避免紧贴屏幕边缘
                x = Math.random() * Math.max(10, pRect.width - rect.width - 60) + 30;
                y = Math.random() * Math.max(10, pRect.height - rect.height - 60) + 30;

                // 随机初始方向速度
                vx = (Math.random() > 0.5 ? 1 : -1) * (0.2 + Math.random() * 0.3);
                vy = (Math.random() > 0.5 ? 1 : -1) * (0.2 + Math.random() * 0.3);

                isFloating = true;
            } else {
                // 窗口 resize 时防止越界
                if (x + rect.width > pRect.width) {
                    x = Math.max(0, pRect.width - rect.width - 20);
                }
                if (y + rect.height > pRect.height) {
                    y = Math.max(0, pRect.height - rect.height - 20);
                }
            }
        }

        initPosition();
        window.addEventListener('resize', initPosition);

        function tick() {
            if (!document.getElementById('auth-announcements')) return;

            if (isFloating && window.innerWidth > 980) {
                pRect = parent.getBoundingClientRect();
                rect = el.getBoundingClientRect();

                x += vx;
                y += vy;

                // 左右边缘碰撞检测与反弹，内缩 15px 以保持呼吸感
                if (x <= 15) {
                    x = 15;
                    vx = -vx;
                } else if (x + rect.width >= pRect.width - 15) {
                    x = pRect.width - rect.width - 15;
                    vx = -vx;
                }

                // 上下边缘碰撞检测与反弹
                if (y <= 15) {
                    y = 15;
                    vy = -vy;
                } else if (y + rect.height >= pRect.height - 15) {
                    y = pRect.height - rect.height - 15;
                    vy = -vy;
                }

                el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
            }

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    }

    function renderLoginAnnouncements() {
        const panel = ensureLoginAnnouncementShell();
        if (!panel) return;
        const items = state.loginItems || [];
        panel.classList.toggle('hidden', items.length === 0);
        PivotSafeHtml.setHtml(panel, items.length ? `
            <div class="auth-announcements-head">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span>公告</span>
                    <small>${items.length} 条</small>
                </div>
                <button type="button" class="auth-announcements-close" title="关闭公告" aria-label="关闭公告">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
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
        ` : '');

        if (items.length > 0) {
            const closeBtn = panel.querySelector('.auth-announcements-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    panel.classList.add('hidden');
                });
            }
            setTimeout(startAnnouncementsFloating, 0);
        }
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
            console.warn('加载登录公告失败:', e);
        }
    }

    async function loadActiveAnnouncements() {
        if (!getCurrentUser() || typeof apiFetch !== 'function') return;
        try {
            const data = await apiJson(`${API_BASE}/announcements/active`);
            state.items = data.data || [];
            renderAnnouncements();
        } catch (e) {
            console.warn('加载活跃公告失败:', e);
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
    // 提供可停止的清理钩子（如登出时调用），避免轮询在不需要时继续运行
    window.stopAnnouncements = function () {
        if (state.polling) {
            window.clearInterval(state.polling);
            state.polling = null;
        }
        state.initialized = false;
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