/* 智枢前端主程序 Main Frontend Logic */
let currentAbortController = null;
let pendingAttachments = []; // 存储待发送的附件
let sidebarState = { page: 1, limit: 20, hasMore: true, isLoading: false, archived: false };
let searchTimeout = null;

// 全局 401 处理
function handleUnauthorized() {
    localStorage.removeItem('pivot_token');
    localStorage.removeItem('user');
    token = null;
    currentUser = null;
    showAuth();
}

// 搜索防抖处理
window.handleSearch = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        window.loadSessions();
    }, 400);
};

// --- 附件预览系统 ---
function renderAttachmentPreviews() {
    const previewArea = document.getElementById('attachment-preview');
    if (pendingAttachments.length === 0) {
        previewArea.classList.add('hidden');
        previewArea.innerHTML = '';
        return;
    }
    previewArea.classList.remove('hidden');
    previewArea.innerHTML = pendingAttachments.map((file, index) => {
        const isImage = file.type.startsWith('image/');
        if (isImage) {
            return `
                <div class="preview-card">
                    <img src="${file.url}" alt="preview">
                    <div class="remove-preview" onclick="event.stopPropagation(); removeAttachment(${index})">&times;</div>
                </div>
            `;
        } else {
            return `
                <div class="preview-card file-card">
                    <div class="file-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div class="file-name">${file.name}</div>
                    <div class="remove-preview" onclick="event.stopPropagation(); removeAttachment(${index})">&times;</div>
                </div>
            `;
        }
    }).join('');
}

window.removeAttachment = function(index) {
    pendingAttachments.splice(index, 1);
    renderAttachmentPreviews();
};

// --- 会话逻辑 ---
window.loadSessions = async function(append = false) {
    if (sidebarState.isLoading) return;
    
    const searchVal = document.getElementById('session-search-input')?.value || '';
    // 智能解析：如果包含 # 则提取为标签过滤，其余部分为关键词过滤
    const tagMatch = searchVal.match(/#(\S+)/);
    const tag = tagMatch ? tagMatch[1] : '';
    const keyword = searchVal.replace(/#\S+/, '').trim();
    
    if (!append) {
        sidebarState.page = 1;
        sidebarState.hasMore = true;
    }
    if (!sidebarState.hasMore) return;
    
    sidebarState.isLoading = true;
    try {
        const res = await fetch(`${API_BASE}/sessions?page=${sidebarState.page}&limit=${sidebarState.limit}&keyword=${encodeURIComponent(keyword)}&tag=${encodeURIComponent(tag)}&archived=${sidebarState.archived}`, { 
            headers: authHeaders() 
        });
        
        if (res.status === 401) return handleUnauthorized();
        
        const result = await res.json();
        const sessions = result.data || [];
        const hasMore = result.hasMore || false;
        
        const list = document.getElementById('session-list');
        if (!append) {
            list.innerHTML = '';
        }
        if (!list.dataset.boundLoadMore) {
            list.dataset.boundLoadMore = '1';
            list.addEventListener('scroll', () => {
                if (sidebarState.isLoading || !sidebarState.hasMore) return;
                if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
                    window.loadSessions(true);
                }
            }, { passive: true });
        }
        
        sessions.forEach(s => {
            const title = s.title || '新对话';
            const safeTitleStr = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const safeHTMLTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const safeTags = String(s.tags || '').split(',').filter(Boolean).map(tag => `<em>${tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</em>`).join('');
            const pinnedIcon = s.is_pinned ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 4.5V11l2 2v2h-5v6l-1 1-1-1v-6H6v-2l2-2V4.5A1.5 1.5 0 019.5 3h5A1.5 1.5 0 0116 4.5z"/></svg>' : '';
            const safeTagsStr = String(s.tags || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const badgeText = s.is_archived ? '已归档' : (s.is_pinned ? '置顶' : '');
            const div = document.createElement('div');
            div.className = `session-item ${s.id === currentSessionId ? 'active' : ''} ${s.is_pinned ? 'pinned' : ''}`;
            div.innerHTML = `
                <div class="session-main">
                    <span class="session-title-text" title="${safeHTMLTitle}">${pinnedIcon}${safeTags ? `<span class="session-tags-inline">${safeTags}</span>` : ''}<span class="session-title-content">${safeHTMLTitle}</span></span>
                    <div class="session-meta">
                        ${badgeText ? `<span class="session-badge">${badgeText}</span>` : ''}
                    </div>
                </div>
                <div class="session-more">
                    <button class="more-btn" onclick="toggleSessionMenu(event, '${s.id}', '${safeTitleStr}', ${s.is_pinned}, ${s.is_archived || 0}, '${safeTagsStr}')">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                </div>
            `;
            div.onclick = () => selectSession(s.id, title);
            list.appendChild(div);
        });
        
        sidebarState.hasMore = hasMore;
        sidebarState.page++;
    } catch (e) {
        console.error('加载会话失败:', e);
    } finally {
        sidebarState.isLoading = false;
    }
}

window.toggleSessionMenu = (e, id, title, isPinned, isArchived, tags) => {
    e.stopPropagation();
    const old = document.querySelector('.session-dropdown');
    if (old) old.remove();
    
    const menu = document.createElement('div');
    menu.className = 'session-dropdown';
    menu.innerHTML = `
        <div class="menu-item" onclick="togglePinSession('${id}', ${isPinned})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4.5V11l2 2v2h-5v6l-1 1-1-1v-6H6v-2l2-2V4.5A1.5 1.5 0 019.5 3h5A1.5 1.5 0 0116 4.5z"/></svg>
            ${isPinned ? '取消置顶' : '置顶对话'}
        </div>
        <div class="menu-item" onclick="renameSession('${id}', '${title}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            重命名
        </div>
        <div class="menu-item" onclick="editSessionTags('${id}', '${tags || ''}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
            编辑标签
        </div>
        <div class="menu-item" onclick="toggleArchiveSession('${id}', ${isArchived})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            ${isArchived ? '恢复对话' : '归档对话'}
        </div>
        <div class="menu-item danger" onclick="deleteSession('${id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            删除
        </div>
    `;
    
    document.body.appendChild(menu);
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 5}px`;
    menu.style.left = `${rect.right - 120}px`; 
    
    const closeMenu = () => {
        menu.remove();
        document.removeEventListener('click', closeMenu);
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
};

window.setArchiveFilter = (archived) => {
    sidebarState.archived = archived;
    document.getElementById('session-active-filter').classList.toggle('active', !archived);
    document.getElementById('session-archive-filter').classList.toggle('active', archived);
    window.loadSessions();
};

window.toggleArchiveSession = async (id, currentArchived) => {
    const res = await fetch(`${API_BASE}/sessions/${id}/archive`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ isArchived: !currentArchived })
    });
    if (res.ok) {
        showToast(!currentArchived ? '已归档' : '已恢复');
        if (currentSessionId === id && !sidebarState.archived) {
            currentSessionId = null;
            document.getElementById('current-title').innerText = '请选择或新建对话';
            document.getElementById('message-container').innerHTML = '';
        }
        await window.loadSessions();
    }
};

let editingTagsId = null;

window.editSessionTags = (id, currentTags) => {
    editingTagsId = id;
    document.getElementById('session-tags-input').value = currentTags || '';
    document.getElementById('tags-container').classList.remove('hidden');
    document.getElementById('session-tags-input').focus();
};

window.closeTagsModal = () => {
    document.getElementById('tags-container').classList.add('hidden');
    editingTagsId = null;
};

window.saveSessionTags = async () => {
    const tags = document.getElementById('session-tags-input').value;
    if (editingTagsId === null) return;
    
    const res = await fetch(`${API_BASE}/sessions/${editingTagsId}/tags`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tags })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '标签保存失败', 'error');
    showToast('标签已保存');
    await window.loadSessions();
    closeTagsModal();
};

window.togglePinSession = async (id, currentPinned) => {
    try {
        const res = await fetch(`${API_BASE}/sessions/${id}/pin`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ isPinned: !currentPinned })
        });
        if (res.ok) {
            showToast(!currentPinned ? '已置顶' : '已取消置顶');
            await window.loadSessions();
        }
    } catch (e) { showToast('操作失败', 'error'); }
};

let renamingSessionId = null;

window.renameSession = (id, oldTitle) => {
    renamingSessionId = id;
    document.getElementById('new-session-title').value = oldTitle;
    document.getElementById('rename-container').classList.remove('hidden');
    document.getElementById('new-session-title').focus();
};

window.closeRenameModal = () => {
    document.getElementById('rename-container').classList.add('hidden');
    renamingSessionId = null;
};

window.saveSessionTitle = async () => {
    const newTitle = document.getElementById('new-session-title').value;
    if (!newTitle || !renamingSessionId) return;
    
    const res = await fetch(API_BASE + `/sessions/${renamingSessionId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: newTitle })
    });
    
    if (res.ok) {
        if (currentSessionId === renamingSessionId) document.getElementById('current-title').innerText = newTitle;
        await window.loadSessions();
        closeRenameModal();
    }
};

// 通用确认弹窗逻辑
let confirmCallback = null;
window.showConfirm = (title, message, callback) => {
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-message').innerText = message;
    confirmCallback = callback;
    document.getElementById('confirm-container').classList.remove('hidden');
};

window.closeConfirmModal = () => {
    document.getElementById('confirm-container').classList.add('hidden');
    confirmCallback = null;
};

document.getElementById('confirm-ok-btn').onclick = () => {
    if (confirmCallback) confirmCallback();
    closeConfirmModal();
};

window.deleteSession = (id) => {
    showConfirm('删除会话', '确定要删除整个会话吗？此操作不可撤销。', async () => {
        const res = await fetch(API_BASE + `/sessions/${id}`, { 
            method: 'DELETE', 
            headers: authHeaders() 
        });
        if (res.ok) {
            if (currentSessionId === id) {
                currentSessionId = null;
                document.getElementById('current-title').innerText = '请选择或新建对话';
                document.getElementById('message-container').innerHTML = '';
            }
            await window.loadSessions();
            showToast('会话已删除');
        }
    });
};

document.getElementById('new-chat-btn').onclick = async () => {
    const session = await createSession('新对话');
    if (session) selectSession(session.id, session.title);
};

async function createSession(title) {
    const res = await fetch(API_BASE + '/sessions', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title })
    });
    const session = await res.json();
    if (!res.ok || !session.id) {
        showToast(session.error || '创建会话失败', 'error');
        return null;
    }
    return session;
}

async function selectSession(id, title) {
    currentSessionId = id;
    document.getElementById('current-title').innerText = title;
    const res = await fetch(API_BASE + `/sessions/${id}`, { headers: authHeaders() });
    const messages = await res.json();
    document.getElementById('message-container').innerHTML = '';
    messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .forEach(m => appendMessage(m.role, m.content, m.id, {
            costTime: m.cost_time,
            tps: m.tokens_per_sec,
            tokenCount: m.token_count
        }));
    await window.loadSessions();
}

const escapeCodeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeAttrValue = (value) => escapeCodeHtml(value).replace(/"/g, '&quot;');

// 自定义 Markdown 渲染器，支持附件卡片化显示
const customRenderer = new marked.Renderer();
customRenderer.code = (code, infostring, escaped) => {
    if (typeof code === 'object' && code !== null) {
        infostring = code.lang || code.info || '';
        escaped = code.escaped;
        code = code.text || code.raw || '';
    }
    const language = String(infostring || '').trim().split(/\s+/)[0];
    const languageLabel = language || 'code';
    
    let codeHtml;
    // 使用 highlight.js 进行语法高亮
    if (language && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
        try {
            codeHtml = hljs.highlight(code, { language }).value;
        } catch (e) {
            codeHtml = escapeCodeHtml(code);
        }
    } else if (typeof hljs !== 'undefined') {
        try {
            // 自动识别语言
            const result = hljs.highlightAuto(code);
            codeHtml = result.value;
        } catch (e) {
            codeHtml = escapeCodeHtml(code);
        }
    } else {
        codeHtml = escapeCodeHtml(code);
    }

    return `
        <div class="code-block">
            <div class="code-toolbar">
                <span class="code-language">${escapeCodeHtml(languageLabel)}</span>
                <button type="button" class="code-copy-btn" title="复制代码" aria-label="复制代码">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    <span>复制</span>
                </button>
            </div>
            <pre><code class="hljs ${language ? `language-${escapeAttrValue(language)}` : ''}">${codeHtml}</code></pre>
        </div>
    `;
};
customRenderer.link = (href, title, text) => {
    // 兼容 marked v11+ 的参数签名对象
    if (typeof href === 'object' && href !== null) {
        text = href.text;
        title = href.title;
        href = href.href;
    }
    
    // 安全容错：如果 text 为空或未定义，则赋予默认空字符串
    const safeText = text || '';
    const safeHref = escapeAttrValue(href || '#');
    const safeTitle = escapeAttrValue(title || '');
    
    const isDoc = safeText.includes('附件:') || safeText.includes('文件:') || /\.(pdf|doc|docx|xls|xlsx|txt|zip|rar)$/i.test(safeText);
    if (isDoc) {
        const docName = escapeCodeHtml(safeText.replace('附件:', '').replace('文件:', '').trim());
        return `
            <a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="doc-card-link">
                <div class="doc-card">
                    <div class="doc-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div class="doc-info">
                        <div class="doc-name">${docName}</div>
                        <div class="doc-action">点击下载/预览</div>
                    </div>
                </div>
            </a>
        `;
    }
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${safeTitle}">${escapeCodeHtml(safeText)}</a>`;
};

function stripInternalReferenceText(content) {
    return String(content ?? '')
        .replace(/\n{0,2}---\n【参考文档:[^\n]*】\n[\s\S]*?\n---(?=\n|$)/g, '')
        .trim();
}

function getDisplayContent(role, content) {
    return role === 'user' ? stripInternalReferenceText(content) : content;
}

function normalizeMarkdown(content) {
    const normalizeText = (text) => text
        .replace(/\*\*[ \t]+([^*\n][^*\n]*?)[ \t]+\*\*/g, (_, inner) => `**${inner.trim()}**`)
        .replace(/__[ \t]+([^_\n][^_\n]*?)[ \t]+__/g, (_, inner) => `__${inner.trim()}__`);

    return String(content).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map((block) => {
        if (/^(```|~~~)/.test(block)) return block;
        return block.split(/(`[^`\n]*`)/g).map((part) => {
            if (/^`[^`\n]*`$/.test(part)) return part;
            return normalizeText(part);
        }).join('');
    }).join('');
}

function renderMarkdown(content) {
    if (!content) return '';
    const normalizedContent = normalizeMarkdown(content);
    // 配置 marked 允许 HTML 标签
    const rawHtml = marked.parse(normalizedContent, { 
        renderer: customRenderer,
        breaks: true,
        gfm: true
    });
    
    // 如果有 DOMPurify，配置它允许特定的 HTML 标签
    if (window.DOMPurify) {
        return DOMPurify.sanitize(rawHtml, {
            ADD_TAGS: ['details', 'summary', 'thought'],
            ADD_ATTR: ['class', 'open', 'type', 'title', 'aria-label']
        });
    }
    return rawHtml;
}

function getThoughtOpenStates(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.thought-block')).map(block => block.classList.contains('is-open'));
}

function getThoughtScrollStates(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.thought-content-inner')).map(wrapper => ({
        top: wrapper.scrollTop,
        nearBottom: wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 24
    }));
}

function restoreThoughtScrollStates(root, states = []) {
    if (!root || !states.length) return;
    const wrappers = Array.from(root.querySelectorAll('.thought-content-inner'));
    wrappers.forEach((wrapper, index) => {
        const state = states[index];
        if (!state) return;
        wrapper.scrollTop = state.nearBottom ? wrapper.scrollHeight : state.top;
    });
}

function bindThoughtStateTracking(root) {
    if (!root || root.dataset.thoughtTrackingBound === '1') return;
    root.dataset.thoughtTrackingBound = '1';
    root._thoughtOpenStates = [];
    root._thoughtScrollStates = [];
    
    root.addEventListener('click', (event) => {
        const summary = event.target.closest('.thought-summary');
        if (!summary) return;
        const block = summary.closest('.thought-block');
        if (!block) return;
        
        const blocks = Array.from(root.querySelectorAll('.thought-block'));
        const index = blocks.indexOf(block);
        if (index >= 0) {
            const willBeOpen = !block.classList.contains('is-open');
            block.classList.toggle('is-open', willBeOpen);
            root._thoughtOpenStates[index] = willBeOpen;
            root._thoughtScrollStates = getThoughtScrollStates(root);
        }
    }, true);

    root.addEventListener('scroll', (event) => {
        if (!event.target.closest?.('.thought-content-inner')) return;
        root._thoughtScrollStates = getThoughtScrollStates(root);
    }, true);
}

function getRememberedThoughtOpenStates(root) {
    const domStates = getThoughtOpenStates(root);
    const rememberedStates = root?._thoughtOpenStates || [];
    return domStates.map((state, index) => rememberedStates[index] ?? state);
}

function rememberThoughtStateBeforeRender(root) {
    if (!root) return { openStates: [], scrollStates: [] };
    const openStates = getRememberedThoughtOpenStates(root);
    const scrollStates = getThoughtScrollStates(root);
    root._thoughtOpenStates = openStates;
    root._thoughtScrollStates = scrollStates;
    return { openStates, scrollStates };
}

function restoreThoughtStateAfterRender(root, state) {
    if (!root || !state) return;
    root._thoughtOpenStates = state.openStates || [];
    root._thoughtScrollStates = state.scrollStates || [];
    restoreThoughtScrollStates(root, root._thoughtScrollStates);
}

function scrollMessageContainerIfNearBottom() {
    const container = document.getElementById('message-container');
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) {
        container.scrollTop = container.scrollHeight;
    }
}

function renderAiMessage(content, isStreaming = false, thoughtOpenStates = []) {
    if (!content) return '';
    
    let blocks = [];
    let counter = 0;
    
    // 1. 提取所有思考块并生成安全的渲染后 HTML，用纯文本占位符替换原位置
    let temp = content.replace(/<thought>([\s\S]*?)<\/thought>/g, (match, p1) => {
        const id = `THOUGHT_BLOCK_PLACEHOLDER_${counter++}_`;
        blocks.push({
            id,
            html: `<div class="thought-block${thoughtOpenStates[counter - 1] ? ' is-open' : ''}"><div class="thought-summary">模型思考内容</div><div class="thought-content-wrapper"><div class="thought-content-inner"><div class="thought-content">${renderMarkdown(p1)}</div></div></div></div>`
        });
        return `\n\n${id}\n\n`;
    });
    
    // 2. 提取尚未闭合的流式思考块
    if (temp.includes('<thought>')) {
        temp = temp.replace(/<thought>([\s\S]*)$/, (match, p1) => {
            const id = `THOUGHT_BLOCK_PLACEHOLDER_${counter++}_`;
            blocks.push({
                id,
                html: `<div class="thought-block thinking${thoughtOpenStates[counter - 1] ? ' is-open' : ''}"><div class="thought-summary">模型正在思考</div><div class="thought-content-wrapper"><div class="thought-content-inner"><div class="thought-content">${renderMarkdown(p1)}</div></div></div></div>`
            });
            return `\n\n${id}\n\n`;
        });
    }
    
    // 3. 对剥离了思考块的主体内容进行统一 Markdown 渲染
    let finalHtml = renderMarkdown(temp);
    
    // 4. 将安全的 HTML 结构塞回占位符原位
    for (const block of blocks) {
        // 处理 Marked 可能自动生成的无用段落包裹
        const pRegex = new RegExp(`<p>\\s*${block.id}\\s*<\\/p>`, 'g');
        if (finalHtml.match(pRegex)) {
            finalHtml = finalHtml.replace(pRegex, block.html);
        } else {
            finalHtml = finalHtml.replace(block.id, block.html);
        }
    }
    
    return finalHtml;
}

const ICONS = {
    user: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    ai: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2"><path d="M12 2L4.5 9V15L12 22L19.5 15V9L12 2Z"/><path d="M12 6V18"/><path d="M8 10V14"/><path d="M16 10V14"/><circle cx="12" cy="12" r="1"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`
};

function appendMessage(role, content, id = null, stats = null) {
    const container = document.getElementById('message-container');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const displayContent = getDisplayContent(role, content);
    
    // 根据角色分发渲染策略：AI 走独立处理流，User 走普通渲染
    const displayHtml = role === 'assistant' ? renderAiMessage(displayContent, false) : renderMarkdown(displayContent);
    
    // 头像 HTML (使用 SVG)
    const avatarHtml = `<div class="avatar">${role === 'user' ? ICONS.user : ICONS.ai}</div>`;

    // 注入操作栏 (SVG 图标)
    const actionsHtml = `
        <div class="message-actions">
            <button class="action-btn" onclick="copyMsg(this)" title="复制">${ICONS.copy}</button>
            ${id ? `<button class="action-btn" onclick="deleteMsg(${id}, this)" title="删除">${ICONS.delete}</button>` : ''}
        </div>
    `;

    div.innerHTML = `
        ${avatarHtml}
        <div class="message-content">
            <div class="text-body">${displayHtml}</div>
            ${stats && (stats.costTime !== undefined && stats.costTime !== null) ? `
                <div class="message-stats">
                    <span class="stat-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        ${Number(stats.costTime).toFixed(1)}s
                    </span>
                    <span class="stat-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        ${stats.tokenCount || 0} Tokens
                    </span>
                    <span class="stat-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-5c1.62-2.2 5-3 5-3"/><path d="M12 15v5s3.03-.55 5-2c2.2-1.62 3-5 3-5"/></svg>
                        ${Number(stats.tps).toFixed(1)} t/s
                    </span>
                </div>
            ` : ''}
            ${actionsHtml}
        </div>
    `;
    container.appendChild(div);
    
    if (role === 'assistant') {
        const textBody = div.querySelector('.text-body');
        if (textBody) bindThoughtStateTracking(textBody);
    }
    
    container.scrollTop = container.scrollHeight;
    return div.querySelector('.message-content');
}

window.copyMsg = (btn) => {
    const contentEl = btn.closest('.message-content').cloneNode(true);
    
    // 移除不必要的操作栏
    const actions = contentEl.querySelector('.message-actions');
    if (actions) actions.remove();
    
    // 移除底部的统计指标
    const stats = contentEl.querySelector('.message-stats');
    if (stats) stats.remove();

    contentEl.querySelectorAll('.code-toolbar').forEach(toolbar => toolbar.remove());
    
    // 提取纯文本并写入剪贴板
    navigator.clipboard.writeText(contentEl.innerText.trim());
    showToast('内容已复制');
};

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('pre code');
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code.textContent);
        const label = btn.querySelector('span');
        const oldText = label ? label.innerText : btn.innerText;
        btn.disabled = true;
        if (label) label.innerText = '已复制';
        else btn.innerText = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
            if (label) label.innerText = oldText;
            else btn.innerText = oldText;
            btn.classList.remove('copied');
            btn.disabled = false;
        }, 1200);
    } catch (err) {
        showToast('复制失败', 'error');
    }
});

window.deleteMsg = (id, btn) => {
    showConfirm('删除消息', '确定要删除这条消息吗？', async () => {
        const res = await fetch(`${API_BASE}/messages/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            btn.closest('.message').remove();
            showToast('消息已删除');
        }
    });
};

const userInput = document.getElementById('user-input');
function resizeUserInput() {
    userInput.style.height = 'auto';
    userInput.style.height = `${Math.min(userInput.scrollHeight, 180)}px`;
}
userInput.addEventListener('input', resizeUserInput);
resizeUserInput();
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
document.getElementById('send-btn').onclick = sendMessage;

document.getElementById('stop-btn').onclick = () => {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
};

const fileInput = document.getElementById('file-input');
document.getElementById('upload-btn').onclick = () => fileInput.click();

window.saveMyDefaultModel = async (modelId = null) => {
    const modelSelector = document.getElementById('model-selector');
    const saveBtn = document.getElementById('save-default-model-btn');
    const targetModelId = modelId || modelSelector?.value || null;
    if (!targetModelId) return;

    if (saveBtn) saveBtn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/settings/default-model`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ default_model_id: targetModelId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存默认模型失败');
        if (modelSelector && [...modelSelector.options].some(opt => String(opt.value) === String(targetModelId))) {
            modelSelector.value = targetModelId;
        }
        showToast('已设为默认模型');
        return data;
    } catch (e) {
        showToast(e.message || '保存默认模型失败', 'error');
        throw e;
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
};

fileInput.onchange = async () => {
    if (!fileInput.files.length) return;
    const file = fileInput.files[0];
    if (!currentSessionId) {
        const session = await createSession('新对话');
        if (!session) {
            fileInput.value = '';
            return;
        }
        currentSessionId = session.id;
        document.getElementById('current-title').innerText = session.title;
        await window.loadSessions();
    }
    const formData = new FormData();
    formData.append('file', file);

    try {
        showToast('正在上传...', 'info');
        const res = await fetch(`${API_BASE}/upload?sessionId=${currentSessionId || ''}`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.url) {
            // 将附件存入待发送队列，内容部分使用折叠标签封装，防止 UI 撑爆
            pendingAttachments.push({
                name: data.name,
                url: data.url,
                type: file.type,
                extractedText: data.extractedText,
                markdown: file.type.startsWith('image/') 
                    ? `![${data.name}](${data.url})` 
                    : `[附件: ${data.name}](${data.url})`
            });
            renderAttachmentPreviews();
            showToast('上传成功');
        }
    } catch (e) { showToast('上传失败', 'error'); }
    fileInput.value = '';
};

async function sendMessage() {
    const userVisibleContent = userInput.value.trim();
    let content = userVisibleContent;
    const modelId = document.getElementById('model-selector').value;
    
    // 如果有附件但没文字，也允许发送
    if (!content && pendingAttachments.length === 0) return;

    // 自动追加附件 Markdown 链接
    if (pendingAttachments.length > 0) {
        const attachmentLinks = pendingAttachments.map(a => a.markdown).join('\n');
        content = (content ? content + '\n\n' : '') + attachmentLinks;
        
        // 将文档提取文本以纯文本方式追加（仅供模型参考，不影响 UI 渲染）
        const docTexts = pendingAttachments
            .filter(a => a.extractedText)
            .map(a => `\n\n---\n【参考文档: ${a.name}】\n${a.extractedText}\n---`)
            .join('');
        if (docTexts) content += docTexts;
    }

    // 清空输入和预览
    userInput.value = '';
    resizeUserInput();
    pendingAttachments = [];
    renderAttachmentPreviews();

    // 如果当前没有会话，先自动创建一个新对话
    if (!currentSessionId) {
        try {
            const data = await createSession(content.slice(0, 15) + '...');
            if (data && data.id) {
                currentSessionId = data.id;
                // 刷新左侧会话列表并标记当前选中状态
                await window.loadSessions();
                document.getElementById('current-title').innerText = data.title;
            } else {
                return showToast('创建会话失败', 'error');
            }
        } catch (e) {
            return showToast('网络错误，无法创建会话', 'error');
        }
    }

    appendMessage('user', userVisibleContent);
    const aiMsgEl = appendMessage('assistant', '...');
    let fullAiContent = '';
    let tokenCount = 0;
    let startTime = Date.now();
    let firstTokenTime = null;

    document.getElementById('send-btn').classList.add('hidden');
    document.getElementById('stop-btn').classList.remove('hidden');

    currentAbortController = new AbortController();

    try {
        const response = await fetch(API_BASE + '/chat', {
            method: 'POST',
            headers: authHeaders({
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            }),
            body: JSON.stringify({ 
                sessionId: currentSessionId, 
                content,
                displayContent: userVisibleContent || stripInternalReferenceText(content),
                modelId,
                costTime: 0, 
                tps: 0
            }),
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`服务器拒绝了请求 (${response.status}): ${errText.slice(0, 50)}`);
        }

        const responseType = response.headers.get('content-type') || '';
        if (responseType.includes('application/json')) {
            const data = await response.json();
            fullAiContent = data.content || data.error || '';
            const textBody = aiMsgEl.querySelector('.text-body');
            if (textBody) {
                textBody.innerHTML = renderAiMessage(fullAiContent, false);
            }
            await selectSession(currentSessionId, document.getElementById('current-title').innerText);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let streamDone = false;

        // 查找正文容器，用于后续流式更新
        const textBody = aiMsgEl.querySelector('.text-body');
        bindThoughtStateTracking(textBody);
        textBody.innerHTML = ''; 

        const statsEl = document.createElement('div');
        statsEl.className = 'message-stats';
        aiMsgEl.appendChild(statsEl); 

        while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';
            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine.startsWith('data: ')) {
                    if (cleanLine === 'data: [DONE]') {
                        streamDone = true;
                        break;
                    }
                    try {
                        const data = JSON.parse(cleanLine.replace(/^data:\s*/, ''));
                        if (data.error) {
                            textBody.innerHTML = `
                                <div class="error-wrapper">
                                    <div class="error-header" style="color: #ef4444; font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 5px;">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                                        模型响应异常
                                    </div>
                                    <div class="error-detail" style="font-size: 0.85rem; background: rgba(239, 68, 68, 0.1); padding: 8px; border-radius: 4px; border-left: 3px solid #ef4444; font-family: monospace;">${data.detail || data.error}</div>
                                    <div class="error-hint" style="font-size: 0.75rem; color: #6b7280; margin-top: 8px;">请核对 API Key 是否有效，或检查中转服务商的状态。</div>
                                </div>
                            `;
                            aiMsgEl.closest('.message').style.background = 'rgba(239, 68, 68, 0.05)';
                            break;
                        }
                        if (data.content) {
                            if (!firstTokenTime) firstTokenTime = Date.now();
                            fullAiContent += data.content;
                            
                            // 前端同步采用中英加权估算逻辑，让 TPS 显示更专业
                            const chineseChars = (fullAiContent.match(/[\u4e00-\u9fa5]/g) || []).length;
                            const otherChars = fullAiContent.length - chineseChars;
                            tokenCount = Math.ceil(chineseChars * 2 + otherChars * 0.5);
                            
                            // 流式思考阶段增量更新策略：
                            // 当内容只有一个未闭合的思考块时，直接更新 .thought-content 避免全量重渲染
                            const hasOpenThought = fullAiContent.includes('<thought>') && !fullAiContent.includes('</thought>');
                            const hasClosedThought = fullAiContent.includes('</thought>');
                            const existingThoughtContent = textBody.querySelector('.thought-block.thinking .thought-content');
                            
                            if (hasOpenThought && !hasClosedThought && existingThoughtContent) {
                                // 纯思考阶段增量更新：只替换思考内容文本，不触碰外层 DOM
                                const thoughtText = fullAiContent.replace(/^<thought>/, '');
                                existingThoughtContent.innerHTML = renderMarkdown(thoughtText);
                                // 如果思考块处于展开状态，自动滚动到底部
                                const innerWrapper = existingThoughtContent.closest('.thought-content-inner');
                                if (innerWrapper && innerWrapper.closest('.thought-block')?.classList.contains('is-open')) {
                                    innerWrapper.scrollTop = innerWrapper.scrollHeight;
                                }
                            } else {
                                // 结构变化（思考结束/正文开始/新思考块出现）：全量重渲染
                                const thoughtState = rememberThoughtStateBeforeRender(textBody);
                                textBody.innerHTML = renderAiMessage(fullAiContent, true, thoughtState.openStates);
                                restoreThoughtStateAfterRender(textBody, thoughtState);
                            }
                            
                            // 更新实时指标标签
                            const elapsed = (Date.now() - startTime) / 1000;
                            const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
                            statsEl.innerHTML = `
                                <span class="stat-item">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                    ${elapsed.toFixed(1)}s
                                </span>
                                <span class="stat-item">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                    ${tokenCount} Tokens
                                </span>
                                <span class="stat-item">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-5c1.62-2.2 5-3 5-3"/><path d="M12 15v5s3.03-.55 5-2c2.2-1.62 3-5 3-5"/></svg>
                                    ${tps} t/s
                                </span>
                            `;
                        }
                    } catch (e) {}
                }
            }
            scrollMessageContainerIfNearBottom();
        }

        // 回答完成，发送最终统计数据给后端（用于持久化存入数据库）
        const finalElapsed = (Date.now() - startTime) / 1000;
        const finalTps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
        
        await fetch(API_BASE + '/chat/stats', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ 
                sessionId: currentSessionId,
                costTime: finalElapsed,
                tps: finalTps
            })
        });

        // 重新加载当前会话以获取最新消息 ID 并支持删除
        selectSession(currentSessionId, document.getElementById('current-title').innerText);
    } catch (e) { 
        if (e.name === 'AbortError') {
            fullAiContent += '\n\n[已由用户中断生成]';
            const textBody = aiMsgEl.querySelector('.text-body') || aiMsgEl;
            const finalStates = getRememberedThoughtOpenStates(textBody);
            textBody.innerHTML = renderAiMessage(fullAiContent, false, finalStates);
        } else {
            aiMsgEl.innerHTML = `
                <div class="error-wrapper">
                    <div class="error-header" style="color: #ef4444; font-weight: bold; margin-bottom: 5px;">连接模型失败</div>
                    <div class="error-detail" style="font-size: 0.85rem; background: rgba(239, 68, 68, 0.1); padding: 8px; border-radius: 4px; border-left: 3px solid #ef4444;">${e.message}</div>
                    <div class="error-hint" style="font-size: 0.75rem; color: #6b7280; margin-top: 8px;">可能的原因：后端服务未启动、模型 API 地址配置错误或网络环境受限。</div>
                </div>
            `;
            aiMsgEl.closest('.message').style.background = 'rgba(239, 68, 68, 0.05)';
        }
    } finally {
        document.getElementById('stop-btn').classList.add('hidden');
        document.getElementById('send-btn').classList.remove('hidden');
        currentAbortController = null;
    }
}

// 搜索防抖
let searchTimer = null;
document.getElementById('session-search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.loadSessions(), 300);
});
document.getElementById('session-tag-filter')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.loadSessions(), 300);
});

// 侧边栏折叠逻辑
window.toggleSidebar = () => {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.toggle('collapsed');
};

// 启动初始化
checkLogin();
