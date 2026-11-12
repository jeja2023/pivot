/* HTML 源码只在无脚本、无网络、无同源权限的独立文档中预览。 */
(function () {
    'use strict';
    const cards = new Map();
    const user = () => String(window.Pivot.legacy?.currentUser?.id || 'current-page');
    const safeHtml = () => window.Pivot.legacy.PivotSafeHtml;
    function markup(pending) {
        return `<div class="code-preview-panel" aria-label="HTML 静态预览"><p class="code-preview-status" role="status">${pending ? '正在接收 HTML 源码，完整后显示预览。' : '正在准备 HTML 静态预览…'}</p><div class="code-preview-content"></div></div>`;
    }
    function current(card, state) {
        return card.isConnected && cards.get(card) === state && state.userId === user() && card.querySelector('code')?.textContent === state.source;
    }
    function dispose(card) {
        card.querySelector('.code-preview-content')?.replaceChildren();
        cards.delete(card);
    }
    function cleanup() {
        for (const [card, state] of cards) {
            if (!card.isConnected) dispose(card);
            else if (state.userId !== user()) { dispose(card); card.textContent = '账号已切换，请重新打开当前回复。'; }
        }
    }
    function render(root = document) {
        cleanup();
        const elements = [...(root.querySelectorAll?.('[data-code-preview]') || [])];
        if (root.matches?.('[data-code-preview]')) elements.unshift(root);
        for (const card of elements) {
            const source = card.querySelector('code')?.textContent || '';
            const old = cards.get(card);
            if (old?.source === source && old.userId === user()) continue;
            dispose(card);
            const state = { source, userId: user() }; cards.set(card, state);
            const status = card.querySelector('.code-preview-status');
            if (card.dataset.codePending === 'true') continue;
            try {
                if (new Blob([source]).size > 2 * 1024 * 1024) throw new Error('HTML 预览超过大小限制，请查看源码或下载文件。');
                if (!window.DOMPurify) throw new Error('安全预览组件未就绪，请刷新后重试。');
                const html = safeHtml().sanitizeHtml(source, {
                    WHOLE_DOCUMENT: true, USE_PROFILES: { html: true, svg: true },
                    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'base', 'link', 'meta', 'audio', 'video', 'source', 'track'],
                    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'target', 'ping', 'autofocus', 'tabindex', 'poster', 'data', 'background']
                });
                const frame = document.createElement('iframe');
                frame.className = 'code-preview-frame'; frame.title = 'HTML 静态预览';
                frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
                frame.onload = () => { if (current(card, state)) status.textContent = '静态预览：脚本和外部资源未加载；下载或保存的是原始源码。'; };
                const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
                // 策略置于所有用户内容之前；页面 CSS 与 HTML 不进入聊天主文档。
                safeHtml().setSrcdoc(frame, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`);
                card.querySelector('.code-preview-content').replaceChildren(frame);
            } catch (error) { status.textContent = `${error.message || 'HTML 预览失败。'} 可切换到源码查看。`; }
        }
    }
    document.addEventListener('click', event => {
        const trigger = event.target.closest?.('[data-code-view]');
        const card = trigger?.closest('[data-code-preview]');
        if (!card) return;
        cleanup();
        if (!card.querySelector('.code-preview-panel')) return;
        const source = trigger.dataset.codeView === 'source';
        card.querySelector('.code-preview-panel').classList.toggle('hidden', source);
        card.querySelector('.code-preview-source').classList.toggle('hidden', !source);
        card.querySelectorAll('[data-code-view]').forEach(button => button.setAttribute('aria-pressed', String(button === trigger)));
    });
    let observer;
    let scheduled = false;
    function start() {
        observer = new window.MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; render(); });
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme'] });
        render();
    }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('pagehide', () => { observer?.disconnect(); for (const card of cards.keys()) dispose(card); });
    window.Pivot.exposeModule('chat.codePreview', { markup, render });
})();
