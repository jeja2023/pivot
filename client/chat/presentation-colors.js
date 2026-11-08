(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Pivot.exposeModule('apps.presentations.colors', api);
})(typeof window === 'undefined' ? globalThis : window, function () {
    'use strict';
    function luminance(value) {
        const hex = String(value || '#FFFFFF').replace('#', '');
        const channels = [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    const contrast = (foreground, background) => (Math.max(luminance(foreground), luminance(background)) + 0.05) / (Math.min(luminance(foreground), luminance(background)) + 0.05);
    function readable(background, preferred = '#243746') {
        if (contrast(preferred, background) >= 4.5) return preferred;
        const dark = contrast('#172B3A', background) >= 4.5 ? '#172B3A' : '#000000';
        return contrast('#FFFFFF', background) >= contrast(dark, background) ? '#FFFFFF' : dark;
    }
    function textBackground(slide, text) {
        const behind = (slide.elements || []).filter(item => item.visible !== false && item.type === 'shape' && Number(item.rotation || 0) % 360 === 0 && ['rect', 'roundRect'].includes(item.shapeType)
            && Number(item.style?.opacity ?? 1) === 1 && Number(item.zIndex || 0) < Number(text.zIndex || 0) && item.x <= text.x && item.y <= text.y
            && item.x + item.width >= text.x + text.width && item.y + item.height >= text.y + text.height).sort((a, b) => b.zIndex - a.zIndex)[0];
        return behind?.style?.fill || slide.background?.fill || '#FFFFFF';
    }
    return { contrast, readable, textBackground };
});
