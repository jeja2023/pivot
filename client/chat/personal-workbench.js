/* 个人工作台：展示当前账号的可处理事项、自动化、最近工作与常用入口。 */
(function () {
    const ICONS = {
        chat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
        'official-writing': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>',
        'data-analysis': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="4" height="12" x="3" y="9" rx="1"/><rect width="4" height="18" x="10" y="3" rx="1"/><rect width="4" height="8" x="17" y="13" rx="1"/></svg>',
        knowledge: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>',
        workflows: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 17 17 7"/><polyline points="7 7 17 7 17 17"/></svg>',
        regulations: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
        ocr: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3H5a2 2 0 0 0-2 2v2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M3 17v2a2 2 0 0 0 2 2h2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>',
        'pdf-tools': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="12" cy="15" r="2"/></svg>',
        check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
        arrowUpRight: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 17 17 7"/><polyline points="7 7 17 7 17 17"/></svg>',
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
        workflows: { label: '工作流', hint: '编排可复用自动化', iconSvg: ICONS.workflows },
        knowledge: { label: '知识库', hint: '管理和检索资料', iconSvg: ICONS.knowledge },
        chat: { label: '发起对话', hint: '向 AI 提问或执行任务', iconSvg: ICONS.chat }
    };

    const DEMO_ATTENTION = [
        {
            title: '季度经营分析报告等待最终审批',
            body: '数席分析 Agent · 12 分钟前 · 需要确认 2 项结论',
            risk: 'high',
            badgeText: '高优先级',
            sourceType: 'approval'
        },
        {
            title: '“每日项目风险巡检”发现 3 个异常',
            body: '持续目标 · 今天 09:30 · 已生成风险摘要',
            risk: 'medium',
            badgeText: '待查看',
            sourceType: 'run'
        },
        {
            title: '知识库更新完成，建议复核新增制度',
            body: '知识助手 · 昨天 18:42 · 4 份文档已完成索引',
            risk: 'low',
            badgeText: '已完成',
            sourceType: 'evolution'
        }
    ];

    const DEMO_GOALS = [
        {
            title: '每日晨间项目风险与待办巡检',
            meta: '下次运行：明天 08:30',
            statusText: '运行中',
            statusClass: 'status-active',
            iconBoxClass: 'icon-box-purple',
            iconSvg: ICONS.clock
        },
        {
            title: '每周五生成部门周报',
            meta: '下次运行：周五 17:30',
            statusText: '运行中',
            statusClass: 'status-active',
            iconBoxClass: 'icon-box-green',
            iconSvg: ICONS.calendar
        },
        {
            title: '会议纪要自动整理与分发',
            meta: '最近运行：今天 10:12',
            statusText: '已完成',
            statusClass: 'status-done',
            iconBoxClass: 'icon-box-blue',
            iconSvg: ICONS.fileText
        }
    ];

    const DEMO_RECENT = [
        {
            title: '2026 年第三季度经营分析报告',
            meta: '公文写作 · 还有 2 个段落待润色',
            timeText: '8 分钟前',
            iconBoxClass: 'icon-box-blue',
            iconSvg: ICONS.fileText,
            kind: 'artifact'
        },
        {
            title: '关于研发项目排期的讨论',
            meta: '对话 · 19 条消息 · 已置顶',
            timeText: '昨天',
            iconBoxClass: 'icon-box-green',
            iconSvg: ICONS.chat,
            kind: 'session'
        },
        {
            title: '华东区域客户反馈数据集',
            meta: '数据分析 · 最近更新了 128 行',
            timeText: '周四',
            iconBoxClass: 'icon-box-amber',
            iconSvg: ICONS.dataset,
            kind: 'run'
        }
    ];

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

    function createEmpty(message) {
        const node = document.createElement('div');
        node.className = 'personal-empty';
        node.textContent = message;
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

        const attentionCount = stats.attention !== undefined && stats.attention > 0 ? stats.attention : 7;
        const automationCount = stats.automations !== undefined && stats.automations > 0 ? stats.automations : 3;
        const artifactCount = stats.artifactsThisWeek !== undefined && stats.artifactsThisWeek > 0 ? stats.artifactsThisWeek : 12;

        const statConfigs = [
            {
                type: 'attention',
                label: '需要我处理',
                value: String(attentionCount),
                subtext: '↓ 2 较昨日',
                subtextClass: 'personal-stat-trend-good',
                iconSvg: ICONS.check
            },
            {
                type: 'automation',
                label: '自动化运行中',
                value: String(automationCount),
                subtext: '· 1 个待审批',
                subtextClass: 'personal-stat-subtext-info',
                iconSvg: ICONS.arrowUpRight
            },
            {
                type: 'artifact',
                label: '本周已完成成果',
                value: String(artifactCount),
                subtext: '↑ 28%',
                subtextClass: 'personal-stat-trend-good',
                iconSvg: ICONS.sparkle
            }
        ];

        statConfigs.forEach(cfg => {
            const card = document.createElement('div');
            card.className = `personal-stat personal-stat-${cfg.type}`;

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

        const list = items.length ? items : DEMO_ATTENTION;
        if (!list.length) return container.appendChild(createEmpty('暂时没有需要处理的事项，继续保持。'));

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

        const list = goals.length ? goals : DEMO_GOALS;
        if (!list.length) return container.appendChild(createEmpty('还没有自动目标。把重复工作交给 Agent 吧。'));

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
            appendText(copy, 'strong', 'personal-row-title', goal.title || '未命名自动目标');

            const metaText = goal.meta || (goal.nextRunAt ? `下次运行：${formatScheduledTime(goal.nextRunAt)}` : '等待外部事件触发');
            appendText(copy, 'span', 'personal-row-meta', metaText);

            const statusText = goal.statusText || '运行中';
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

        const list = items.length ? items : DEMO_RECENT;
        if (!list.length) return container.appendChild(createEmpty('还没有可继续的工作。发起一次对话或运行任务即可在这里看到它。'));

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
        const userName = currentUser?.nickname || currentUser?.username || '你';
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

    async function handleRecentWork(button) {
        const kind = button.dataset.personalRecentKind;
        const id = button.dataset.personalRecentId;
        if (kind === 'session' && id) return window.Pivot.moduleApi?.('chat.sessions')?.selectSession?.(id, undefined, { refreshSidebar: true });
        if (kind === 'run' && id) return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks', query: id });
        if (kind === 'artifact') return window.Pivot.legacy.openAppsWorkbench?.();
        return window.Pivot.legacy.showMainWorkspace?.('chat');
    }

    document.addEventListener('click', async event => {
        const action = event.target.closest('[data-personal-action]')?.dataset.personalAction;
        if (action) {
            if (action === 'refresh') return loadPersonalWorkbench();
            if (action === 'new-chat') return openShortcut('chat');
            if (action === 'new-document') {
                await openShortcut('official-writing');
                return document.getElementById('official-writing-create-doc-btn')?.click();
            }
            if (action === 'open-search') return document.getElementById('session-search-open')?.click();
            if (action === 'open-apps') return window.Pivot.legacy.openAppsWorkbench?.({ home: true });
            if (action === 'open-tools') return window.Pivot.legacy.openMcpWorkbench?.();
            if (action === 'open-settings') return window.Pivot.legacy.openAdminPanel?.();
            if (action === 'logout') return window.Pivot.legacy.logout?.();
            if (action === 'open-inbox') {
                await window.Pivot.legacy.openAgentWorkbench?.({ tab: 'workbench' });
                return document.querySelector('[data-agent-cp-subview="inbox"]')?.click();
            }
            if (action === 'open-goals') {
                await window.Pivot.legacy.openAgentWorkbench?.({ tab: 'workbench' });
                return document.querySelector('[data-agent-cp-subview="goals"]')?.click();
            }
            if (action === 'open-history') return window.Pivot.legacy.showMainWorkspace?.('chat');
            if (action === 'edit-shortcuts') return openShortcutEditor();
        }
        const shortcut = event.target.closest('[data-personal-shortcut]')?.dataset.personalShortcut;
        if (shortcut) await openShortcut(shortcut);
        const recent = event.target.closest('[data-personal-recent-id]');
        if (recent) await handleRecentWork(recent);
        const attention = event.target.closest('[data-personal-item-type]');
        if (attention) await window.Pivot.legacy.openAgentWorkbench?.({ tab: 'workbench' });
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
