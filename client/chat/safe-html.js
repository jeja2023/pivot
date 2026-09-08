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

    const setHtml = (element, html, options = {}) => {
        if (!element) return;
        const raw = String(html ?? '');
        if (!window.DOMPurify) {
            element.textContent = raw;
            return;
        }
        const scratch = createContextElement(element);
        scratch.innerHTML = raw;
        DOMPurify.sanitize(scratch, { ...sanitizeOptions(options), IN_PLACE: true });
        element.replaceChildren(...Array.from(scratch.childNodes));
    };

    const prependHtml = (element, html, options = {}) => {
        if (!element) return;
        const raw = String(html ?? '');
        if (!window.DOMPurify) {
            element.prepend(document.createTextNode(raw));
            return;
        }
        const scratch = createContextElement(element);
        scratch.innerHTML = raw;
        DOMPurify.sanitize(scratch, { ...sanitizeOptions(options), IN_PLACE: true });
        element.prepend(...Array.from(scratch.childNodes));
    };

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
