/* 个人工作台：展示当前账号的可处理事项、自动化、最近工作与常用入口。 */
(function () {
    const ICONS = {
        chat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
        'official-writing': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>',
        'data-analysis': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="4" height="12" x="3" y="9" rx="1"/><rect width="4" height="18" x="10" y="3" rx="1"/><rect width="4" height="8" x="17" y="13" rx="1"/></svg>',
        knowledge: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>',
        workflows: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="6" rx="1.5"/><path d="M12 9v3"/><path d="M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><rect x="3" y="16" width="6" height="6" rx="1.5"/><rect x="15" y="16" width="6" height="6" rx="1.5"/></svg>',
        regulations: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
        ocr: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3H5a2 2 0 0 0-2 2v2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M3 17v2a2 2 0 0 0 2 2h2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>',
        'pdf-tools': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="12" cy="15" r="2"/></svg>',
        check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
        automation: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="6" rx="1.5"/><path d="M12 9v3"/><path d="M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><rect x="3" y="16" width="6" height="6" rx="1.5"/><rect x="15" y="16" width="6" height="6" rx="1.5"/></svg>',
        sparkle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
        clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        calendar: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>',
        fileText: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>',
        dataset: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>',
        plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>'
    };

    const shortcutCatalog = {
        'official-writing': { label: '公文写作', hint: '起草、润色与规范排版', iconSvg: ICONS['official-writing'] },
        'data-analysis': { label: '数据分析', hint: '导入、透视与 AI 图表', iconSvg: ICONS['data-analysis'] },
        regulations: { label: '法规查询', hint: '条文分级与制度检索', iconSvg: ICONS.regulations },
        ocr: { label: '文字识别', hint: '图片与扫描件高精提取', iconSvg: ICONS.ocr },
        'pdf-tools': { label: 'PDF 工具', hint: '快速拆合、重排与提取', iconSvg: ICONS['pdf-tools'] },
        workflows: { label: '工作流', hint: '编排可复用自动化', iconSvg: ICONS.workflows }
    };

    const state = { dashboard: null, loading: false, requestId: 0 };

    function formatRelativeTime(value) {
        const time = new Date(value || '').getTime();
        if (!Number.isFinite(time)) return '刚刚';
        const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes} 分钟前`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} 小时前`;
        if (hours < 48) return '昨天';
        return `${Math.floor(hours / 24)} 天前`;
    }

    function formatScheduledTime(value) {
        const time = new Date(value || '').getTime();
        if (!Number.isFinite(time)) return '等待安排';
        const minutes = Math.round((time - Date.now()) / 60000);
        if (minutes <= 0) return '即将运行';
        if (minutes < 60) return `${minutes} 分钟后`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} 小时后`;
        return `${Math.floor(hours / 24)} 天后`;
    }

    function formatWorkbenchDate() {
        const now = new Date();
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        return `今天是${now.getFullYear()}年 ${now.getMonth() + 1} 月 ${now.getDate()} 日，${weekdays[now.getDay()]}`;
    }

    function createEmpty(message, options = {}) {
        const node = document.createElement('div');
        node.className = 'personal-empty';
        if (options.iconSvg) {
            const iconWrap = document.createElement('span');
            iconWrap.className = 'personal-empty-icon';
            PivotSafeHtml.setHtml(iconWrap, options.iconSvg);
            node.appendChild(iconWrap);
        }
        const text = document.createElement('p');
        text.className = 'personal-empty-text';
        text.textContent = message;
        node.appendChild(text);
        if (options.actionText && typeof options.onAction === 'function') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-secondary personal-empty-action';
            btn.textContent = options.actionText;
            btn.addEventListener('click', options.onAction);
            node.appendChild(btn);
        }
        return node;
    }

    function clear(node) {
        if (node) node.replaceChildren();
    }

    function appendText(parent, tag, className, content) {
        const node = document.createElement(tag);
        node.className = className;
        node.textContent = content;
        parent.appendChild(node);
        return node;
    }

    function renderStats(stats = {}) {
        const container = document.getElementById('personal-workbench-stats');
        if (!container) return;
        clear(container);

        const attentionCount = Number.isFinite(Number(stats.attention)) ? Math.max(0, Number(stats.attention)) : 0;
        const automationCount = Number.isFinite(Number(stats.automations)) ? Math.max(0, Number(stats.automations)) : 0;
        const artifactCount = Number.isFinite(Number(stats.completedArtifacts))
            ? Math.max(0, Number(stats.completedArtifacts))
            : (Number.isFinite(Number(stats.artifactsThisWeek)) ? Math.max(0, Number(stats.artifactsThisWeek)) : 0);

        const statConfigs = [
            {
                type: 'attention',
                label: '需要我处理',
                value: String(attentionCount),
                subtext: attentionCount === 0 ? '全部已处理' : '项待处理',
                subtextClass: attentionCount === 0 ? 'personal-stat-trend-good' : 'personal-stat-subtext-info',
                iconSvg: ICONS.check
            },
            {
                type: 'automation',
                label: '自动化运行中',
                value: String(automationCount),
                subtext: automationCount === 0 ? '暂无运行中任务' : '持续目标运行中',
                subtextClass: automationCount === 0 ? '' : 'personal-stat-trend-good',
                iconSvg: ICONS.automation
            },
            {
                type: 'artifact',
                label: '已完成成果',
                value: String(artifactCount),
                subtext: '累计完成',
                subtextClass: 'personal-stat-trend-good',
                iconSvg: ICONS.sparkle
            }
        ];

        statConfigs.forEach(cfg => {
            const card = document.createElement('div');
            card.className = `personal-stat personal-stat-${cfg.type}`;
            if (cfg.type === 'automation') {
                card.dataset.personalAction = 'open-goals';
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('title', '管理自动化目标');
            } else if (cfg.type === 'attention') {
                card.dataset.personalAction = 'open-inbox';
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('title', '查看待处理事项');
            } else if (cfg.type === 'artifact') {
                card.dataset.personalAction = 'open-completed-tasks';
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('title', '查看已完成成果');
            }

            const copy = document.createElement('div');
            copy.className = 'personal-stat-copy';

            appendText(copy, 'span', 'personal-stat-label', cfg.label);

            const valueGroup = document.createElement('div');
            valueGroup.className = 'personal-stat-value-group';
            appendText(valueGroup, 'strong', 'personal-stat-value', cfg.value);

            if (cfg.subtext) {
                appendText(valueGroup, 'span', `personal-stat-subtext ${cfg.subtextClass || ''}`, cfg.subtext);
            }
            copy.appendChild(valueGroup);

            const iconWrap = document.createElement('div');
            iconWrap.className = 'personal-stat-icon-wrap';
            PivotSafeHtml.setHtml(iconWrap, cfg.iconSvg);

            card.append(copy, iconWrap);
            container.appendChild(card);
        });
    }

    function renderAttention(items = []) {
        const container = document.getElementById('personal-attention-list');
        if (!container) return;
        clear(container);

        const list = Array.isArray(items) ? items : [];
        if (!list.length) {
            return container.appendChild(createEmpty('暂时没有需要处理的事项，所有任务已就绪。', {
                iconSvg: ICONS.check,
                actionText: '查看待办中心',
                onAction: () => window.Pivot.legacy.openAgentWorkbench?.({ tab: 'inbox', subview: 'inbox' })
            }));
        }

        list.forEach(item => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'personal-row personal-attention-row';
            row.dataset.personalItemType = item.sourceType || '';
            row.dataset.personalRunId = item.runId || '';

            const dot = document.createElement('span');
            const riskClass = item.risk === 'high' ? 'personal-dot-danger' : item.risk === 'medium' ? 'personal-dot-warning' : 'personal-dot-success';
            dot.className = `personal-dot ${riskClass}`;
            dot.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('span');
            copy.className = 'personal-row-copy';
            appendText(copy, 'strong', 'personal-row-title', item.title || '待处理事项');

            const metaText = item.body
                ? (item.body.includes('·') ? item.body : `${item.body} · ${formatRelativeTime(item.updatedAt || item.createdAt)}`)
                : `等待处理 · ${formatRelativeTime(item.updatedAt || item.createdAt)}`;
            appendText(copy, 'span', 'personal-row-meta', metaText);

            const badgeText = item.badgeText || (item.sourceType === 'approval' ? '待审批' : item.risk === 'high' ? '高优先级' : item.unread ? '待查看' : '已完成');
            const pillColorClass = item.risk === 'high' || badgeText === '高优先级'
                ? 'personal-pill-danger'
                : (item.risk === 'medium' || badgeText === '待查看' || badgeText === '待审批')
                    ? 'personal-pill-warning'
                    : 'personal-pill-success';

            const badge = appendText(row, 'span', `personal-pill-badge ${pillColorClass}`, badgeText);
            badge.setAttribute('aria-label', badge.textContent);

            row.prepend(dot, copy);
            container.appendChild(row);
        });
    }

    function renderGoals(goals = []) {
        const container = document.getElementById('personal-goals-list');
        if (!container) return;
        clear(container);

        const list = Array.isArray(goals) ? goals : [];
        if (!list.length) {
            return container.appendChild(createEmpty('还没有运行中的自动化目标，把重复工作交给 Agent 吧。', {
                iconSvg: ICONS.clock,
                actionText: '新建自动化目标',
                onAction: () => window.Pivot.legacy.openAgentWorkbench?.({ tab: 'goals', subview: 'goals', create: true })
            }));
        }

        list.forEach((goal, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'personal-row personal-goal-row';
            row.dataset.personalAction = 'open-goals';

            const iconBox = document.createElement('span');
            const boxClass = goal.iconBoxClass || (index % 3 === 0 ? 'icon-box-purple' : index % 3 === 1 ? 'icon-box-green' : 'icon-box-blue');
            iconBox.className = `personal-row-icon-box ${boxClass}`;
            PivotSafeHtml.setHtml(iconBox, goal.iconSvg || ICONS.clock);
            iconBox.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('span');
            copy.className = 'personal-row-copy';
            appendText(copy, 'strong', 'personal-row-title', goal.title || goal.goal || '未命名自动目标');

            const metaText = goal.meta || (goal.nextRunAt ? `下次运行：${formatScheduledTime(goal.nextRunAt)}` : (goal.status === 'active' ? '持续运行中' : '等待事件触发'));
            appendText(copy, 'span', 'personal-row-meta', metaText);

            const statusText = goal.statusText || (goal.status === 'active' ? '运行中' : goal.status === 'completed' ? '已完成' : '已暂停');
            const statusClass = goal.statusClass || (statusText === '运行中' ? 'status-active' : 'status-done');
            appendText(row, 'span', `personal-status-text ${statusClass}`, statusText);

            row.prepend(iconBox, copy);
            container.appendChild(row);
        });
    }

    function renderRecentWork(items = []) {
        const container = document.getElementById('personal-recent-list');
        if (!container) return;
        clear(container);

        const list = Array.isArray(items) ? items : [];
        if (!list.length) {
            return container.appendChild(createEmpty('还没有可继续的工作。发起一次对话或运行任务即可在这里看到它。', {
                iconSvg: ICONS.chat,
                actionText: '发起新对话',
                onAction: () => openShortcut('chat')
            }));
        }

        list.forEach(item => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'personal-row personal-recent-row';
            row.dataset.personalRecentKind = item.kind || '';
            row.dataset.personalRecentId = item.id || '';

            const iconBox = document.createElement('span');
            const kind = item.kind || 'session';
            const boxClass = item.iconBoxClass || (kind === 'artifact' ? 'icon-box-blue' : kind === 'session' ? 'icon-box-green' : 'icon-box-amber');
            iconBox.className = `personal-row-icon-box ${boxClass}`;
            PivotSafeHtml.setHtml(iconBox, item.iconSvg || (kind === 'artifact' ? ICONS.fileText : kind === 'session' ? ICONS.chat : ICONS.dataset));
            iconBox.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('span');
            copy.className = 'personal-row-copy';
            appendText(copy, 'strong', 'personal-row-title', item.title || '未命名工作');
            appendText(copy, 'span', 'personal-row-meta', item.meta || '最近更新');

            const timeStr = item.timeText || formatRelativeTime(item.updatedAt);
            const time = appendText(row, 'time', 'personal-row-time', timeStr);
            if (item.updatedAt) time.dateTime = item.updatedAt;

            row.prepend(iconBox, copy);
            container.appendChild(row);
        });
    }

    function renderShortcuts(shortcuts = []) {
        const container = document.getElementById('personal-shortcuts-list');
        if (!container) return;
        clear(container);

        const activeShortcuts = shortcuts.length ? shortcuts : ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools'];
        const validShortcuts = activeShortcuts.filter(key => shortcutCatalog[key]).slice(0, 5);

        validShortcuts.forEach(key => {
            const shortcut = shortcutCatalog[key];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-secondary personal-shortcut';
            button.dataset.personalShortcut = key;

            const icon = document.createElement('span');
            icon.className = 'personal-shortcut-icon';
            PivotSafeHtml.setHtml(icon, shortcut.iconSvg);
            icon.setAttribute('aria-hidden', 'true');

            button.appendChild(icon);
            appendText(button, 'strong', 'personal-shortcut-title', shortcut.label);
            appendText(button, 'span', 'personal-shortcut-hint', shortcut.hint);
            container.appendChild(button);
        });

        // 第 6 个快捷卡片固定为“+ 增加入口”
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn-secondary personal-shortcut personal-shortcut-add';
        addBtn.dataset.personalAction = 'edit-shortcuts';
        addBtn.setAttribute('aria-label', '增加入口');

        const addIcon = document.createElement('span');
        addIcon.className = 'personal-shortcut-icon';
        PivotSafeHtml.setHtml(addIcon, ICONS.plus);
        addIcon.setAttribute('aria-hidden', 'true');

        addBtn.appendChild(addIcon);
        appendText(addBtn, 'strong', 'personal-shortcut-title', '增加入口');
        appendText(addBtn, 'span', 'personal-shortcut-hint', '自定义常用入口');
        container.appendChild(addBtn);
    }

    function renderDashboard(dashboard = {}) {
        state.dashboard = dashboard;
        const user = getCurrentUser();
        const userName = user?.nickname || user?.username || '你';
        const hour = new Date().getHours();
        const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
        const initial = String(userName).trim().slice(0, 1) || '我';

        const greetingEl = document.getElementById('personal-workbench-greeting');
        if (greetingEl) greetingEl.textContent = '把分散的对话、任务、资料和自动化，收拢成一条清晰的工作流。';

        const heroTitle = document.getElementById('personal-hero-title');
        if (heroTitle) heroTitle.textContent = `${greeting}，${userName}。今天想先处理什么？`;

        const date = document.getElementById('personal-workbench-date');
        if (date) date.textContent = formatWorkbenchDate();

        const railUserInitial = document.getElementById('personal-rail-user-initial');
        if (railUserInitial) railUserInitial.textContent = initial;

        renderStats(dashboard.stats);
        renderAttention(dashboard.inbox);
        renderGoals(dashboard.goals);
        renderRecentWork(dashboard.recentWork);
        renderShortcuts(dashboard.shortcuts);
    }

    async function loadPersonalWorkbench({ silent = false } = {}) {
        const stateNode = document.getElementById('personal-workbench-state');
        if (state.loading) return;
        const requestId = ++state.requestId;
        state.loading = true;
        if (stateNode && !silent) stateNode.textContent = '正在加载个人工作台…';
        try {
            const response = await apiFetch(`${API_BASE}/user/workbench-summary`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '个人工作台数据加载失败');
            if (requestId !== state.requestId) return;
            renderDashboard(data.dashboard || {});
            if (stateNode) stateNode.textContent = '';
        } catch (error) {
            if (requestId !== state.requestId) return;
            if (stateNode) stateNode.textContent = error.message || '个人工作台暂时无法加载';
            if (!silent) window.Pivot.legacy.showToast?.(error.message || '个人工作台暂时无法加载', 'error');
        } finally {
            if (requestId === state.requestId) state.loading = false;
        }
    }

    async function openPersonalWorkbench() {
        window.Pivot.legacy.showMainWorkspace?.('personal');
        await loadPersonalWorkbench({ silent: Boolean(state.dashboard) });
    }

    async function openShortcut(key) {
        if (key === 'chat') {
            const sessions = window.Pivot.moduleApi?.('chat.sessions');
            const session = await sessions?.createSession?.('新对话');
            if (session) await sessions.selectSession?.(session.id, session.title, { refreshSidebar: true });
            return;
        }
        if (key === 'automation' || key === 'tasks') return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks' });
        if (key === 'apps') return window.Pivot.legacy.openAppsWorkbench?.({ home: true });
        if (key === 'knowledge') return window.Pivot.legacy.openKnowledgeWorkbench?.();
        if (key === 'workflows') return window.Pivot.legacy.openAgentDagWorkbench?.({ tab: 'workflows' });
        await window.Pivot.legacy.openAppsWorkbench?.();
        const appId = key === 'official-writing' ? 'official-writing' : key;
        document.querySelector(`[data-app-id="${appId}"]`)?.click();
    }

    function openShortcutEditor() {
        const modal = document.getElementById('personal-shortcuts-modal');
        const options = document.getElementById('personal-shortcuts-options');
        if (!modal || !options) return;
        const selected = new Set(state.dashboard?.shortcuts || ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools']);
        clear(options);
        Object.entries(shortcutCatalog).forEach(([key, shortcut]) => {
            const option = document.createElement('label');
            option.className = 'personal-shortcuts-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = key;
            checkbox.checked = selected.has(key);
            const copy = document.createElement('span');
            appendText(copy, 'strong', 'personal-shortcuts-option-title', shortcut.label);
            appendText(copy, 'small', 'personal-shortcuts-option-hint', shortcut.hint);
            option.append(checkbox, copy);
            options.appendChild(option);
        });
        modal.classList.remove('hidden');
    }

    function closeShortcutEditor() {
        document.getElementById('personal-shortcuts-modal')?.classList.add('hidden');
    }

    async function saveShortcuts() {
        const shortcuts = [...document.querySelectorAll('#personal-shortcuts-options input:checked')].map(input => input.value);
        if (!shortcuts.length) {
            window.Pivot.legacy.showToast?.('请至少保留一个常用入口', 'warning');
            return;
        }
        const response = await apiFetch(`${API_BASE}/agents/workbench/shortcuts`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shortcuts })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '常用入口保存失败');
        if (state.dashboard) {
            state.dashboard.shortcuts = data.shortcuts || shortcuts;
            renderShortcuts(state.dashboard.shortcuts);
        }
        closeShortcutEditor();
        window.Pivot.legacy.showToast?.('常用入口已保存');
    }

    function getCurrentUser() {
        return (typeof currentUser !== 'undefined' && currentUser) || window.Pivot?.legacy?.currentUser || null;
    }

    function openUserProfileModal() {
        const modal = document.getElementById('personal-user-modal');
        if (!modal) return;

        const user = getCurrentUser();
        const userName = user?.nickname || user?.username || '当前用户';
        const account = user?.username ? `@${user.username}` : '@user';
        const initial = String(userName).trim().slice(0, 1) || '我';

        let roleText = '普通用户';
        if (typeof isSuperAdminUser === 'function' && isSuperAdminUser(user)) {
            roleText = '超级管理员';
        } else if (typeof getPermissionLabel === 'function') {
            roleText = getPermissionLabel(user);
        } else if (typeof isAdminUser === 'function' && isAdminUser(user)) {
            roleText = '系统管理员';
        } else if (user?.role === 'admin') {
            roleText = '管理员';
        }

        const avatarLg = document.getElementById('personal-user-avatar-lg');
        if (avatarLg) avatarLg.textContent = initial;

        const nameEl = document.getElementById('personal-user-dialog-title');
        if (nameEl) nameEl.textContent = userName;

        const accountEl = document.getElementById('personal-user-account');
        if (accountEl) accountEl.textContent = account;

        const roleBadge = document.getElementById('personal-user-role-badge');
        if (roleBadge) {
            const isSuper = (typeof isSuperAdminUser === 'function' && isSuperAdminUser(user)) || user?.role === 'admin';
            clear(roleBadge);
            const pill = document.createElement('span');
            pill.className = isSuper ? 'personal-role-pill is-admin' : 'personal-role-pill';
            pill.textContent = roleText;
            roleBadge.appendChild(pill);
        }

        const unitEl = document.getElementById('personal-user-unit');
        if (unitEl) unitEl.textContent = user?.unit || '默认单位';

        const idEl = document.getElementById('personal-user-id');
        if (idEl) idEl.textContent = user?.id !== undefined && user?.id !== null ? String(user.id) : '-';

        const createdEl = document.getElementById('personal-user-created-at');
        if (createdEl) {
            if (user?.created_at) {
                try {
                    const d = new Date(user.created_at);
                    if (!Number.isNaN(d.getTime())) {
                        createdEl.textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                    } else {
                        createdEl.textContent = String(user.created_at);
                    }
                } catch {
                    createdEl.textContent = String(user.created_at);
                }
            } else {
                createdEl.textContent = '系统初始用户';
            }
        }

        modal.classList.remove('hidden');
    }

    function closeUserProfileModal() {
        const modal = document.getElementById('personal-user-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function handleRecentWork(button) {
        const kind = button.dataset.personalRecentKind;
        const id = button.dataset.personalRecentId;
        if (kind === 'session' && id) return window.Pivot.moduleApi?.('chat.sessions')?.selectSession?.(id, undefined, { refreshSidebar: true });
        if (kind === 'run' && id) return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks', query: id });
        if (kind === 'artifact') return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks', status: 'completed' });
        return window.Pivot.legacy.showMainWorkspace?.('chat');
    }

    document.addEventListener('click', async event => {
        const action = event.target.closest('[data-personal-action]')?.dataset.personalAction;
        if (action) {
            if (action === 'refresh') return loadPersonalWorkbench();
            if (action === 'open-chat' || action === 'new-chat') return openShortcut('chat');
            if (action === 'open-knowledge') return window.Pivot.legacy.openKnowledgeWorkbench?.();
            if (action === 'new-document') {
                await openShortcut('official-writing');
                return document.getElementById('official-writing-create-doc-btn')?.click();
            }
            if (action === 'open-search') {
                const searchApi = window.Pivot?.moduleApi ? window.Pivot.moduleApi('sidebar.search') : null;
                if (searchApi?.open) return searchApi.open('', { scope: 'global' });
                return document.getElementById('session-search-open')?.click();
            }
            if (action === 'open-apps') return window.Pivot.legacy.openAppsWorkbench?.({ home: true });
            if (action === 'open-automation' || action === 'open-goals') {
                return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'goals', subview: 'goals' });
            }
            if (action === 'open-completed-tasks') return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks', status: 'completed' });
            if (action === 'open-tools') return window.Pivot.legacy.openMcpWorkbench?.();
            if (action === 'open-settings') return window.Pivot.legacy.openAdminPanel?.();
            if (action === 'open-user-profile') return openUserProfileModal();
            if (action === 'close-user-modal') return closeUserProfileModal();
            if (action === 'user-to-settings') {
                closeUserProfileModal();
                return window.Pivot.legacy.openAdminPanel?.();
            }
            if (action === 'logout') return window.Pivot.legacy.logout?.();
            if (action === 'open-inbox') {
                return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'inbox', subview: 'inbox' });
            }
            if (action === 'open-history') return window.Pivot.legacy.showMainWorkspace?.('chat');
            if (action === 'edit-shortcuts') return openShortcutEditor();
        }
        const shortcut = event.target.closest('[data-personal-shortcut]')?.dataset.personalShortcut;
        if (shortcut) await openShortcut(shortcut);
        const recent = event.target.closest('[data-personal-recent-id]');
        if (recent) await handleRecentWork(recent);
        const attention = event.target.closest('[data-personal-item-type]');
        if (attention) {
            const runId = attention.dataset.personalRunId;
            if (runId && typeof window.Pivot.legacy.openAgentRun === 'function') {
                return window.Pivot.legacy.openAgentRun(runId, { returnTab: 'workbench', returnSubview: 'inbox', returnLabel: '待办中心' });
            }
            return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'inbox', subview: 'inbox' });
        }
    });

    document.getElementById('personal-user-modal')?.addEventListener('click', event => {
        if (event.target.id === 'personal-user-modal') closeUserProfileModal();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            const userModal = document.getElementById('personal-user-modal');
            if (userModal && !userModal.classList.contains('hidden')) {
                closeUserProfileModal();
            }
        }
    });

    document.getElementById('personal-shortcuts-cancel')?.addEventListener('click', closeShortcutEditor);
    document.getElementById('personal-shortcuts-save')?.addEventListener('click', () => {
        saveShortcuts().catch(error => window.Pivot.legacy.showToast?.(error.message || '常用入口保存失败', 'error'));
    });

    window.Pivot?.exposeModule?.('workspaces.personal', { openPersonalWorkbench, loadPersonalWorkbench }, [
        'openPersonalWorkbench',
        'loadPersonalWorkbench'
    ]);
})();
