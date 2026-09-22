/* 对话自适应路由前端状态、@ 显式覆盖与工具授权引导。 */
(() => {
    const RAG_PREFERENCE_KEY = 'pivot_chat_rag_preference';
    const MENTION_PAGE_SIZE = 6;
    let available = true;
    let selections = [];
    let tools = [];
    let toolsLoading = null;
    let mentionScope = '';
    let mentionSearchQuery = '';
    let mentionPage = 0;

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
        const title = String(tool?.displayTitle || tool?.title || '').trim();
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
            const source = String(tool?.serverName || tool?.displayDescription || tool?.description || '').trim();
            return {
                kind: 'tool',
                fullName,
                name: toolLabel(tool),
                detail: source ? `工具 · ${source}` : '工具',
                aliases: Array.isArray(tool?.searchAliases) ? tool.searchAliases : []
            };
        })
        .filter(item => item.fullName)
        // 与真正的聊天执行链路使用同一份已保存白名单；@ 只能缩小范围，不能扩大权限。
        .filter(item => !allowlist || allowlist.has(item.fullName))
        .filter(item => !query || `${item.name} ${item.detail} ${item.fullName} ${item.aliases.join(' ')}`.toLowerCase().includes(query));
    };
    const closeMentionMenu = () => {
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu) return;
        mentionScope = '';
        mentionSearchQuery = '';
        mentionPage = 0;
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
    const appendMentionCandidate = (menu, candidate, index) => {
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
    };
    const setMentionScope = scope => {
        mentionScope = scope === 'tool' ? 'tool' : 'collection';
        // 用户先输入 @关键词 再选择类别时，保留关键词继续搜索。
        mentionSearchQuery = mentionQuery(input()?.value || '') || '';
        mentionPage = 0;
        if (mentionScope === 'tool') ensureMentionTools().catch(() => {});
        renderMentionMenu({ focusSearch: true });
    };
    const appendScopeOption = (menu, scope, label, description) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-route-mention-scope';
        button.dataset.routeMentionScope = scope;
        button.setAttribute('role', 'option');
        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = label;
        const detail = document.createElement('small');
        detail.textContent = description;
        text.append(title, detail);
        const arrow = document.createElement('span');
        arrow.className = 'chat-route-mention-scope-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        button.append(text, arrow);
        const select = event => { event.preventDefault(); setMentionScope(scope); };
        button.addEventListener('mousedown', select);
        button.addEventListener('click', event => { if (event.detail === 0) select(event); });
        menu.appendChild(button);
    };
    const renderMentionScopePicker = (menu, typedQuery = '') => {
        const hint = document.createElement('div');
        hint.className = 'chat-route-mention-picker-hint';
        hint.textContent = typedQuery
            ? `已输入“${typedQuery}”，请选择要搜索的类型`
            : '选择要引用的能力';
        menu.appendChild(hint);
        appendScopeOption(menu, 'collection', '知识库', '搜索有权访问的资料库');
        appendScopeOption(menu, 'tool', '工具', '搜索当前允许使用的工具');
    };
    const renderMentionSearch = (menu, { focusSearch = false } = {}) => {
        const isToolScope = mentionScope === 'tool';
        const query = String(mentionSearchQuery || '').trim().toLowerCase();
        const header = document.createElement('div');
        header.className = 'chat-route-mention-search-header';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'chat-route-mention-back';
        back.setAttribute('aria-label', '返回类型选择');
        back.textContent = '‹';
        back.addEventListener('mousedown', event => {
            event.preventDefault();
            mentionScope = '';
            mentionSearchQuery = '';
            mentionPage = 0;
            renderMentionMenu();
            input()?.focus();
        });
        const title = document.createElement('strong');
        title.textContent = isToolScope ? '搜索工具' : '搜索知识库';
        header.append(back, title);
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'chat-route-mention-search';
        search.placeholder = isToolScope ? '输入工具名称或服务' : '输入知识库名称';
        search.value = mentionSearchQuery;
        search.setAttribute('aria-label', title.textContent);
        search.addEventListener('input', event => {
            mentionSearchQuery = String(event.target.value || '').toLowerCase();
            mentionPage = 0;
            renderMentionMenu({ focusSearch: true });
        });
        search.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                mentionScope = '';
                mentionSearchQuery = '';
                mentionPage = 0;
                renderMentionMenu();
                input()?.focus();
                return;
            }
            if (event.key === 'Enter') {
                const candidate = menu.querySelector('.chat-route-mention-item');
                if (candidate) {
                    event.preventDefault();
                    candidate.click();
                }
            }
        });
        menu.append(header, search);
        if (isToolScope && toolsLoading) {
            const loading = document.createElement('div');
            loading.className = 'chat-route-mention-empty';
            loading.textContent = '正在加载当前可用工具...';
            menu.appendChild(loading);
        } else {
            const allCandidates = isToolScope ? toolCandidates(query) : collectionCandidates(query);
            const total = allCandidates.length;
            const pageCount = Math.max(1, Math.ceil(total / MENTION_PAGE_SIZE));
            const page = Math.min(Math.max(0, mentionPage), pageCount - 1);
            mentionPage = page;
            const start = page * MENTION_PAGE_SIZE;
            const candidates = allCandidates.slice(start, start + MENTION_PAGE_SIZE);
            if (!candidates.length) {
                const empty = document.createElement('div');
                empty.className = 'chat-route-mention-empty';
                empty.textContent = query
                    ? `未找到匹配的${isToolScope ? '工具' : '知识库'}`
                    : `暂无可引用的${isToolScope ? '工具' : '知识库'}`;
                menu.appendChild(empty);
            } else {
                const summary = document.createElement('div');
                summary.className = 'chat-route-mention-result-summary';
                summary.textContent = `已显示 ${start + 1}–${start + candidates.length} / ${total}`;
                menu.appendChild(summary);
                candidates.forEach((candidate, index) => appendMentionCandidate(menu, candidate, start + index));
                if (pageCount > 1) {
                    const pager = document.createElement('div');
                    pager.className = 'chat-route-mention-pager';
                    const previous = document.createElement('button');
                    previous.type = 'button';
                    previous.textContent = '上一页';
                    previous.disabled = page === 0;
                    const goPrevious = event => {
                        event.preventDefault();
                        mentionPage = Math.max(0, page - 1);
                        renderMentionMenu({ focusSearch: true });
                    };
                    previous.addEventListener('mousedown', goPrevious);
                    previous.addEventListener('click', event => { if (event.detail === 0) goPrevious(event); });
                    const pageText = document.createElement('span');
                    pageText.textContent = `${page + 1} / ${pageCount}`;
                    const next = document.createElement('button');
                    next.type = 'button';
                    next.textContent = '下一页';
                    next.disabled = page >= pageCount - 1;
                    const goNext = event => {
                        event.preventDefault();
                        mentionPage = Math.min(pageCount - 1, page + 1);
                        renderMentionMenu({ focusSearch: true });
                    };
                    next.addEventListener('mousedown', goNext);
                    next.addEventListener('click', event => { if (event.detail === 0) goNext(event); });
                    pager.append(previous, pageText, next);
                    menu.appendChild(pager);
                }
            }
        }
        if (focusSearch) {
            window.setTimeout(() => {
                search.focus();
                search.setSelectionRange(search.value.length, search.value.length);
            }, 0);
        }
    };
    const renderMentionMenu = ({ focusSearch = false } = {}) => {
        const typedQuery = mentionQuery(input()?.value || '');
        if (typedQuery === null) return closeMentionMenu();
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu) return;
        window.Pivot.legacy.PivotSafeHtml?.setHtml(menu, '');
        if (mentionScope) renderMentionSearch(menu, { focusSearch });
        else renderMentionScopePicker(menu, typedQuery);
        menu.hidden = false;
    };
    const ensureMentionTools = async () => {
        if (tools.length || toolsLoading || mentionScope !== 'tool') return toolsLoading;
        toolsLoading = (async () => {
            const response = await apiFetch(`${API_BASE}/mcp/tools`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '工具目录加载失败');
            tools = Array.isArray(data.tools) ? data.tools : [];
            renderMentionMenu({ focusSearch: true });
        })().catch(() => {
            // 工具目录不可用时仍让知识库候选可用，不把加载错误当成权限结论。
            renderMentionMenu({ focusSearch: true });
        }).finally(() => {
            toolsLoading = null;
            renderMentionMenu({ focusSearch: true });
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
        return true;
    };
    const setAvailable = value => { available = value !== false; syncState(); };

    input()?.addEventListener('input', () => {
        if (mentionQuery(input()?.value || '') === null) {
            mentionScope = '';
            mentionSearchQuery = '';
            mentionPage = 0;
        }
        renderMentionMenu();
    });
    input()?.addEventListener('keydown', event => {
        const menu = document.getElementById('chat-route-mention-menu');
        if (!menu?.hidden && event.key === 'Escape') {
            event.preventDefault();
            closeMentionMenu();
        } else if (!menu?.hidden && event.key === 'Enter' && !event.shiftKey) {
            const candidate = menu.querySelector('.chat-route-mention-item, .chat-route-mention-scope');
            if (candidate) {
                event.preventDefault();
                candidate.click();
            }
        }
    });
    document.addEventListener('click', event => {
        if (event.target.closest?.('#chat-route-mention-menu') || event.target === input()) return;
        closeMentionMenu();
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
