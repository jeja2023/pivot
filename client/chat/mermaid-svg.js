(function () {
    'use strict';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const tags = new Set('svg g path rect text tspan circle ellipse line polyline polygon defs marker clippath lineargradient radialgradient stop style title desc symbol use pattern switch filter'.split(' '));

    // 渲染结果仍视为不可信；动画只在图片文档中播放，禁止脚本、外部资源和任意属性改写。
    function inspect(source, allowMissingNamespace = false, allowAnimation = false) {
        const document = new DOMParser().parseFromString(source, 'image/svg+xml');
        if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('图形不是有效的 SVG，请检查源码后重试。');
        const root = document.documentElement;
        const nodes = [root, ...root.querySelectorAll('*')];
        if (nodes.length > 20000) throw new Error('图形元素过多，请拆分为较小的图。');
        const policy = window.Pivot.moduleApi('chat.svgAnimationPolicy');
        let animations = 0;
        for (const node of nodes) {
            const animated = policy.inspectAnimation(node.localName, [...node.attributes].map(attr => [attr.name, attr.value]), allowAnimation);
            if (animated && ++animations > 256) throw new Error('图形动画过多，请拆分后重试。');
            if ((node.namespaceURI !== SVG_NS && !(allowMissingNamespace && !node.namespaceURI)) || (!animated && !tags.has(node.localName.toLowerCase()))) throw new Error('图形包含不支持的元素。');
            for (const attribute of [...node.attributes]) {
                const name = attribute.name.toLowerCase();
                const value = attribute.value;
                if ((name === 'xmlns' && value === SVG_NS) || (name === 'xmlns:xlink' && value === 'http://www.w3.org/1999/xlink')) continue;
                if (name.startsWith('on') || name === 'xml:base' || name.startsWith('xmlns') || /(?:javascript|vbscript|data|https?|file):|\\|@|expression\s*\(/i.test(value)
                    || (/href$/.test(name) && !/^#[\w.-]+$/.test(value)) || /(?:image-set|image|src|paint)\s*\(|url\s*\(\s*["']?(?!#[\w.-]+["']?\s*\))/i.test(value)) {
                    throw new Error('图形包含外部资源或动态内容，请移除后重试。');
                }
            }
            if (node.localName === 'style') {
                const css = node.textContent.replace(/@(?:-webkit-)?keyframes\s+[\w-]+/gi, '');
                if (/\\|@|(?:javascript|https?|data|file):|expression\s*\(|(?:image-set|image|src|paint)\s*\(|url\s*\(\s*["']?(?!#[\w.-]+["']?\s*\))/i.test(css)) throw new Error('图形样式包含外部资源，请移除后重试。');
            }
        }
        return root;
    }

    function sanitize(source, { strict = false, allowAnimation = false } = {}) {
        if (typeof source !== 'string' || new Blob([source]).size > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(source)) throw new Error('图形内容超过限制或包含不支持的声明。');
        if (!window.DOMPurify) throw new Error('图形安全组件未就绪，请刷新后重试。');
        // 模型直接输出的 SVG 先检查原文，避免动态内容被静默删除后仍显示为有效图形。
        if (strict) inspect(source, true, allowAnimation);
        const policy = window.Pivot.moduleApi('chat.svgAnimationPolicy');
        const safe = window.Pivot.legacy.PivotSafeHtml.sanitizeHtml(source, { USE_PROFILES: { svg: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', ...(allowAnimation ? [] : policy.ANIMATION_TAGS)],
            ...(allowAnimation ? { ADD_TAGS: policy.ANIMATION_TAGS, ADD_ATTR: policy.ANIMATION_ATTRIBUTES } : {}) });
        const root = inspect(safe, strict, allowAnimation);
        root.setAttribute('xmlns', SVG_NS);
        root.removeAttribute('style');
        let box = (root.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
        if (!root.hasAttribute('viewBox')) {
            const length = name => {
                const value = (root.getAttribute(name) || '').trim();
                return /^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value) ? Number.parseFloat(value) : NaN;
            };
            box = [0, 0, length('width'), length('height')];
        }
        if (box.length === 4 && box.every(Number.isFinite)
            && box[2] > 0 && box[3] > 0
            && box[2] <= 30000 && box[3] <= 30000) {
            root.setAttribute('viewBox', box.join(' '));
            root.setAttribute('width', String(Math.ceil(box[2])));
            root.setAttribute('height', String(Math.ceil(box[3])));
        } else throw new Error('图形尺寸无效或过大，请拆分后重试。');
        return new window.XMLSerializer().serializeToString(root);
    }

    window.Pivot.exposeModule('chat.mermaidSvg', { sanitize });
})();
