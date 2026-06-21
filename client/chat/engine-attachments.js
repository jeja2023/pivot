// 聊天附件上传与待发送附件状态 Chat attachment upload and pending attachment state
let pendingAttachments = [];
const DEFAULT_MAX_PENDING_ATTACHMENTS = 5;
let maxPendingAttachments = Number.parseInt(window.MAX_PENDING_ATTACHMENTS, 10);
if (!Number.isFinite(maxPendingAttachments) || maxPendingAttachments <= 0) {
    maxPendingAttachments = DEFAULT_MAX_PENDING_ATTACHMENTS;
}
let pendingAttachmentCounter = 0;
window.MAX_PENDING_ATTACHMENTS = maxPendingAttachments;
window.pendingAttachments = pendingAttachments;

function syncPendingAttachmentsGlobal() {
    window.pendingAttachments = pendingAttachments;
}

function normalizeMaxPendingAttachments(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PENDING_ATTACHMENTS;
}

function getMaxPendingAttachments() {
    const configured = normalizeMaxPendingAttachments(window.MAX_PENDING_ATTACHMENTS);
    maxPendingAttachments = configured;
    window.MAX_PENDING_ATTACHMENTS = configured;
    return configured;
}

function setMaxPendingAttachments(value) {
    maxPendingAttachments = normalizeMaxPendingAttachments(value);
    window.MAX_PENDING_ATTACHMENTS = maxPendingAttachments;
    renderAttachmentPreviews?.();
    return maxPendingAttachments;
}

function revokeAttachmentPreview(item = {}) {
    const previewUrl = String(item.previewUrl || '');
    if (!previewUrl.startsWith('blob:')) return;
    try {
        URL.revokeObjectURL(previewUrl);
    } catch (e) {}
}

function createLocalAttachment(file, sessionId = currentSessionId || '') {
    return {
        id: `local-${Date.now()}-${++pendingAttachmentCounter}`,
        kind: 'local',
        status: 'local',
        name: file.name,
        url: '',
        type: String(file.type || ''),
        size: file.size || 0,
        file,
        previewUrl: URL.createObjectURL(file),
        sessionId: String(sessionId || ''),
        extractedText: '',
        markdown: ''
    };
}

function createUploadedAttachmentRecord(sourceItem, data, sessionId) {
    const name = data?.name || sourceItem?.name || '附件';
    const url = data?.url || '';
    const type = data?.type || sourceItem?.type || '';
    return {
        id: sourceItem?.id || `uploaded-${Date.now()}-${++pendingAttachmentCounter}`,
        kind: 'uploaded',
        status: 'uploaded',
        name,
        url,
        type,
        size: sourceItem?.size || 0,
        sessionId: data?.sessionId || sessionId || sourceItem?.sessionId || '',
        extractedText: data?.extractedText || '',
        markdown: buildAttachmentMarkdown(name, url, isChatImageAttachment({ name, url, type }))
    };
}

function createUploadedVisionAttachmentRecord(item, sessionId, fallbackSessionId = '') {
    const name = item?.name || '图片';
    const url = item?.url || '';
    const type = item?.type || 'image/png';
    return {
        id: `vision-${Date.now()}-${++pendingAttachmentCounter}`,
        kind: 'uploaded',
        status: 'uploaded',
        name,
        url,
        type,
        size: 0,
        sessionId: item?.sessionId || sessionId || fallbackSessionId || '',
        extractedText: '',
        markdown: item?.markdown || buildAttachmentMarkdown(name, url, true)
    };
}

async function uploadChatFile(file, uploadSessionId, password = '', onProgress = null) {
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
}

async function uploadPendingAttachmentItem(item, uploadSessionId) {
    const uploadOnce = async (password = '') => {
        const progress = createUploadProgress(item.name);
        try {
            return await uploadChatFile(item.file, uploadSessionId, password, percent => progress.update(percent));
        } finally {
            progress.close();
        }
    };

    let data;
    try {
        data = await uploadOnce('');
    } catch (uploadErr) {
        if (uploadErr.data?.passwordRequired) {
            const password = await window.showInputPrompt({
                title: '文档密码',
                message: `文档 ${item.name} 已加密，请输入文档密码。`,
                type: 'password',
                placeholder: '文档密码',
                autocomplete: 'off',
                trim: false
            });
            if (!password) return { aborted: true };
            data = await uploadOnce(password);
        } else {
            throw uploadErr;
        }
    }

    const uploadedItem = createUploadedAttachmentRecord(item, data, uploadSessionId);
    const extraItems = [];
    (data.visionAttachments || []).forEach(visionItem => {
        extraItems.push(createUploadedVisionAttachmentRecord(visionItem, data.sessionId || uploadSessionId, uploadSessionId));
    });
    return { uploadedItem, extraItems };
}

async function preparePendingAttachmentsForSend(uploadSessionId) {
    const sessionId = String(uploadSessionId || '').trim();
    if (!sessionId) throw new Error('缺少会话 ID，请先创建或选择会话');

    const maxAttachments = getMaxPendingAttachments();
    let uploadedCount = 0;
    let skippedCount = 0;

    for (let index = 0; index < pendingAttachments.length; index += 1) {
        if (String(currentSessionId || '') !== sessionId) {
            throw new Error('会话已切换，附件无法继续发送');
        }
        const item = pendingAttachments[index];
        if (!item || item.kind === 'uploaded' || !item.file) continue;

        const result = await uploadPendingAttachmentItem(item, sessionId);
        if (result.aborted) return { aborted: true, uploadedCount, skippedCount };

        revokeAttachmentPreview(item);
        pendingAttachments[index] = result.uploadedItem;
        uploadedCount += 1;

        if (result.extraItems.length > 0) {
            const slotsLeft = Math.max(0, maxAttachments - pendingAttachments.length);
            const extras = result.extraItems.slice(0, slotsLeft);
            skippedCount += result.extraItems.length - extras.length;
            if (extras.length > 0) {
                pendingAttachments.splice(index + 1, 0, ...extras);
                index += extras.length;
            }
        }

        syncPendingAttachmentsGlobal();
        renderAttachmentPreviews();
    }

    if (pendingAttachments.length > maxAttachments) {
        const overflow = pendingAttachments.splice(maxAttachments);
        overflow.forEach(revokeAttachmentPreview);
        skippedCount += overflow.length;
        syncPendingAttachmentsGlobal();
        renderAttachmentPreviews();
    }

    return { uploadedCount, skippedCount };
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
    pendingAttachments.forEach(revokeAttachmentPreview);
    pendingAttachments = [];
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews?.();
    if (message) showToast(message, 'info');
}

window.isChatImageAttachment = isChatImageAttachment;
window.getMaxPendingAttachments = getMaxPendingAttachments;
window.setMaxPendingAttachments = setMaxPendingAttachments;
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
    const maxAttachments = getMaxPendingAttachments();
    if (pendingAttachments.length >= maxAttachments) {
        showToast(`最多只能添加 ${maxAttachments} 个附件`, 'error');
        e.target.value = '';
        return;
    }
    const availableSlots = Math.max(0, maxAttachments - pendingAttachments.length);
    const acceptedFiles = files.slice(0, availableSlots);
    const skippedCount = files.length - acceptedFiles.length;
    acceptedFiles.forEach(file => {
        pendingAttachments.push(createLocalAttachment(file, currentSessionId || ''));
    });
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();
    if (skippedCount > 0) {
        showToast(`已添加 ${acceptedFiles.length} 个附件，跳过 ${skippedCount} 个`, 'info');
    }
    e.target.value = '';
});

window.removeAttachment = (index) => {
    revokeAttachmentPreview(pendingAttachments[index]);
    pendingAttachments.splice(index, 1);
    syncPendingAttachmentsGlobal();
    renderAttachmentPreviews();
};
