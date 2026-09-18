/* 对话自适应路由前端状态、@ 显式覆盖与工具授权引导。 */
(() => {
    const RAG_PREFERENCE_KEY = 'pivot_chat_rag_preference';
    const MENTION_CATEGORY_LIMIT = 4;
    let available = true;
    let selections = [];
    let tools = [];
    let toolsLoading = null;

    const input = () => document.getElementById('user-input');
    // 输入区不再提供开关：在服务端能力开关允许时，普通会话始终采用自适应路由。
    // 这也使旧版本存下的“关闭智能自适应”状态不会让升级后的会话静默降级。
    const getAutoRouteEnabled = () => true;
    const getRagPreference = () => {
        try {
            const value = localStorage.getItem(RAG_PREFERENCE_KEY);
            return value === 'enabled' ? 'enabled' : 'auto';
        } catch (_) { return 'auto'; }
    };
    const setRagPreference = preference => {
        const value = preference === 'enabled' ? 'enabled' : 'auto';
        try {
            if (value === 'auto') localStorage.removeItem(RAG_PREFERENCE_KEY);
            else localStorage.setItem(RAG_PREFERENCE_KEY, value);
        } catch (_) {}
        syncState();
        return value;
    };
    const syncState = () => {
        return getAutoRouteEnabled();
    };
    const setAutoRouteEnabled = () => {
        // 保留模块 API 兼容性；不再允许在客户端关闭默认自适应行为。
        syncState();
        return true;
    };
    const getOverrides = prompt => {
        const current = String(prompt || input()?.value || '');
        const active = selections.filter(selection => current.includes(selection.token));
        return {
            collections: active.filter(selection => selection.kind === 'collection').map(selection => selection.id),
            tools: active.filter(selection => selection.kind === 'tool').map(selection => selection.fullName)
        };
    };
    const clearOverrides = () => { selections = []; };
    const mentionQuery = value => {
        const match = String(value || '').match(/(?:^|\s)@([^\s@]{0,80})$/u);
        return match ? String(match[1] || '').toLowerCase() : null;
    };
    const toolFullName = tool => String(tool?.fullName || tool?.full_name || tool?.name || '').trim();
    const toolLabel = tool => {
        const title = String(tool?.title || '').trim();
        if (title) return title;
        return String(tool?.name || toolFullName(tool) || '工具').split('.').pop().replace(/[_-]+/g, ' ');
    };
    const getMcpToolAllowlist = () => {
        const allowlist = window.Pivot.moduleApi('chat.inputMenu').getMcpToolAllowlist?.();
        return Array.isArray(allowlist)
            ? new Set(allowlist.map(value => String(value || '').trim()).filter(Boolean))
            : null;
    };
    const collectionCandidates = query => [...(document.getElementById('chat-rag-collection-scope')?.options || [])]
        .filter(option => option.value && !option.hidden)
        .map(option => ({ kind: 'collection', id: Number(option.value), name: String(option.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim(), detail: '知识库' }))
        .filter(item => Number.isSafeInteger(item.id) && item.id > 0 && item.name)
        .filter(item => !query || `${item.name} ${item.detail}`.toLowerCase().includes(query));
    const toolCandidates = query => {
        const allowlist = getMcpToolAllowlist();
        return tools
        .map(tool => {
            const fullName = toolFullName(tool);
            const source = String(tool?.serverName || tool?.description || '').trim();
            return {
                kind: 'tool',
                fullName,
                name: toolLabel(tool),
                detail: source ? `工具 · ${source}` : '工具'
            };
        })
        .filter(item => item.fullName)
        // 与真正的聊天执行链路使用同一份已保存白名单；@ 只能缩小范围，不能扩大权限。
        .filter(item => !allowlist || allowlist.has(item.fullName))
        .filter(item => !query || `${item.name} ${item.detail} ${item.fullName}`.toLowerCase().includes(query));
    };
    const closeMentionMenu = () => {
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu) return;
        menu.hidden = true;
        window.Pivot.legacy.PivotSafeHtml?.setHtml(menu, '');
    };
    const applyMention = selection => {
        const field = input();
        if (!selection || !field) return;
        const start = field.value.lastIndexOf('@');
        if (start < 0) return;
        const token = `@${selection.name}`;
        field.value = `${field.value.slice(0, start)}${token} ${field.value.slice(field.selectionEnd || field.value.length)}`;
        const next = selection.kind === 'collection'
            ? { kind: 'collection', id: selection.id, token }
            : { kind: 'tool', fullName: selection.fullName, token };
        selections = [...selections.filter(item => item.token !== token && (item.kind !== next.kind || (item.id || item.fullName) !== (next.id || next.fullName))), next].slice(-20);
        if (selection.kind === 'collection') {
            setRagPreference('enabled');
        }
        field.focus();
        window.Pivot.legacy.resizeUserInput?.();
        closeMentionMenu();
    };
    const renderMentionMenu = () => {
        const query = mentionQuery(input()?.value || '');
        if (query === null) return closeMentionMenu();
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu) return;
        // 裸 @ 必须同时给出两类能力。分组限额避免 Collection 数量较多时
        // 把工具候选完全挤出首屏。
        const candidates = [
            ...collectionCandidates(query).slice(0, MENTION_CATEGORY_LIMIT),
            ...toolCandidates(query).slice(0, MENTION_CATEGORY_LIMIT)
        ];
        window.Pivot.legacy.PivotSafeHtml?.setHtml(menu, '');
        if (!candidates.length) {
            const empty = document.createElement('div');
            empty.className = 'chat-route-mention-empty';
            empty.textContent = toolsLoading
                ? '正在加载当前可用工具...'
                : '未找到可引用的知识库或当前白名单内的工具';
            menu.appendChild(empty);
        } else {
            candidates.forEach((candidate, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'chat-route-mention-item';
                button.dataset.routeMentionIndex = String(index);
                button.setAttribute('role', 'option');
                const name = document.createElement('strong');
                name.textContent = `@${candidate.name}`;
                const detail = document.createElement('small');
                detail.textContent = candidate.detail;
                button.append(name, detail);
                const select = event => { event.preventDefault(); applyMention(candidate); };
                button.addEventListener('mousedown', select);
                button.addEventListener('click', event => { if (event.detail === 0) select(event); });
                menu.appendChild(button);
            });
        }
        menu.hidden = false;
    };
    const ensureMentionTools = async () => {
        // 空字符串是裸 @，仍应加载工具；只有没有 @ 时才跳过。
        if (tools.length || toolsLoading || mentionQuery(input()?.value || '') === null) return toolsLoading;
        toolsLoading = (async () => {
            const response = await apiFetch(`${API_BASE}/mcp/tools`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '工具目录加载失败');
            tools = Array.isArray(data.tools) ? data.tools : [];
            renderMentionMenu();
        })().catch(() => {
            // 工具目录不可用时仍让知识库候选可用，不把加载错误当成权限结论。
            renderMentionMenu();
        }).finally(() => {
            toolsLoading = null;
            renderMentionMenu();
        });
        return toolsLoading;
    };
    const enableMcpFromRouteTrace = async () => {
        try {
            if (localStorage.getItem('pivot_chat_mcp_enabled') === 'true'
                && window.Pivot.legacy.hasChatMcpConsent?.()) return true;
        } catch (_) {}
        const confirmed = await (window.Pivot.legacy.ensureChatMcpConsent?.() || Promise.resolve(true));
        if (!confirmed) return false;
        try { localStorage.setItem('pivot_chat_mcp_enabled', 'true'); } catch (_) {}
        showToast('本会话已允许使用工具。请重新发送这条消息，系统会自动选择所需工具。', 'info');
        return true;
    };
    const setAvailable = value => { available = value !== false; syncState(); };

    input()?.addEventListener('input', () => { renderMentionMenu(); ensureMentionTools().catch(() => {}); });
    input()?.addEventListener('keydown', event => {
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu?.hidden && event.key === 'Escape') {
            event.preventDefault();
            closeMentionMenu();
        } else if (!menu?.hidden && event.key === 'Enter' && !event.shiftKey) {
            const candidate = menu.querySelector('.chat-route-mention-item');
            if (candidate) {
                event.preventDefault();
                candidate.click();
            }
        }
    });
    window.Pivot.exposeModule('chat.autoRoute', {
        clearOverrides,
        closeMentionMenu,
        enableMcpFromRouteTrace,
        getAutoRouteEnabled,
        getOverrides,
        getRagPreference,
        isAvailable: () => available,
        setAutoRouteEnabled,
        setAvailable,
        setRagPreference,
        syncState
    });
})();
