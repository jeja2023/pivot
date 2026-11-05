(function () {
    'use strict';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const tags = new Set('svg g path rect text tspan circle ellipse line polyline polygon defs marker clippath lineargradient radialgradient stop style title desc symbol use pattern switch filter'.split(' '));

    // 渲染结果仍视为不可信；下载和图片预览只接受无脚本、无外部资源的静态 SVG。
    function sanitize(source) {
        if (typeof source !== 'string' || source.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('图形内容超过限制或包含不支持的声明。');
        if (!window.DOMPurify) throw new Error('图形安全组件未就绪，请刷新后重试。');
        const safe = window.Pivot.legacy.PivotSafeHtml.sanitizeHtml(source, { USE_PROFILES: { svg: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'animate', 'set'] });
        const document = new DOMParser().parseFromString(safe, 'image/svg+xml');
        if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('图形不是有效的 SVG，请检查源码后重试。');
        const root = document.documentElement;
        const nodes = [root, ...root.querySelectorAll('*')];
        if (nodes.length > 20000) throw new Error('图形元素过多，请拆分为较小的图。');
        for (const node of nodes) {
            if (node.namespaceURI !== SVG_NS || !tags.has(node.localName.toLowerCase())) throw new Error('图形包含不支持的动态元素。');
            for (const attribute of [...node.attributes]) {
                const name = attribute.name.toLowerCase();
                const value = attribute.value;
                if (name === 'xmlns' || name === 'xmlns:xlink') continue;
                if (name.startsWith('on') || /(?:javascript|vbscript|data|https?|file):|\\|@|expression\s*\(/i.test(value)
                    || (/href$/.test(name) && !/^#[\w.-]+$/.test(value)) || /url\s*\(\s*["']?(?!#[\w.-]+["']?\s*\))/i.test(value)) {
                    throw new Error('图形包含外部资源或动态内容，请移除后重试。');
                }
            }
            if (node.localName === 'style') {
                const css = node.textContent.replace(/@(?:-webkit-)?keyframes\s+[\w-]+/gi, '');
                if (/\\|@|(?:javascript|https?|data|file):|expression\s*\(|url\s*\(\s*["']?(?!#[\w.-]+["']?\s*\))/i.test(css)) throw new Error('图形样式包含外部资源，请移除后重试。');
            }
        }
        root.setAttribute('xmlns', SVG_NS);
        root.removeAttribute('style');
        const box = (root.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
        if (box.length === 4 && box.every(Number.isFinite)
            && box[2] > 0 && box[3] > 0
            && box[2] <= 30000 && box[3] <= 30000) {
            root.setAttribute('width', String(Math.ceil(box[2])));
            root.setAttribute('height', String(Math.ceil(box[3])));
        } else throw new Error('图形尺寸无效或过大，请拆分后重试。');
        return new window.XMLSerializer().serializeToString(root);
    }

    window.Pivot.exposeModule('chat.mermaidSvg', { sanitize });
})();
