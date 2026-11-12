(function () {
    'use strict';
    const states = new Map();
    let viewer = null;
    let observer = null;
    let scheduled = false;
    const roots = new Set();
    const user = () => String(window.Pivot?.legacy?.currentUser?.id || 'current-page');
    const escape = value => window.Pivot.legacy.PivotSafeHtml.escapeHtml(value);

    function markup(source, { pending = false, resultFiles = false, language = 'mermaid' } = {}) {
        const svg = language === 'svg';
        language = svg ? 'svg' : 'mermaid';
        const label = svg ? 'SVG 图形' : '流程图 · Mermaid';
        const saveTitle = svg ? '将静态矢量图形保存到本机授权目录' : '将 Mermaid 源码保存为 TXT 文件';
        const saveLabel = svg ? '保存到本机' : '保存源码';
        if (resultFiles) return `<details class="mermaid-card code-block mermaid-supplement" data-mermaid-card data-mermaid-source-only="true" data-code-language="${language}" aria-label="补充图形源码"><summary>补充图形源码</summary><div class="mermaid-toolbar"><span class="mermaid-label">图形预览、下载和保存请使用上方“结果文件”。</span><div class="mermaid-actions"><button type="button" class="btn-secondary btn-sm" data-mermaid-action="copy-source">复制源码</button></div></div><div class="mermaid-source"><pre><code class="language-${language}">${escape(source)}</code></pre></div></details>`;
        return `<section class="mermaid-card code-block" data-mermaid-card data-code-language="${language}" data-mermaid-pending="${pending ? 'true' : 'false'}" aria-label="${label}">
            <div class="mermaid-toolbar"><strong class="mermaid-label">${label}</strong>
                <div class="mermaid-tabs" role="tablist" aria-label="图形显示方式"><button type="button" class="btn-secondary btn-sm" role="tab" aria-selected="true" data-mermaid-action="preview">预览</button><button type="button" class="btn-secondary btn-sm" role="tab" aria-selected="false" data-mermaid-action="source">源码</button></div>
                <div class="mermaid-actions"><button type="button" class="btn-secondary btn-sm" data-mermaid-action="expand" disabled>放大查看</button><button type="button" class="btn-secondary btn-sm" data-mermaid-action="download-svg" disabled>下载 SVG</button><button type="button" class="btn-secondary btn-sm" data-mermaid-action="copy-source" title="复制图形源码">复制源码</button><button type="button" class="btn-secondary btn-sm" data-mermaid-action="save-source" title="${saveTitle}">${saveLabel}</button></div>
            </div>
            <div class="mermaid-preview" role="tabpanel" aria-label="图形预览"><p class="mermaid-status" role="status">${pending ? '正在接收图形源码，完整后显示预览。' : '正在准备图形预览…'}</p><img class="mermaid-image hidden" alt="${label}预览"><button type="button" class="btn-secondary btn-sm mermaid-retry hidden" data-mermaid-action="retry">重新渲染</button></div>
            <div class="mermaid-source hidden" role="tabpanel" aria-label="图形源码"><pre><code class="language-${language}">${escape(source)}</code></pre></div>
        </section>`;
    }

    function palette(card) {
        const style = getComputedStyle(card);
        return {
            surface: style.getPropertyValue('--surface').trim() || style.backgroundColor, side: style.getPropertyValue('--bg-side').trim() || style.backgroundColor,
            text: style.getPropertyValue('--text-main').trim() || style.color, border: style.getPropertyValue('--border').trim() || style.color
        };
    }

    function current(card, state) {
        return states.get(card) === state && card.isConnected && state.userId === user() && card.querySelector('code')?.textContent === state.source;
    }

    function dispose(card) {
        const state = states.get(card);
        if (!state) return;
        if (viewer?.card === card) closeViewer();
        if (state.url) URL.revokeObjectURL(state.url);
        states.delete(card);
    }

    async function renderCard(card, retry = false) {
        if (card.dataset.mermaidUser && card.dataset.mermaidUser !== user()) {
            dispose(card); card.textContent = '账号已切换，请重新打开当前回复。'; return;
        }
        card.dataset.mermaidUser = user();
        if (card.dataset.mermaidSourceOnly === 'true') {
            if (!states.has(card)) states.set(card, { source: card.querySelector('code')?.textContent || '', userId: user(), url: '' });
            return;
        }
        if (card.dataset.mermaidPending === 'true') return;
        const source = card.querySelector('code')?.textContent || '';
        const colors = palette(card);
        const old = states.get(card);
        if (!retry && old && old.source === source && old.userId === user() && JSON.stringify(old.colors) === JSON.stringify(colors)) return;
        dispose(card);
        const state = { source, userId: user(), colors, svg: '', url: '' };
        states.set(card, state);
        const status = card.querySelector('.mermaid-status');
        const image = card.querySelector('.mermaid-image');
        status.textContent = '正在渲染图形…'; status.classList.remove('hidden'); image.classList.add('hidden');
        card.querySelector('.mermaid-retry').classList.add('hidden');
        card.querySelectorAll('[data-mermaid-action="expand"], [data-mermaid-action="download-svg"]').forEach(button => { button.disabled = true; });
        try {
            const svg = card.dataset.codeLanguage === 'svg'
                ? window.Pivot.moduleApi('chat.mermaidSvg').sanitize(source, { strict: true })
                : await window.Pivot.moduleApi('chat.mermaidRuntime').render(source, colors, { retry });
            if (!current(card, state)) return;
            state.svg = svg;
            state.url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
            image.onload = () => {
                if (!current(card, state)) return;
                status.classList.add('hidden'); image.classList.remove('hidden');
                card.querySelectorAll('[data-mermaid-action="expand"], [data-mermaid-action="download-svg"]').forEach(button => { button.disabled = false; });
            };
            image.onerror = () => {
                if (!current(card, state)) return;
                state.svg = ''; URL.revokeObjectURL(state.url); state.url = '';
                status.textContent = '图形预览加载失败，可查看源码或重新渲染。';
                card.querySelector('.mermaid-retry').classList.remove('hidden');
            };
            image.src = state.url;
        } catch (error) {
            if (!current(card, state)) return;
            status.textContent = `${error.message || '图形渲染失败。'} 可切换到源码检查，或点击重新渲染。`;
            card.querySelector('.mermaid-retry').classList.remove('hidden');
        }
    }

    function render(root = document) {
        const cards = [...(root.querySelectorAll?.('[data-mermaid-card]') || [])];
        if (root.matches?.('[data-mermaid-card]')) cards.unshift(root);
        for (const card of cards) void renderCard(card);
    }

    function cleanup() {
        for (const [card, state] of states) {
            if (!card.isConnected) dispose(card);
            else if (state.userId !== user()) { dispose(card); card.textContent = '账号已切换，请重新打开当前回复。'; }
        }
    }

    function switchView(card, source) {
        card.querySelector('.mermaid-preview').classList.toggle('hidden', source);
        card.querySelector('.mermaid-source').classList.toggle('hidden', !source);
        card.querySelectorAll('[role="tab"]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.mermaidAction === (source ? 'source' : 'preview'))); });
    }

    function closeViewer() {
        if (!viewer) return;
        const previous = viewer; viewer = null; previous.element.remove();
        if (previous.trigger?.isConnected) previous.trigger.focus();
    }

    function openViewer(card, trigger) {
        const state = states.get(card);
        if (!state?.svg || !current(card, state)) return;
        closeViewer();
        const element = document.createElement('div');
        element.className = 'modal-overlay mermaid-viewer';
        element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true'); element.setAttribute('aria-label', '放大查看图形');
        window.Pivot.legacy.PivotSafeHtml.setHtml(element, `<div class="workspace-modal mermaid-viewer-dialog"><div class="workspace-modal-header"><h3>图形预览</h3><div class="mermaid-viewer-actions"><button type="button" class="btn-secondary btn-sm" data-mermaid-viewer="out" aria-label="缩小">缩小</button><button type="button" class="btn-secondary btn-sm" data-mermaid-viewer="reset">适应窗口</button><button type="button" class="btn-secondary btn-sm" data-mermaid-viewer="in" aria-label="放大">放大</button><button type="button" class="btn-secondary btn-sm" data-mermaid-viewer="download">下载 SVG</button><button type="button" class="btn-secondary btn-sm" data-mermaid-viewer="close">关闭</button></div></div><div class="workspace-modal-body mermaid-viewer-body"><img alt="放大的图形"></div></div>`);
        const image = element.querySelector('img'); image.src = state.url;
        viewer = { element, card, trigger, image, zoom: 1 };
        element.addEventListener('click', event => {
            if (event.target === element || event.target.closest('[data-mermaid-viewer="close"]')) { closeViewer(); return; }
            const action = event.target.closest('[data-mermaid-viewer]')?.dataset.mermaidViewer;
            if (!action || !viewer) return;
            if (action === 'download') { download(card); return; }
            viewer.zoom = action === 'reset' ? 1 : Math.min(4, Math.max(0.25, viewer.zoom + (action === 'in' ? 0.25 : -0.25)));
            image.classList.toggle('is-zoomed', viewer.zoom !== 1);
            if (viewer.zoom === 1) image.removeAttribute('width'); else image.width = Math.round(image.naturalWidth * viewer.zoom);
        });
        document.body.appendChild(element);
        element.querySelector('[data-mermaid-viewer="close"]').focus();
    }

    function download(card) {
        const state = states.get(card);
        if (!state?.svg || !current(card, state)) return;
        const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = card.dataset.codeLanguage === 'svg' ? '图形.svg' : '流程图.svg';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copySource(card, trigger) {
        const source = card.querySelector('code')?.textContent || '';
        try {
            try { await navigator.clipboard.writeText(source); }
            catch (_) {
                const buffer = document.createElement('textarea'); buffer.className = 'mermaid-copy-buffer'; buffer.value = source;
                document.body.appendChild(buffer); buffer.select();
                try { if (!document.execCommand('copy')) throw new Error('复制未成功'); }
                finally { buffer.remove(); trigger.focus(); }
            }
            trigger.textContent = '已复制源码'; setTimeout(() => { trigger.textContent = '复制源码'; }, 2000);
        } catch (_) { window.Pivot.legacy.showToast?.('复制失败，请切换到源码并手动复制。', 'error'); }
    }

    document.addEventListener('click', event => {
        const trigger = event.target.closest?.('[data-mermaid-action]');
        const card = trigger?.closest('[data-mermaid-card]');
        if (!card) return;
        if (card.dataset.mermaidUser && card.dataset.mermaidUser !== user()) { cleanup(); return; }
        const action = trigger.dataset.mermaidAction;
        if (action === 'source' || action === 'preview') switchView(card, action === 'source');
        if (action === 'retry') void renderCard(card, true);
        if (action === 'expand') openViewer(card, trigger);
        if (action === 'download-svg') download(card);
        if (action === 'copy-source') void copySource(card, trigger);
        if (action === 'save-source') void window.Pivot.moduleApi('chat.codeDelivery').saveCodeBlockToDesktop(trigger);
    });
    document.addEventListener('keydown', event => {
        if (!viewer) return;
        if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
        else if (event.key === 'Tab') {
            const buttons = [...viewer.element.querySelectorAll('button')];
            const index = buttons.indexOf(document.activeElement);
            if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1).focus(); }
            else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0].focus(); }
        }
    });

    function start() {
        observer = new window.MutationObserver(changes => {
            for (const change of changes) {
                if (change.type === 'attributes' && [document.body, document.documentElement].includes(change.target)) roots.add(document.body);
                for (const node of change.addedNodes) if (node.nodeType === 1) roots.add(node);
            }
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false; cleanup();
                for (const root of roots) if (root.isConnected) render(root);
                roots.clear();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-theme'] });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
        render();
    }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());
    window.addEventListener('pagehide', () => { observer?.disconnect(); roots.clear(); closeViewer(); for (const card of states.keys()) dispose(card); });
    window.Pivot.exposeModule('chat.mermaid', { markup, render, cleanup });
})();
