/* Shared frontend HTML safety helpers */
(function () {
    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const escapeAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

    const sanitizeHtml = (html, options = {}) => {
        const raw = String(html ?? '');
        if (!window.DOMPurify) return raw;
        return DOMPurify.sanitize(raw, options);
    };

    const setHtml = (element, html, options = {}) => {
        if (!element) return;
        element.innerHTML = sanitizeHtml(html, options);
    };

    window.PivotSafeHtml = {
        escapeHtml,
        escapeAttr,
        sanitizeHtml,
        setHtml
    };
})();
