/* global DocsAPI, apiFetch, authHeaders, PivotSafeHtml */
/* 附件预览 */
const ATTACHMENT_TEXT_LIMIT = 12000;
let activeAttachmentOfficeEditor = null;

const escapePreviewHtml = (value) => window.Pivot.legacy.PivotSafeHtml
    ? window.Pivot.legacy.PivotSafeHtml.escapeHtml(value)
    : String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let currentAttachmentUrl = '';
let currentAttachmentName = '';

function guessAttachmentKind(url = '', mimeType = '', filename = '') {
    const lowerUrl = String(url || '').toLowerCase().split('?')[0];
    const lowerMime = String(mimeType || '').toLowerCase();
    const lowerName = String(filename || '').toLowerCase().split('?')[0];
    const target = lowerName || lowerUrl;

    if (lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(target) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(lowerUrl)) return 'image';
    if (lowerMime === 'application/pdf' || lowerMime.includes('pdf') || /\.pdf$/i.test(target) || /\.pdf$/i.test(lowerUrl)) return 'pdf';
    if (/\.(docx?|rtf)$/i.test(target) || /\.docx?$/i.test(lowerUrl) || lowerMime.includes('word') || lowerMime === 'application/msword' || lowerMime.includes('officedocument.wordprocessingml')) return 'word';
    if (/\.(xlsx?|ods)$/i.test(target) || /\.xlsx?$/i.test(lowerUrl) || lowerMime.includes('excel') || lowerMime.includes('spreadsheet') || lowerMime.includes('officedocument.spreadsheetml')) return 'excel';
    if (/\.(pptx?|odp)$/i.test(target) || /\.pptx?$/i.test(lowerUrl) || lowerMime.includes('powerpoint') || lowerMime.includes('presentation')) return 'slide';
    if (lowerMime.startsWith('text/') || /\.(txt|md|csv|json|log|xml|yaml|yml|html?)$/i.test(target) || /\.(txt|md|csv|json|log|xml|yaml|yml|html?)$/i.test(lowerUrl)) return 'text';
    return 'other';
}

function setAttachmentPreviewMeta(modal, title, url, kind, mimeType) {
    currentAttachmentUrl = url || '';
    currentAttachmentName = title || '';
    const titleEl = modal.querySelector('#attachment-preview-title');
    const metaEl = modal.querySelector('#attachment-preview-meta');
    const downloadBtn = modal.querySelector('#attachment-preview-download') || modal.querySelector('#attachment-preview-open');
    if (titleEl) titleEl.textContent = title || '附件预览';
    if (metaEl) {
        const kindLabel = kind === 'image' ? '图片'
            : kind === 'pdf' ? 'PDF'
            : kind === 'word' ? 'Word 文档'
            : kind === 'excel' ? 'Excel 电子表格'
            : kind === 'slide' ? 'PPT 幻灯片'
            : kind === 'text' ? '文本'
            : '文件';
        metaEl.textContent = [kindLabel, mimeType || ''].filter(Boolean).join(' / ');
    }
    if (downloadBtn) {
        downloadBtn.title = `下载附件：${title || '文件'}`;
        downloadBtn.classList.toggle('hidden', !url);
    }
}

async function downloadCurrentAttachment() {
    if (!currentAttachmentUrl) return;
    const filename = currentAttachmentName || 'attachment';
    try {
        const response = await apiFetch(currentAttachmentUrl, {
            headers: typeof authHeaders === 'function' ? authHeaders() : {}
        });
        if (!response.ok) throw new Error(`下载失败 (${response.status})`);
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1500);
    } catch (_) {
        const a = document.createElement('a');
        a.href = currentAttachmentUrl;
        a.download = filename;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}

function renderAttachmentPreviewLoading(content, label = '正在加载预览...') {
    PivotSafeHtml.setHtml(content, `<div class="attachment-preview-empty">${escapePreviewHtml(label)}</div>`);
}

function resolveDocsApi() {
    return typeof DocsAPI !== 'undefined' ? DocsAPI : null;
}

async function renderAttachmentOfficePreview(content, config) {
    if (!/^\/[A-Za-z0-9_-]+\/web-apps\/apps\/api\/documents\/api\.js$/.test(String(config.scriptUrl || ''))) {
        throw new Error('文档服务地址无效。');
    }
    let docsApi = resolveDocsApi();
    if (!docsApi?.DocEditor) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = config.scriptUrl;
            script.onload = resolve;
            script.onerror = () => { script.remove(); reject(new Error('文档服务无法连接，请检查文档预览配置。')); };
            document.head.appendChild(script);
        });
        docsApi = resolveDocsApi();
    }
    if (!docsApi?.DocEditor) throw new Error('文档服务初始化失败。');
    const host = document.createElement('div');
    host.className = 'attachment-preview-office';
    host.id = 'attachment-office-preview-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    content.replaceChildren(host);
    const editor = new docsApi.DocEditor(host.id, config.editor);
    activeAttachmentOfficeEditor = editor;
}

function renderAttachmentExcelPreview(content, excelData) {
    const { sheets = [] } = excelData || {};
    if (!sheets.length) {
        PivotSafeHtml.setHtml(content, '<div class="attachment-preview-empty">工作簿中没有数据。</div>');
        return;
    }
    const container = document.createElement('div');
    container.className = 'attachment-excel-container';

    const tabsBar = document.createElement('div');
    tabsBar.className = 'attachment-excel-tabs';

    const sheetContainer = document.createElement('div');
    sheetContainer.className = 'attachment-excel-sheet-wrapper';

    function showSheet(index) {
        tabsBar.querySelectorAll('.attachment-excel-tab').forEach((tab, i) => {
            tab.classList.toggle('is-active', i === index);
        });
        const currentSheet = sheets[index];
        if (!currentSheet || !currentSheet.rows || !currentSheet.rows.length) {
            PivotSafeHtml.setHtml(sheetContainer, '<div class="attachment-preview-empty">该工作表为空</div>');
            return;
        }
        const rowsHtml = currentSheet.rows.map((row, rIdx) => {
            const isHeader = rIdx === 0;
            const cells = row.map(cell => {
                const tag = isHeader ? 'th' : 'td';
                return `<${tag}>${escapePreviewHtml(cell)}</${tag}>`;
            }).join('');
            return `<tr><td class="excel-row-num">${rIdx + 1}</td>${cells}</tr>`;
        }).join('');

        const tableHtml = `
            <table class="attachment-excel-table">
                <tbody>${rowsHtml}</tbody>
            </table>
            ${currentSheet.isTruncated ? `<div class="attachment-excel-truncated-hint">仅展示前 ${currentSheet.rows.length} 行数据</div>` : ''}
        `;
        PivotSafeHtml.setHtml(sheetContainer, tableHtml);
    }

    sheets.forEach((sheet, idx) => {
        const tabBtn = document.createElement('button');
        tabBtn.type = 'button';
        tabBtn.className = 'attachment-excel-tab' + (idx === 0 ? ' is-active' : '');
        tabBtn.textContent = sheet.name || `Sheet${idx + 1}`;
        tabBtn.addEventListener('click', () => showSheet(idx));
        tabsBar.appendChild(tabBtn);
    });

    container.appendChild(tabsBar);
    container.appendChild(sheetContainer);
    content.replaceChildren(container);
    showSheet(0);
}

async function renderOfficeOrDocPreview(content, url) {
    renderAttachmentPreviewLoading(content, '正在准备文档预览…');
    const response = await apiFetch('/api/attachments/preview-config', {
        method: 'POST',
        headers: typeof authHeaders === 'function' ? authHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '获取文档预览配置失败。');

    if (data.mode === 'onlyoffice' && data.onlyoffice) {
        await renderAttachmentOfficePreview(content, data.onlyoffice);
        return;
    }
    if (data.mode === 'excel' && data.excel) {
        renderAttachmentExcelPreview(content, data.excel);
        return;
    }
    if ((data.mode === 'doc' || data.mode === 'html') && typeof data.html === 'string') {
        const frame = document.createElement('iframe');
        frame.className = 'attachment-preview-frame';
        frame.title = '文档预览';
        frame.setAttribute('sandbox', '');
        content.replaceChildren(frame);
        PivotSafeHtml.setSrcdoc(frame, data.html);
        return;
    }
    if (data.mode === 'text' && typeof data.text === 'string') {
        const hasNotice = data.notice && !/onlyoffice/i.test(data.notice);
        const isDocFormat = ['docx', 'doc', 'word'].includes(data.format);
        if (isDocFormat) {
            PivotSafeHtml.setHtml(content, `
                <div class="attachment-preview-doc-wrapper">
                    ${hasNotice ? `<div class="attachment-preview-notice">${escapePreviewHtml(data.notice)}</div>` : ''}
                    <div class="attachment-preview-doc-sheet">
                        <pre class="attachment-preview-doc-text">${escapePreviewHtml(data.text)}</pre>
                    </div>
                </div>
            `);
            return;
        }
        PivotSafeHtml.setHtml(content, `
            <div class="attachment-preview-text-wrapper">
                ${hasNotice ? `<div class="attachment-preview-notice">${escapePreviewHtml(data.notice)}</div>` : ''}
                <pre class="attachment-preview-text">${escapePreviewHtml(data.text)}</pre>
            </div>
        `);
        return;
    }

    PivotSafeHtml.setHtml(content, `
        <div class="attachment-preview-empty">
            <div>暂不支持在线预览该文件类型。</div>
            <div><a href="${escapePreviewHtml(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开</a></div>
        </div>
    `);
}

function renderAttachmentPdfPreview(content, url, title = 'PDF 预览') {
    const frame = document.createElement('iframe');
    frame.className = 'attachment-preview-frame';
    frame.title = title || 'PDF 预览';
    frame.src = url;
    content.replaceChildren(frame);
}

async function renderAttachmentTextPreview(content, url, name = '') {
    renderAttachmentPreviewLoading(content);
    const response = await apiFetch(url, {
        headers: typeof authHeaders === 'function' ? authHeaders() : {}
    });
    if (!response.ok) throw new Error(`预览失败 (${response.status})`);
    const text = (await response.text()).slice(0, ATTACHMENT_TEXT_LIMIT);
    const isMarkdown = /\.(md|markdown)$/i.test(name || url);
    if (isMarkdown && typeof marked !== 'undefined') {
        const rawHtml = marked.parse(text);
        PivotSafeHtml.setHtml(content, `
            <div class="attachment-preview-text-wrapper">
                <div class="attachment-preview-text attachment-preview-markdown markdown-body">${rawHtml}</div>
            </div>
        `);
        return;
    }
    PivotSafeHtml.setHtml(content, `
        <div class="attachment-preview-text-wrapper">
            <pre class="attachment-preview-text">${escapePreviewHtml(text)}</pre>
        </div>
    `);
}

async function renderAttachmentPreview(content, url, kind, title = '') {
    if (kind === 'image') {
        PivotSafeHtml.setHtml(content, `<img class="attachment-preview-image" src="${escapePreviewHtml(url)}" alt="Attachment preview">`);
        return;
    }
    if (kind === 'pdf') {
        renderAttachmentPdfPreview(content, url, title);
        return;
    }
    if (['word', 'excel', 'slide'].includes(kind)) {
        await renderOfficeOrDocPreview(content, url);
        return;
    }
    if (kind === 'text') {
        await renderAttachmentTextPreview(content, url, title);
        return;
    }
    PivotSafeHtml.setHtml(content, `
        <div class="attachment-preview-empty">
            <div>暂不支持在线预览该文件类型。</div>
            <div><a href="${escapePreviewHtml(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开</a></div>
        </div>
    `);
}

const openAttachmentPreview = async function(url, title = '', mimeType = '') {
    const modal = document.getElementById('attachment-preview-modal');
    const content = document.getElementById('attachment-preview-content');
    if (!modal || !content || !url) return;
    const kind = guessAttachmentKind(url, mimeType, title);
    setAttachmentPreviewMeta(modal, title, url, kind, mimeType);
    modal.classList.remove('hidden');
    renderAttachmentPreviewLoading(content);
    try {
        await renderAttachmentPreview(content, url, kind, title);
    } catch (e) {
        PivotSafeHtml.setHtml(content, `
            <div class="attachment-preview-empty">
                <div>预览失败：${escapePreviewHtml(e.message || 'unknown error')}</div>
                <div><a href="${escapePreviewHtml(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开</a></div>
            </div>
        `);
    }
};

const closeAttachmentPreview = function() {
    if (activeAttachmentOfficeEditor) {
        try { activeAttachmentOfficeEditor.destroyEditor?.(); } catch (_) {}
        activeAttachmentOfficeEditor = null;
    }
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

function bindAttachmentPreviewEvents() {
    document.getElementById('attachment-preview-close')?.addEventListener('click', closeAttachmentPreview);
    document.getElementById('attachment-preview-download')?.addEventListener('click', downloadCurrentAttachment);
    document.getElementById('attachment-preview-open')?.addEventListener('click', (event) => {
        event.preventDefault();
        downloadCurrentAttachment();
    });
    document.getElementById('attachment-preview-modal')?.addEventListener('click', (event) => {
        if (event.target.id === 'attachment-preview-modal') closeAttachmentPreview();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAttachmentPreviewEvents);
} else {
    bindAttachmentPreviewEvents();
}

Pivot.exposeModule('attachmentPreview', {
    openAttachmentPreview,
    closeAttachmentPreview,
    downloadCurrentAttachment
}, ['openAttachmentPreview', 'closeAttachmentPreview', 'downloadCurrentAttachment']);
