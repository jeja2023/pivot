/* Agent workflow result presentation renderers. */
/* global agentEscape, agentEscapeAttr */

function agentWorkflowEmbeddedPageMarkup(page = {}) {
    const rawUrl = String(page.url || '').trim();
    const safeUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(rawUrl) ? rawUrl : '';
    if (!safeUrl) return '<div class="agent-result-empty">页面地址不可用或已被安全策略拦截。</div>';
    const title = String(page.title || '嵌入页面').trim() || '嵌入页面';
    const requestedHeight = Number(page.height);
    const height = Math.max(180, Math.min(Number.isFinite(requestedHeight) ? requestedHeight : 480, 1200));
    return `
        <div class="agent-workflow-output-embed">
            <div class="agent-workflow-output-embed-head">
                <strong>${agentEscape(title)}</strong>
                <a class="btn-secondary" href="${agentEscapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
            </div>
            <iframe class="agent-workflow-output-embed-frame" src="${agentEscapeAttr(safeUrl)}" title="${agentEscapeAttr(title)}" height="${height}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts"></iframe>
        </div>
    `;
}

function agentWorkflowEmbeddedImageMarkup(image = {}) {
    const rawUrl = String(image.url || '').trim();
    const safeUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(rawUrl) ? rawUrl : '';
    if (!safeUrl) return '<div class="agent-result-empty">图片地址不可用或已被安全策略拦截。</div>';
    const alt = String(image.alt || '工作流图片').trim() || '工作流图片';
    const maxWidth = Math.max(160, Math.min(Number(image.maxWidth) || 960, 1600));
    const maxHeight = Math.max(120, Math.min(Number(image.maxHeight) || 640, 1200));
    return `<figure class="agent-workflow-output-media agent-workflow-output-image"><img src="${agentEscapeAttr(safeUrl)}" alt="${agentEscapeAttr(alt)}" loading="lazy" referrerpolicy="no-referrer" style="max-width:${maxWidth}px;max-height:${maxHeight}px"><figcaption>${agentEscape(alt)}</figcaption></figure>`;
}

function agentWorkflowEmbeddedVideoMarkup(video = {}) {
    const rawUrl = String(video.url || '').trim();
    const safeUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(rawUrl) ? rawUrl : '';
    if (!safeUrl) return '<div class="agent-result-empty">视频地址不可用或已被安全策略拦截。</div>';
    const title = String(video.title || '工作流视频').trim() || '工作流视频';
    const height = Math.max(180, Math.min(Number(video.height) || 420, 900));
    return `<div class="agent-workflow-output-media agent-workflow-output-video"><strong>${agentEscape(title)}</strong><video controls preload="metadata" referrerpolicy="no-referrer" height="${height}" src="${agentEscapeAttr(safeUrl)}"></video></div>`;
}

function agentWorkflowEmbeddedAudioMarkup(audio = {}) {
    const rawUrl = String(audio.url || '').trim();
    const safeUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(rawUrl) ? rawUrl : '';
    if (!safeUrl) return '<div class="agent-result-empty">音频地址不可用或已被安全策略拦截。</div>';
    const title = String(audio.title || '工作流音频').trim() || '工作流音频';
    return `<div class="agent-workflow-output-media agent-workflow-output-audio"><strong>${agentEscape(title)}</strong><audio controls preload="metadata" referrerpolicy="no-referrer" src="${agentEscapeAttr(safeUrl)}"></audio></div>`;
}

function agentWorkflowLinkCardMarkup(card = {}) {
    const rawUrl = String(card.url || '').trim();
    const safeUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(rawUrl) ? rawUrl : '';
    if (!safeUrl) return '<div class="agent-result-empty">链接地址不可用或已被安全策略拦截。</div>';
    const title = String(card.title || '打开链接').trim() || '打开链接';
    const description = String(card.description || '').trim();
    return `<a class="agent-workflow-output-link-card" href="${agentEscapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer"><strong>${agentEscape(title)}</strong>${description ? `<span>${agentEscape(description)}</span>` : ''}<em>新窗口打开</em></a>`;
}

function agentWorkflowEmbedCodeMarkup(payload = {}) {
    const code = String(payload.code || '').trim();
    if (!code) return '<div class="agent-result-empty">没有生成可用的嵌入代码。</div>';
    const title = String(payload.title || '网站嵌入代码').trim() || '网站嵌入代码';
    const notice = String(payload.notice || '请将代码粘贴到目标网站页面中。').trim();
    const previewUrl = String(payload.url || '').trim();
    const safePreviewUrl = /^(?:https?:\/\/|\/(?!\/))/i.test(previewUrl) ? previewUrl : '';
    return `<div class="agent-workflow-output-code"><div class="agent-workflow-output-code-head"><strong>${agentEscape(title)}</strong>${safePreviewUrl ? `<a class="btn-secondary" href="${agentEscapeAttr(safePreviewUrl)}" target="_blank" rel="noopener noreferrer">预览页面</a>` : ''}</div><pre><code>${agentEscape(code)}</code></pre><span>${agentEscape(notice)}</span></div>`;
}

