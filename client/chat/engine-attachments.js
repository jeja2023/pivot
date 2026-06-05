// 聊天附件上传与待发送附件状态 Chat attachment upload and pending attachment state
let pendingAttachments = [];
const MAX_PENDING_ATTACHMENTS = 5;
window.MAX_PENDING_ATTACHMENTS = MAX_PENDING_ATTACHMENTS;
window.pendingAttachments = pendingAttachments;

function syncPendingAttachmentsGlobal() {
    window.pendingAttachments = pendingAttachments;
}

function isChatImageAttachment(item = {}) {
    const type = String(item.type || '').toLowerCase();
    const nameOrUrl = String(item.name || item.url || '').split(/[?#]/)[0];
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(nameOrUrl);
}

function escapeAttachmentMarkdownLabel(value) {
    return String(value || '附件').replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&').trim() || '附件';
}

function buildAttachmentMarkdown(name, url, isImage) {
    const label = escapeAttachmentMarkdownLabel(name);
    return isImage ? `![${label}](${url})` : `[附件: ${label}](${url})`;
}

function getUploadSessionIdFromUrl(url = '') {
    const cleanUrl = String(url || '').split(/[?#]/)[0];
    let decoded = cleanUrl;
    try {
        decoded = decodeURIComponent(cleanUrl);
    } catch (e) {
        return '';
    }
    const parts = decoded.split('/');
    return parts[1] === 'uploads' ? parts[3] || '' : '';
}

function attachmentBelongsToSession(attachment, sessionId) {
    const expected = String(sessionId || '');
    if (!expected) return true;
    const explicitSession = String(attachment?.sessionId || '');
    if (explicitSession) return explicitSession === expected;
    const urlSession = getUploadSessionIdFromUrl(attachment?.url);
    return !urlSession || urlSession === expected;
}

function clearPendingAttachments(message = '') {
    if (pendingAttachments.length === 0) return;
    pendingAttachments = [];
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews?.();
    if (message) showToast(message, 'info');
}

window.isChatImageAttachment = isChatImageAttachment;
window.syncPendingAttachmentsGlobal = syncPendingAttachmentsGlobal;

function createUploadProgress(label) {
    const area = document.getElementById('attachment-preview');
    if (!area) return { update() {}, close() {} };
    area.classList.remove('hidden');

    const card = document.createElement('div');
    card.className = 'upload-progress-card';
    card.innerHTML = `
        <div class="upload-progress-ring" style="--progress:0">
            <span>0%</span>
        </div>
        <div class="upload-progress-name">${escapeChatStatusHtml(label)}</div>
    `;
    area.prepend(card);

    return {
        update(percent) {
            const clamped = Math.max(0, Math.min(100, Math.round(percent)));
            card.querySelector('.upload-progress-ring')?.style.setProperty('--progress', clamped);
            const text = card.querySelector('.upload-progress-ring span');
            if (text) text.textContent = `${clamped}%`;
        },
        close() {
            card.remove();
            if (pendingAttachments.length === 0) renderAttachmentPreviews();
        }
    };
}

document.getElementById('file-input').addEventListener('change', async (e) => {
    const modelId = document.getElementById('model-selector').value;
    const model = (window._cachedModels || []).find(m => String(m.id) === String(modelId));
    if (!model || Number(model.supports_vision || 0) !== 1) {
        showToast('当前选中的模型不具备视觉或文档分析能力，无法上传附件', 'error');
        e.target.value = '';
        return;
    }

    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const maxAttachments = window.MAX_PENDING_ATTACHMENTS || 5;
    if (pendingAttachments.length >= maxAttachments) {
        showToast(`最多只能上传 ${maxAttachments} 个附件`, 'error');
        e.target.value = '';
        return;
    }
    if (!currentSessionId) {
        const s = await createSession('新对话');
        if (!s) return;
        currentSessionId = s.id;
        document.getElementById('current-title').innerText = s.title;
        window.loadSessions();
    }
    const batchSessionId = String(currentSessionId || '');
    const uploadChatFile = async (file, uploadSessionId, password = '', onProgress = null) => {
        const fd = new FormData();
        fd.append('file', file);
        if (password) fd.append('password', password);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/upload?sessionId=${encodeURIComponent(uploadSessionId)}`);
            Object.entries(authHeaders()).forEach(([key, value]) => xhr.setRequestHeader(key, value));
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable && typeof onProgress === 'function') {
                    onProgress((event.loaded / event.total) * 100);
                }
            };
            xhr.onload = () => {
                let data = {};
                try {
                    data = JSON.parse(xhr.responseText || '{}');
                } catch (e) {
                    data = { error: xhr.responseText || 'Upload failed' };
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(data);
                    return;
                }
                const err = new Error(data.error || `Upload failed (${xhr.status})`);
                err.data = data;
                reject(err);
            };
            xhr.onerror = () => reject(new Error('上传连接失败'));
            xhr.send(fd);
        });
    };
    try {
        let uploadedCount = 0;
        let skippedCount = 0;
        let sessionSwitchedDuringUpload = false;
        showToast(files.length > 1 ? `正在上传 ${files.length} 个文件...` : '正在上传...', 'info');
        for (const file of files) {
            const uploadSessionId = batchSessionId;
            if (String(currentSessionId || '') !== uploadSessionId) {
                skippedCount += 1;
                sessionSwitchedDuringUpload = true;
                continue;
            }
            if (pendingAttachments.length >= maxAttachments) {
                skippedCount += 1;
                continue;
            }
            const selectedIsImage = isChatImageAttachment(file);
            const hasPendingImage = pendingAttachments.some(item => isChatImageAttachment(item));
            if (selectedIsImage && hasPendingImage) {
                skippedCount += 1;
                continue;
            }

            let data;
            const progress = createUploadProgress(file.name);
            try {
                data = await uploadChatFile(file, uploadSessionId, '', percent => progress.update(percent));
            } catch (uploadErr) {
                if (uploadErr.data?.passwordRequired) {
                    progress.close();
                    const password = await window.showInputPrompt({
                        title: '文档密码',
                        message: `文档 ${file.name} 已加密，请输入文档密码。`,
                        type: 'password',
                        placeholder: '文档密码',
                        autocomplete: 'off',
                        trim: false
                    });
                    if (!password) {
                        skippedCount += 1;
                        continue;
                    }
                    const retryProgress = createUploadProgress(file.name);
                    data = await uploadChatFile(file, uploadSessionId, password, percent => retryProgress.update(percent));
                    retryProgress.close();
                } else {
                    progress.close();
                    throw uploadErr;
                }
            }
            progress.close();

            if (data.url) {
                if (String(currentSessionId || '') !== uploadSessionId || String(data.sessionId || uploadSessionId) !== uploadSessionId) {
                    skippedCount += 1;
                    sessionSwitchedDuringUpload = true;
                    continue;
                }
                const attachmentType = data.type || (selectedIsImage ? 'image/jpeg' : file.type);
                pendingAttachments.push({
                    name: data.name,
                    url: data.url,
                    type: attachmentType,
                    sessionId: data.sessionId || uploadSessionId,
                    extractedText: data.extractedText,
                    markdown: buildAttachmentMarkdown(data.name, data.url, isChatImageAttachment({ name: data.name, url: data.url, type: attachmentType }))
                });
                uploadedCount += 1;
                (data.visionAttachments || []).forEach(item => {
                    if (pendingAttachments.length >= maxAttachments) return;
                    if (pendingAttachments.some(entry => isChatImageAttachment(entry))) return;
                    pendingAttachments.push({
                        name: item.name,
                        url: item.url,
                        type: item.type || 'image/png',
                        sessionId: item.sessionId || data.sessionId || currentSessionId,
                        extractedText: '',
                        markdown: item.markdown || buildAttachmentMarkdown(item.name, item.url, true)
                    });
                });
                syncPendingAttachmentsGlobal();
                renderAttachmentPreviews();
            }
        }
        if (sessionSwitchedDuringUpload) showToast('会话已切换，刚上传的附件不会加入当前输入框', 'info');
        if (uploadedCount > 0) showToast(skippedCount > 0 ? `已上传 ${uploadedCount} 个，跳过 ${skippedCount} 个` : '上传成功');
        else if (skippedCount > 0) showToast('没有可上传的文件：最多 5 个附件，且图片每次仅 1 张', 'error');
    } catch (e) { showToast(e.message || '上传失败', 'error'); }
    e.target.value = '';
});

window.removeAttachment = (index) => {
    pendingAttachments.splice(index, 1);
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();
};
