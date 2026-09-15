/* 前端 HTML 安全辅助函数 */
let PivotSafeHtml;

(function () {
    // Markdown 渲染出的详情、数学 MathML 和受控 SVG 属性在所有安全插入点使用
    // 同一份白名单，避免“先消毒一次、插入前又用另一份规则消毒”的语义分叉。
    const MARKDOWN_SAFE_OPTIONS = Object.freeze({
        ADD_TAGS: [
            'details', 'summary', 'thought', 'math', 'annotation', 'semantics', 'mrow', 'mi', 'mn', 'mo',
            'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'msqrt', 'mroot',
            'mspace', 'mtext', 'mstyle', 'merror'
        ],
        ADD_ATTR: ['class', 'open', 'type', 'title', 'aria-label', 'encoding', 'display', 'viewBox', 'd', 'xmlns', 'src', 'alt', 'href', 'target', 'rel']
    });

    const sanitizeOptions = options => ({ ...MARKDOWN_SAFE_OPTIONS, ...options });
    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const escapeAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

    const sanitizeHtml = (html, options = {}) => {
        const raw = String(html ?? '');
        if (!window.DOMPurify) return escapeHtml(raw);
        return DOMPurify.sanitize(raw, sanitizeOptions(options));
    };

    function createContextElement(element) {
        const tagName = String(element?.tagName || 'div').toLowerCase();
        if (element?.namespaceURI && element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
            return document.createElementNS(element.namespaceURI, tagName);
        }
        return document.createElement(tagName || 'div');
    }

    const FORBIDDEN_TAGS = new Set([
        'script', 'style', 'iframe', 'frame', 'object', 'embed', 'base', 'meta', 'link', 'form'
    ]);
    const DANGEROUS_PROTOCOLS = /^\s*(?:javascript|vbscript|data:text\/html)/i;

    function sanitizeDomFallback(root) {
        if (!root || !root.querySelectorAll) return;
        FORBIDDEN_TAGS.forEach(tag => {
            root.querySelectorAll(tag).forEach(el => el.remove());
        });
        const allElements = root.querySelectorAll('*');
        allElements.forEach(el => {
            const toRemove = [];
            for (let i = 0; i < el.attributes.length; i++) {
                const attr = el.attributes[i];
                const name = attr.name.toLowerCase();
                const val = attr.value;
                if (name.startsWith('on')) {
                    toRemove.push(attr.name);
                } else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'data') && DANGEROUS_PROTOCOLS.test(val)) {
                    toRemove.push(attr.name);
                }
            }
            toRemove.forEach(attrName => el.removeAttribute(attrName));
        });
    }

    const setHtml = (element, html, options = {}) => {
        if (!element) return;
        const raw = String(html ?? '');
        const scratch = createContextElement(element);
        scratch.innerHTML = raw;
        if (window.DOMPurify) {
            DOMPurify.sanitize(scratch, { ...sanitizeOptions(options), IN_PLACE: true });
        } else {
            sanitizeDomFallback(scratch);
        }
        element.replaceChildren(...Array.from(scratch.childNodes));
    };

    const prependHtml = (element, html, options = {}) => {
        if (!element) return;
        const raw = String(html ?? '');
        const scratch = createContextElement(element);
        scratch.innerHTML = raw;
        if (window.DOMPurify) {
            DOMPurify.sanitize(scratch, { ...sanitizeOptions(options), IN_PLACE: true });
        } else {
            sanitizeDomFallback(scratch);
        }
        element.prepend(...Array.from(scratch.childNodes));
    };

    if (typeof window !== 'undefined' && !window.DOMPurify && typeof document !== 'undefined') {
        const hasScript = Array.from(document.scripts || []).some(s => (s.src || '').includes('purify.min.js'));
        if (!hasScript && (document.head || document.documentElement)) {
            const script = document.createElement('script');
            script.src = '/common/vendor/purify.min.js';
            script.async = true;
            (document.head || document.documentElement).appendChild(script);
        }
    }

    const api = {
        escapeHtml,
        escapeAttr,
        sanitizeHtml,
        setHtml,
        prependHtml,
        markdownSafeOptions: MARKDOWN_SAFE_OPTIONS
    };

    PivotSafeHtml = api;
    window.Pivot.legacy.PivotSafeHtml = api;
    window.Pivot.html = api;
})();
