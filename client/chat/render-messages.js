/* 消息渲染辅助函数（拆自 render.js） */




function renderAiMessage(content, _isStreaming = false, thoughtOpenStates = []) {
    if (!content) return '';
    // 使用全局变量传递状态给 marked 渲染器
    window._tempThoughtCounter = 0;
    window._tempThoughtStates = thoughtOpenStates;
    return renderMarkdown(content, { deferPivotCharts: Boolean(_isStreaming) });
}

function hasAttachmentUrl(value = '') {
    return /^\/uploads\//.test(String(value || '').trim());
}

function normalizeAttachmentSnapshot(items = []) {
    if (!Array.isArray(items)) return [];
    return items.map(item => {
        if (!item || typeof item !== 'object') return null;
        const url = String(item.url || '').trim();
        if (!hasAttachmentUrl(url)) return null;
        const type = String(item.type || '');
        return {
            name: String(item.name || '附件'),
            url,
            type,
            markdown: String(item.markdown || '')
        };
    }).filter(Boolean);
}

function renderMessageAttachmentTiles(attachments = []) {
    return attachments.map(file => {
        const safeName = escapeCodeHtml(file.name);
        const safeAttrName = escapeAttrValue(file.name);
        const safeUrl = escapeAttrValue(file.url);
        const isImage = typeof window.isChatImageAttachment === 'function'
            ? window.isChatImageAttachment(file)
            : String(file.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(file.url);
        if (isImage) {
            return `
                <figure class="message-attachment image-attachment">
                    <img class="message-image" src="${safeUrl}" alt="${safeAttrName}" loading="lazy">
                    <figcaption>${safeName}</figcaption>
                </figure>
            `;
        }
        return `
            <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="doc-card-link" data-attachment-preview data-attachment-url="${safeUrl}" data-attachment-name="${safeAttrName}" data-attachment-type="${escapeAttrValue(file.type)}">
                <div class="doc-card">
                    <div class="doc-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                    <div class="doc-info"><div class="doc-name">${safeName}</div><div class="doc-action">点击下载/预览</div></div>
                </div>
            </a>
        `;
    }).join('');
}

function stripSnapshotAttachmentMarkdown(content, attachments = []) {
    let output = String(content || '');
    for (const attachment of attachments) {
        const markdown = String(attachment.markdown || '').trim();
        if (!markdown) continue;
        output = output.replace(markdown, '');
    }
    return output.replace(/\n{3,}/g, '\n\n').trim();
}

function buildUserMessageHtml(content, stats = null) {
    const attachments = normalizeAttachmentSnapshot(stats?.attachments || stats?.pendingAttachments || []);
    if (attachments.length === 0) return renderMarkdown(content);

    const textContent = stripSnapshotAttachmentMarkdown(getDisplayContent('user', content), attachments);
    const textHtml = textContent ? renderMarkdown(textContent) : '';
    const attachmentsHtml = renderMessageAttachmentTiles(attachments);
    return `<div class="message-user-body">${textHtml}${attachmentsHtml}</div>`;
}

function attachMessageImageLoadPinning(root) {
    root?.querySelectorAll?.('img.message-image').forEach(img => {
        img.addEventListener('load', () => window.scrollMessagesToBottom?.(), { once: true });
    });
}

function getMessageModelName(stats = {}) {
    return String(stats?.modelName || stats?.model_name || stats?.model || '').trim();
}

function buildAssistantStatsHtml(stats = {}) {
    const modelName = getMessageModelName(stats);
    const items = [];
    if (modelName) {
        items.push(`<span class="stat-item stat-model" title="模型：${escapeAttrValue(modelName)}">${ICONS.model}${escapeCodeHtml(modelName)}</span>`);
    }
    if (stats && stats.costTime !== undefined) {
        items.push(`<span class="stat-item">${ICONS.time}${Number(stats.costTime).toFixed(1)}s</span>`);
        items.push(`<span class="stat-item">${ICONS.token}${stats.tokenCount || 0} Tokens</span>`);
        items.push(`<span class="stat-item">${ICONS.speed}${Number(stats.tps).toFixed(1)} t/s</span>`);
    }
    if (!items.length) return '';
    return `<div class="message-stats"${modelName ? ` data-model-name="${escapeAttrValue(modelName)}"` : ''}>${items.join('')}</div>`;
}

function appendMessage(role, content, id = null, stats = null, mountOptions = null) {
    // mountOptions 允许调用方批量追加（例如会话切换）：提供
    // 目标容器或 fragment，并延后每条消息的图表渲染和滚动。
    const target = mountOptions?.target || document.getElementById('message-container');
    const deferRender = Boolean(mountOptions?.deferRender);
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (id) div.dataset.messageId = String(id);
    const displayContent = getDisplayContent(role, content);
    const displayHtml = role === 'assistant' ? renderAiMessage(displayContent, false) : buildUserMessageHtml(displayContent, stats);
    const createdAt = stats?.createdAt || stats?.created_at || stats?.created_at_text;
    const messageTime = formatChatDateTime(createdAt);
    const messageTimeTitle = formatChatDateTime(createdAt);
    const messageTimeHtml = messageTime ? `<span class="message-meta" title="${escapeAttrValue(messageTimeTitle)}">${escapeCodeHtml(messageTime)}</span>` : '';
    const statsHtml = role === 'assistant' ? buildAssistantStatsHtml(stats || {}) : '';
    const footerClass = [
        'message-footer',
        (!messageTimeHtml && !statsHtml) ? 'hidden' : '',
        (messageTimeHtml && !statsHtml) ? 'hover-time-only' : ''
    ].filter(Boolean).join(' ');

    PivotSafeHtml.setHtml(div, `
        <div class="avatar">${role === 'user' ? ICONS.user : ICONS.ai}</div>
        <div class="message-content"${id ? ` data-message-id="${id}"` : ''}>
            <div class="text-body">${displayHtml}</div>
            ${role === 'assistant' ? `
            <div class="${footerClass}">
                ${statsHtml}
                ${messageTimeHtml}
            </div>
            ` : ''}
            <div class="message-actions">
                ${role === 'user' ? messageTimeHtml : ''}
                <button class="action-btn" data-message-action="copy" title="复制">${ICONS.copy}</button>
                ${id ? `<button class="action-btn" data-message-action="fork" data-message-id="${id}" title="从这里分叉">${ICONS.fork}</button>` : ''}
                ${role === 'assistant' && id ? `<button class="action-btn" data-message-action="regenerate" data-message-id="${id}" title="重新回答"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button>` : ''}
                ${id ? `<button class="action-btn" data-message-action="delete" data-message-id="${id}" title="删除">${ICONS.delete}</button>` : ''}
            </div>
        </div>
    `);
    target.appendChild(div);
    attachMessageImageLoadPinning(div);
    if (role === 'assistant') bindThoughtStateTracking(div.querySelector('.text-body'));
    if (!deferRender) {
        if (role === 'assistant') renderPivotCharts(div);
        window.scrollMessagesToBottom?.();
    }
    return div.querySelector('.message-content');
}

function setMessageModelName(messageContent, modelName) {
    const name = String(modelName || '').trim();
    if (!messageContent || !name) return;
    let statsEl = messageContent.querySelector('.message-stats');
    if (!statsEl) {
        const footerEl = messageContent.querySelector('.message-footer');
        if (!footerEl) return;
        footerEl.classList.remove('hidden');
        footerEl.classList.remove('hover-time-only');
        statsEl = document.createElement('div');
        statsEl.className = 'message-stats';
        footerEl.insertBefore(statsEl, footerEl.querySelector('.message-meta'));
    }
    statsEl.dataset.modelName = name;
    if (statsEl.querySelector('.stat-model')) return;
    const modelItem = document.createElement('span');
    modelItem.className = 'stat-item stat-model';
    modelItem.title = `模型：${name}`;
    PivotSafeHtml.setHtml(modelItem, `${ICONS.model}${escapeCodeHtml(name)}`);
    statsEl.insertAdjacentElement('afterbegin', modelItem);
}

function setMessageActionId(messageContent, id) {
    const messageId = Number.parseInt(id, 10);
    if (!messageContent || !Number.isSafeInteger(messageId)) return;

    const message = messageContent.closest('.message');
    const role = message?.classList.contains('assistant') ? 'assistant' : 'user';
    const actions = messageContent.querySelector('.message-actions');
    const copyButton = actions?.querySelector('[data-message-action="copy"]');
    if (!actions || !copyButton) return;

    message.dataset.messageId = String(messageId);
    messageContent.dataset.messageId = String(messageId);
    actions.querySelectorAll('[data-message-id]').forEach(button => {
        button.dataset.messageId = String(messageId);
    });

    if (!actions.querySelector('[data-message-action="fork"]')) {
        const forkButton = document.createElement('button');
        forkButton.className = 'action-btn';
        forkButton.type = 'button';
        forkButton.dataset.messageAction = 'fork';
        forkButton.dataset.messageId = String(messageId);
        forkButton.title = '从这里分叉';
        PivotSafeHtml.setHtml(forkButton, ICONS.fork);
        copyButton.insertAdjacentElement('afterend', forkButton);
    }

    if (role === 'assistant' && !actions.querySelector('[data-message-action="regenerate"]')) {
        const regenerateButton = document.createElement('button');
        regenerateButton.className = 'action-btn';
        regenerateButton.type = 'button';
        regenerateButton.dataset.messageAction = 'regenerate';
        regenerateButton.dataset.messageId = String(messageId);
        regenerateButton.title = '重新回答';
        PivotSafeHtml.setHtml(regenerateButton, '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>');
        const forkButton = actions.querySelector('[data-message-action="fork"]') || copyButton;
        forkButton.insertAdjacentElement('afterend', regenerateButton);
    }

    if (!actions.querySelector('[data-message-action="delete"]')) {
        const deleteButton = document.createElement('button');
        deleteButton.className = 'action-btn';
        deleteButton.type = 'button';
        deleteButton.dataset.messageAction = 'delete';
        deleteButton.dataset.messageId = String(messageId);
        deleteButton.title = '删除';
        PivotSafeHtml.setHtml(deleteButton, ICONS.delete);
        actions.appendChild(deleteButton);
    }
}

window.setMessageActionId = setMessageActionId;

function renderAttachmentPreviews() {
    const previewArea = document.getElementById('attachment-preview');
    if (pendingAttachments.length === 0) {
        previewArea.classList.add('hidden');
        PivotSafeHtml.setHtml(previewArea, '');
        previewArea.title = '';
        previewArea.removeAttribute('aria-label');
        return;
    }
    const maxAttachments = typeof window.getMaxPendingAttachments === 'function'
        ? window.getMaxPendingAttachments()
        : (window.MAX_PENDING_ATTACHMENTS || 5);
    if (pendingAttachments.length > maxAttachments) pendingAttachments.splice(maxAttachments);
    if (typeof window.syncPendingAttachmentsGlobal === 'function') window.syncPendingAttachmentsGlobal();
    previewArea.classList.remove('hidden');
    const hasImage = pendingAttachments.some(file => typeof window.isChatImageAttachment === 'function' ? window.isChatImageAttachment(file) : String(file.type || '').startsWith('image/'));
    const imageCount = pendingAttachments.filter(file => typeof window.isChatImageAttachment === 'function' ? window.isChatImageAttachment(file) : String(file.type || '').startsWith('image/')).length;
    const fileCount = Math.max(0, pendingAttachments.length - imageCount);
    const summaryItems = [
        `附件 ${pendingAttachments.length}`,
        `图片 ${imageCount}`,
        `文件 ${fileCount}`
    ];
    if (hasImage) summaryItems.push('图片解析数量受模型上限限制');
    previewArea.title = summaryItems.join(' · ');
    previewArea.setAttribute('aria-label', previewArea.title);
    const removeButton = index => `
        <button type="button" class="remove-preview" data-remove-attachment="${index}" aria-label="移除附件" title="移除附件">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7"></path>
            </svg>
        </button>
    `;
    PivotSafeHtml.setHtml(previewArea, pendingAttachments.map((file, index) => {
        const isImage = typeof window.isChatImageAttachment === 'function' ? window.isChatImageAttachment(file) : String(file.type || '').startsWith('image/');
        const isLocal = file?.kind === 'local' || file?.status === 'local';
        const previewUrl = isLocal ? String(file.previewUrl || '') : String(file.url || '');
        const icon = isImage
            ? `<div class="file-icon file-icon-image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="1.5"></circle><path d="M21 16l-5-5-4 4-2-2-5 5"></path></svg></div>`
            : `<div class="file-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
        const badge = isLocal ? '<span class="preview-state-badge">待上传</span>' : '';
        if (isImage && previewUrl) {
            return `<div class="preview-card preview-card-local"><img src="${escapeAttrValue(previewUrl)}" alt="${escapeAttrValue(file.name)}">${badge}${removeButton(index)}</div>`;
        }
        return `<div class="preview-card file-card preview-card-local">${icon}<div class="file-main"><div class="file-name">${escapeCodeHtml(file.name)}</div>${badge}</div>${removeButton(index)}</div>`;
    }).join(''));
}

document.addEventListener('click', (event) => {
    const messageButton = event.target.closest('[data-message-action]');
    if (messageButton) {
        const action = messageButton.dataset.messageAction;
        const messageId = Number.parseInt(messageButton.dataset.messageId || '', 10);
        if (action === 'copy') window.copyMsg(messageButton);
        if (action === 'fork' && Number.isSafeInteger(messageId)) window.forkSessionFromMessage?.(messageId);
        if (action === 'regenerate' && Number.isSafeInteger(messageId)) window.regenerateMsg(messageId);
        if (action === 'delete' && Number.isSafeInteger(messageId)) window.deleteMsg(messageId, messageButton);
        return;
    }

    const removeButton = event.target.closest('[data-remove-attachment]');
    if (removeButton) {
        const index = Number.parseInt(removeButton.dataset.removeAttachment || '', 10);
        if (Number.isSafeInteger(index)) window.removeAttachment(index);
    }
});

// --- 思考块状态深度追踪 ---
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
        const state = states[index]; if (!state) return;
        wrapper.scrollTop = state.nearBottom ? wrapper.scrollHeight : state.top;
    });
}
function bindThoughtStateTracking(root) {
    if (!root || root.dataset.thoughtTrackingBound === '1') return;
    root.dataset.thoughtTrackingBound = '1'; root._thoughtOpenStates = []; root._thoughtScrollStates = [];
    root.addEventListener('click', (event) => {
        const summary = event.target.closest('.thought-summary'); if (!summary) return;
        const block = summary.closest('.thought-block'); if (!block) return;
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
function rememberThoughtStateBeforeRender(root) {
    if (!root) return { openStates: [], scrollStates: [] };
    const openStates = getThoughtOpenStates(root);
    const scrollStates = getThoughtScrollStates(root);
    root._thoughtOpenStates = openStates; root._thoughtScrollStates = scrollStates;
    return { openStates, scrollStates };
}
function restoreThoughtStateAfterRender(root, state) {
    if (!root || !state) return;
    root._thoughtOpenStates = state.openStates || [];
    root._thoughtScrollStates = state.scrollStates || [];
    restoreThoughtScrollStates(root, root._thoughtScrollStates);
}

// --- 代码块复制功能实现 ---
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;

    const codeBlock = btn.closest('.code-block');
    const code = codeBlock ? codeBlock.querySelector('code')?.innerText : '';
    if (!code) return;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(code);
        } else {
            // 回退方案：使用隐藏 textarea
            const textArea = document.createElement("textarea");
            textArea.value = code;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const success = document.execCommand('copy');
            textArea.remove();
            if (!success) throw new Error('execCommand copy failed');
        }

        if (window.showToast) showToast('代码已复制到剪贴板');

        // 按钮文字反馈
        const span = btn.querySelector('span');
        if (span) {
            const oldText = span.innerText;
            span.innerText = '已复制';
            btn.classList.add('copied');
            setTimeout(() => {
                span.innerText = oldText;
                btn.classList.remove('copied');
            }, 2000);
        }
    } catch (err) {
        console.error('复制失败:', err);
        if (window.showToast) showToast('复制失败，请手动选择复制', 'error');
    }
});

