/* 附件预览 */
const ATTACHMENT_TEXT_LIMIT = 12000;

const escapePreviewHtml = (value) => window.PivotSafeHtml
    ? window.PivotSafeHtml.escapeHtml(value)
    : String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function guessAttachmentKind(url = '', mimeType = '') {
    const lowerUrl = String(url || '').toLowerCase().split('?')[0];
    const lowerMime = String(mimeType || '').toLowerCase();
    if (lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(lowerUrl)) return 'image';
    if (lowerMime === 'application/pdf' || /\.pdf$/i.test(lowerUrl)) return 'pdf';
    if (lowerMime.startsWith('text/') || /\.(txt|md|csv|json|log|xml|yaml|yml|html?)$/i.test(lowerUrl)) return 'text';
    return 'other';
}

function setAttachmentPreviewMeta(modal, title, url, kind, mimeType) {
    const titleEl = modal.querySelector('#attachment-preview-title');
    const metaEl = modal.querySelector('#attachment-preview-meta');
    const openLink = modal.querySelector('#attachment-preview-open');
    if (titleEl) titleEl.textContent = title || '\u9644\u4ef6\u9884\u89c8';
    if (metaEl) {
        metaEl.textContent = [
            kind === 'image' ? '\u56fe\u7247' : kind === 'pdf' ? 'PDF' : kind === 'text' ? '\u6587\u672c' : '\u6587\u4ef6',
            mimeType || ''
        ].filter(Boolean).join(' / ');
    }
    if (openLink) {
        openLink.href = url || '#';
        openLink.classList.toggle('hidden', !url);
    }
}

function renderAttachmentPreviewLoading(content, label = '\u6b63\u5728\u52a0\u8f7d\u9884\u89c8...') {
    PivotSafeHtml.setHtml(content, `<div class="attachment-preview-empty">${escapePreviewHtml(label)}</div>`);
}

async function renderAttachmentTextPreview(content, url) {
    renderAttachmentPreviewLoading(content);
    const response = await apiFetch(url, {
        headers: typeof authHeaders === 'function' ? authHeaders() : {}
    });
    if (!response.ok) throw new Error(`预览失败 (${response.status})`);
    const text = (await response.text()).slice(0, ATTACHMENT_TEXT_LIMIT);
    PivotSafeHtml.setHtml(content, `<pre class="attachment-preview-text">${escapePreviewHtml(text)}</pre>`);
}

async function renderAttachmentPreview(content, url, kind) {
    if (kind === 'image') {
        PivotSafeHtml.setHtml(content, `<img class="attachment-preview-image" src="${escapePreviewHtml(url)}" alt="Attachment preview">`);
        return;
    }
    if (kind === 'pdf') {
        PivotSafeHtml.setHtml(content, `<iframe class="attachment-preview-frame" src="${escapePreviewHtml(url)}" title="Attachment preview" loading="lazy"></iframe>`);
        return;
    }
    if (kind === 'text') {
        await renderAttachmentTextPreview(content, url);
        return;
    }
    PivotSafeHtml.setHtml(content, `
        <div class="attachment-preview-empty">
            <div>\u6682\u4e0d\u652f\u6301\u5728\u7ebf\u9884\u89c8\u8be5\u6587\u4ef6\u7c7b\u578b\u3002</div>
            <div><a href="${escapePreviewHtml(url)}" target="_blank" rel="noopener noreferrer">\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00</a></div>
        </div>
    `);
}

const openAttachmentPreview = async function(url, title = '', mimeType = '') {
    const modal = document.getElementById('attachment-preview-modal');
    const content = document.getElementById('attachment-preview-content');
    if (!modal || !content || !url) return;
    const kind = guessAttachmentKind(url, mimeType);
    setAttachmentPreviewMeta(modal, title, url, kind, mimeType);
    modal.classList.remove('hidden');
    renderAttachmentPreviewLoading(content);
    try {
        await renderAttachmentPreview(content, url, kind);
    } catch (e) {
        PivotSafeHtml.setHtml(content, `
            <div class="attachment-preview-empty">
                <div>\u9884\u89c8\u5931\u8d25\uff1a${escapePreviewHtml(e.message || 'unknown error')}</div>
                <div><a href="${escapePreviewHtml(url)}" target="_blank" rel="noopener noreferrer">\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00</a></div>
            </div>
        `);
    }
};

const closeAttachmentPreview = function() {
    const modal = document.getElementById('attachment-preview-modal');
    const content = document.getElementById('attachment-preview-content');
    if (modal) modal.classList.add('hidden');
    if (content) PivotSafeHtml.setHtml(content, '');
};

document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-attachment-preview]');
    if (!trigger) return;
    const url = trigger.dataset.attachmentUrl || trigger.getAttribute('href') || '';
    if (!url) return;
    event.preventDefault();
    openAttachmentPreview(
        url,
        trigger.dataset.attachmentName || trigger.textContent || '',
        trigger.dataset.attachmentType || ''
    );
});

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('attachment-preview-close')?.addEventListener('click', closeAttachmentPreview);
    document.getElementById('attachment-preview-modal')?.addEventListener('click', (event) => {
        if (event.target.id === 'attachment-preview-modal') closeAttachmentPreview();
    });
});

Pivot.exposeModule('attachmentPreview', {
    openAttachmentPreview,
    closeAttachmentPreview
}, ['openAttachmentPreview', 'closeAttachmentPreview']);
