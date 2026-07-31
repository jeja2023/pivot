/* 前端 HTML 安全辅助函数 */
(function () {
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
        return DOMPurify.sanitize(raw, options);
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
        DOMPurify.sanitize(scratch, { ...options, IN_PLACE: true });
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
        DOMPurify.sanitize(scratch, { ...options, IN_PLACE: true });
        element.prepend(...Array.from(scratch.childNodes));
    };

    const api = {
        escapeHtml,
        escapeAttr,
        sanitizeHtml,
        setHtml,
        prependHtml
    };

    window.PivotSafeHtml = api;
    window.Pivot = window.Pivot || {};
    window.Pivot.html = api;
})();
