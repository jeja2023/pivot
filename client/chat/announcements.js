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
        historyItems: [],
        activeTab: 'all',
        selectedModalItem: null,
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
        return window.Pivot.legacy.currentUser || null;
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

    function getAllAnnouncements() {
        const map = new Map();
        (state.items || []).forEach(it => {
            if (it && it.id) map.set(String(it.id), { ...it });
        });
        (state.historyItems || []).forEach(it => {
            if (!it || !it.id) return;
            const key = String(it.id);
            if (!map.has(key)) {
                map.set(key, { ...it });
            } else {
                const existing = map.get(key);
                map.set(key, { ...it, ...existing });
            }
        });
        return Array.from(map.values()).sort((a, b) => {
            const priorityScore = { critical: 0, high: 1, normal: 2, low: 3 };
            const pa = priorityScore[a.priority] ?? 2;
            const pb = priorityScore[b.priority] ?? 2;
            if (pa !== pb) return pa - pb;
            const ta = new Date(a.startsAt || a.createdAt || 0).getTime();
            const tb = new Date(b.startsAt || b.createdAt || 0).getTime();
            return tb - ta;
        });
    }

    function openAnnouncementDetail(id) {
        const all = getAllAnnouncements();
        const item = all.find(it => String(it.id) === String(id));
        if (!item) return;
        state.selectedModalItem = item;
        renderAnnouncements();
        if (!item.readAt) {
            markAnnouncementRead(item.id);
        }
    }

    function closeAnnouncementDetail() {
        state.selectedModalItem = null;
        renderAnnouncements();
    }

    function mountAnnouncementBell() {
        const bell = document.getElementById('announcement-bell');
        if (!bell) return;
        const brand = document.querySelector('.app-brand-mini');
        if (brand) {
            const brandText = brand.querySelector('.brand-text-mini');
            if (bell.parentElement !== brand) {
                brand.insertBefore(bell, brandText?.nextSibling || null);
            }
            return;
        }
        const targetContainer = document.querySelector('.sidebar-tools') || document.querySelector('.sidebar-header');
        if (targetContainer && bell.parentElement !== targetContainer) {
            targetContainer.appendChild(bell);
        }
    }

    function bindAnnouncementTriggers() {
        const toggleCenter = (forceOpen) => {
            const center = document.getElementById('announcement-center');
            if (!center) return;
            const isHidden = center.classList.contains('hidden');
            const shouldOpen = forceOpen !== undefined ? forceOpen : isHidden;
            center.classList.toggle('hidden', !shouldOpen);
            if (shouldOpen) {
                loadActiveAnnouncements();
            }
        };

        const triggers = [
            document.getElementById('announcement-bell'),
            document.getElementById('personal-announcement-btn'),
            document.getElementById('chat-sidebar-announcement-btn')
        ];
        triggers.forEach(trigger => {
            if (trigger && !trigger.dataset.announcementBound) {
                trigger.dataset.announcementBound = 'true';
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleCenter();
                });
            }
        });
    }

    function ensureShell() {
        bindAnnouncementTriggers();
        if (document.getElementById('announcement-root')) {
            mountAnnouncementBell();
            return;
        }
        const root = document.createElement('div');
        root.id = 'announcement-root';
        PivotSafeHtml.setHtml(root, `
            <div id="announcement-banner" class="announcement-banner hidden"></div>
            <button id="announcement-bell" class="btn-secondary announcement-bell hidden" type="button" title="公告中心" aria-label="公告中心">
                <span class="announcement-bell-dot hidden" id="announcement-bell-dot"></span>
                <span>公告</span>
            </button>
            <aside id="announcement-center" class="announcement-center hidden" aria-label="公告中心">
                <div class="announcement-center-head">
                    <div class="announcement-center-head-title">
                        <div class="announcement-center-title-row">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                            <h3>公告中心</h3>
                        </div>
                        <p id="announcement-center-summary">暂无公告</p>
                    </div>
                    <div class="announcement-center-head-actions">
                        <button id="announcement-mark-all-read" class="btn-secondary announcement-head-btn" type="button" title="全部标为已读">全部已读</button>
                        <button id="announcement-center-close" class="btn-secondary announcement-head-close" type="button" aria-label="关闭公告中心">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                </div>
                <nav class="announcement-center-tabs" aria-label="公告分类">
                    <button type="button" class="btn-secondary announcement-tab-btn active" data-announcement-tab="all">
                        全部 <span class="tab-badge" id="announcement-tab-all-count">0</span>
                    </button>
                    <button type="button" class="btn-secondary announcement-tab-btn" data-announcement-tab="unread">
                        未读 <span class="tab-badge" id="announcement-tab-unread-count">0</span>
                    </button>
                    <button type="button" class="btn-secondary announcement-tab-btn" data-announcement-tab="history">
                        历史已读 <span class="tab-badge" id="announcement-tab-history-count">0</span>
                    </button>
                </nav>
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
        bindAnnouncementTriggers();

        document.getElementById('announcement-center-close')?.addEventListener('click', () => {
            document.getElementById('announcement-center')?.classList.add('hidden');
        });

        document.getElementById('announcement-mark-all-read')?.addEventListener('click', async () => {
            await markVisibleAnnouncementsRead();
        });

        document.getElementById('announcement-ack-btn')?.addEventListener('click', async () => {
            const id = document.getElementById('announcement-ack-btn')?.dataset.id;
            if (!id) return;
            await ackAnnouncement(id);
        });

        document.getElementById('announcement-banner')?.addEventListener('click', async (event) => {
            if (event.target.id === 'announcement-banner') {
                if (state.selectedModalItem) {
                    closeAnnouncementDetail();
                    return;
                }
                const visible = (state.items || []).filter(shouldShowAnnouncement);
                const top = visible.find(item => item.requireAck && !item.acknowledgedAt) || visible[0];
                if (top && canDismissAnnouncement(top)) {
                    await dismissAnnouncement(top.id);
                }
            }
        });

        document.addEventListener('click', async (event) => {
            const tabBtn = event.target.closest('[data-announcement-tab]');
            if (tabBtn) {
                event.stopPropagation();
                state.activeTab = tabBtn.dataset.announcementTab || 'all';
                renderAnnouncements();
                return;
            }

            const personalAction = event.target.closest('[data-personal-action="open-announcements"]');
            if (personalAction) {
                event.stopPropagation();
                const center = document.getElementById('announcement-center');
                if (center) {
                    center.classList.toggle('hidden');
                    if (!center.classList.contains('hidden')) {
                        loadActiveAnnouncements();
                    }
                }
                return;
            }

            const action = event.target.closest('[data-announcement-action]');
            if (action) {
                const id = action.dataset.announcementId;
                const act = action.dataset.announcementAction;
                if (act === 'dismiss') await dismissAnnouncement(id);
                else if (act === 'ack') await ackAnnouncement(id);
                else if (act === 'read') await markAnnouncementRead(id);
                else if (act === 'view') {
                    openAnnouncementDetail(id);
                } else if (act === 'close-modal') {
                    closeAnnouncementDetail();
                }
                return;
            }

            const cardEl = event.target.closest('.announcement-card');
            if (cardEl && cardEl.dataset.announcementId) {
                openAnnouncementDetail(cardEl.dataset.announcementId);
                return;
            }

            const center = document.getElementById('announcement-center');
            if (center && !center.classList.contains('hidden')) {
                if (!event.target.closest('#announcement-center') &&
                    !event.target.closest('#announcement-bell') &&
                    !event.target.closest('#personal-announcement-btn') &&
                    !event.target.closest('#chat-sidebar-announcement-btn')) {
                    center.classList.add('hidden');
                }
            }
        });
    }

    function renderAnnouncements() {
        ensureShell();
        const all = getAllAnnouncements();
        const unreadCount = all.filter(item => !item.readAt).length;
        const unreadItems = all.filter(item => !item.readAt);
        const historyItems = all.filter(item => item.readAt || item.dismissedAt);

        const bell = document.getElementById('announcement-bell');
        const personalBtn = document.getElementById('personal-announcement-btn');
        const chatBtn = document.getElementById('chat-sidebar-announcement-btn');
        const dot = document.getElementById('announcement-bell-dot');
        const personalDot = document.getElementById('personal-announcement-dot');
        const chatDot = document.getElementById('chat-sidebar-announcement-dot');

        if (bell) bell.classList.toggle('hidden', all.length === 0);
        if (personalBtn) personalBtn.classList.remove('hidden');
        if (chatBtn) chatBtn.classList.remove('hidden');
        dot?.classList.toggle('hidden', unreadCount === 0);
        personalDot?.classList.toggle('hidden', unreadCount === 0);
        chatDot?.classList.toggle('hidden', unreadCount === 0);

        const summary = document.getElementById('announcement-center-summary');
        if (summary) summary.textContent = all.length ? `共 ${all.length} 条公告 · ${unreadCount} 条未读` : '暂无系统公告';

        const tabAllCount = document.getElementById('announcement-tab-all-count');
        const tabUnreadCount = document.getElementById('announcement-tab-unread-count');
        const tabHistoryCount = document.getElementById('announcement-tab-history-count');
        if (tabAllCount) tabAllCount.textContent = String(all.length);
        if (tabUnreadCount) tabUnreadCount.textContent = String(unreadCount);
        if (tabHistoryCount) tabHistoryCount.textContent = String(historyItems.length);

        document.querySelectorAll('.announcement-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.announcementTab === state.activeTab);
        });

        const banner = document.getElementById('announcement-banner');
        const visible = (state.items || []).filter(shouldShowAnnouncement);
        const autoPopupTop = visible.find(item => item.requireAck && !item.acknowledgedAt) || visible[0];
        const displayItem = state.selectedModalItem || autoPopupTop;

        if (banner) {
            banner.className = `announcement-banner ${displayItem ? '' : 'hidden'}`;
            const isManualView = Boolean(state.selectedModalItem);
            PivotSafeHtml.setHtml(banner, displayItem ? `
                <div class="announcement-banner-dialog is-${esc(displayItem.priority || 'normal')}" role="dialog" aria-modal="true" aria-labelledby="announcement-banner-title">
                    <div class="announcement-banner-head">
                        <div class="announcement-banner-meta">
                            <span class="announcement-chip">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                                <span>${esc(TYPE_LABELS[displayItem.type] || '系统')} · ${esc(PRIORITY_LABELS[displayItem.priority] || '普通')}</span>
                            </span>
                            ${displayItem.startsAt || displayItem.createdAt ? `<time class="announcement-banner-time">${esc(formatDate(displayItem.startsAt || displayItem.createdAt))}</time>` : ''}
                        </div>
                    </div>
                    <h3 id="announcement-banner-title" class="announcement-banner-title">${esc(displayItem.title)}</h3>
                    <div class="announcement-banner-body">
                        <div class="announcement-banner-content">${esc(displayItem.content)}</div>
                    </div>
                    <div class="announcement-banner-footer">
                        <div class="announcement-banner-actions">
                            ${isManualView ? `
                                ${displayItem.requireAck && !displayItem.acknowledgedAt
                                    ? `<button class="btn-primary" type="button" data-announcement-action="ack" data-announcement-id="${displayItem.id}">我已知晓并确认</button>`
                                    : ''
                                }
                                <button class="btn-secondary" type="button" data-announcement-action="close-modal" data-announcement-id="${displayItem.id}">关闭</button>
                            ` : `
                                ${canDismissAnnouncement(displayItem) ? `<button class="btn-secondary" type="button" data-announcement-action="dismiss" data-announcement-id="${displayItem.id}">不再提示</button>` : ''}
                                ${displayItem.requireAck && !displayItem.acknowledgedAt
                                    ? `<button class="btn-primary" type="button" data-announcement-action="ack" data-announcement-id="${displayItem.id}">我已知晓并确认</button>`
                                    : `<button class="btn-primary" type="button" data-announcement-action="dismiss" data-announcement-id="${displayItem.id}">我知道了</button>`
                                }
                            `}
                        </div>
                    </div>
                </div>
            ` : '');
        }

        const list = document.getElementById('announcement-center-list');
        if (list) {
            let activeList = all;
            if (state.activeTab === 'unread') activeList = unreadItems;
            if (state.activeTab === 'history') activeList = historyItems;

            if (!activeList.length) {
                const emptyMsg = state.activeTab === 'unread' ? '没有未读公告' : (state.activeTab === 'history' ? '暂无历史公告' : '暂无系统公告');
                PivotSafeHtml.setHtml(list, `<div class="announcement-empty">${esc(emptyMsg)}</div>`);
            } else {
                PivotSafeHtml.setHtml(list, activeList.map(item => `
                    <article class="announcement-card ${item.readAt ? 'is-read' : 'is-unread'} is-${esc(item.priority || 'normal')}" data-announcement-id="${item.id}">
                        <div class="announcement-card-head">
                            <div class="announcement-card-tags">
                                <span class="announcement-chip">${esc(TYPE_LABELS[item.type] || '公告')} · ${esc(PRIORITY_LABELS[item.priority] || '普通')}</span>
                                <span class="announcement-status-tag ${item.readAt ? 'is-read' : 'is-unread'}">
                                    ${item.requireAck && item.acknowledgedAt ? '已确认' : (item.readAt ? '已读' : '未读')}
                                </span>
                            </div>
                            <time class="announcement-card-time">${esc(formatDate(item.startsAt || item.createdAt))}</time>
                        </div>
                        <h4 class="announcement-card-title">${esc(item.title)}</h4>
                        <p class="announcement-card-snippet">${esc(item.content)}</p>
                        <div class="announcement-card-actions" onclick="event.stopPropagation()">
                            <button class="btn-primary announcement-card-btn" type="button" data-announcement-action="view" data-announcement-id="${item.id}">查看详情</button>
                            ${!item.readAt ? `<button class="btn-secondary announcement-card-btn" type="button" data-announcement-action="read" data-announcement-id="${item.id}">标为已读</button>` : ''}
                            ${item.requireAck && !item.acknowledgedAt ? `<button class="btn-primary announcement-card-btn" type="button" data-announcement-action="ack" data-announcement-id="${item.id}">确认</button>` : ''}
                        </div>
                    </article>
                `).join(''));
            }
        }

        const ackModal = document.getElementById('announcement-ack-modal');
        if (ackModal) {
            ackModal.classList.add('hidden');
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
            const [activeRes, historyRes] = await Promise.all([
                apiJson(`${API_BASE}/announcements/active?includeDismissed=true`).catch(() => ({ data: [] })),
                apiJson(`${API_BASE}/announcements/history`).catch(() => ({ data: [] }))
            ]);
            state.items = activeRes.data || [];
            state.historyItems = historyRes.data || [];
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
        state.selectedModalItem = null;
        await apiJson(`${API_BASE}/announcements/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
        await loadActiveAnnouncements();
    }

    async function markVisibleAnnouncementsRead() {
        const all = getAllAnnouncements();
        const unread = all.filter(item => !item.readAt).slice(0, 20);
        if (!unread.length) return;
        await Promise.all(unread.map(item => apiJson(`${API_BASE}/announcements/${encodeURIComponent(item.id)}/read`, { method: 'POST' }).catch(() => null)));
        await loadActiveAnnouncements();
    }

    window.Pivot.legacy.initAnnouncements = function () {
        ensureShell();
        if (!state.initialized) {
            state.initialized = true;
            state.polling = window.setInterval(loadActiveAnnouncements, 60000);
        }
        loadActiveAnnouncements();
    };
    // 提供可停止的清理钩子（如登出时调用），避免轮询在不需要时继续运行
    window.Pivot.legacy.stopAnnouncements = function () {
        if (state.polling) {
            window.clearInterval(state.polling);
            state.polling = null;
        }
        state.initialized = false;
    };
    window.Pivot.legacy.loadLoginAnnouncements = loadLoginAnnouncements;
    window.Pivot.legacy.PivotAnnouncements = {
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