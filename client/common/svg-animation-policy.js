/* SVG 声明式动画的前后端共用边界：只允许图形属性变化，不允许修改脚本、链接或文档结构。 */
(function (scope) {
    'use strict';
    const ANIMATION_TAGS = Object.freeze(['animate', 'animatetransform', 'animatemotion', 'mpath', 'set']);
    const ANIMATION_ATTRIBUTES = Object.freeze('attributeName attributeType begin end dur repeatDur repeatCount min max restart calcMode keyTimes keySplines keyPoints additive accumulate from to by values type path rotate origin'.toLowerCase().split(' '));
    const GRAPHIC_PROPERTIES = new Set('x y x1 y1 x2 y2 cx cy r rx ry width height opacity fill fill-opacity stroke stroke-opacity stroke-width stroke-dasharray stroke-dashoffset transform d points visibility'.split(' '));
    const TIMING = /^(?:indefinite|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:h|min|s|ms)?|[\w-]+\.(?:begin|end|repeat\(\d+\))(?:[+-](?:\d+(?:\.\d*)?|\.\d+)(?:h|min|s|ms)?)?)$/;

    function inspectAnimation(tagName, attributes, allowAnimation) {
        const tag = String(tagName).toLowerCase();
        if (!ANIMATION_TAGS.includes(tag)) return false;
        if (!allowAnimation) throw new Error('图形包含当前入口不支持的动画元素。');
        const attrs = Object.fromEntries(attributes.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
        if (tag === 'mpath') {
            if (Object.keys(attrs).some(name => !['href', 'xlink:href', 'id'].includes(name))) throw new Error('动画路径包含不支持的属性。');
            return true;
        }
        for (const name of Object.keys(attrs)) {
            if (!ANIMATION_ATTRIBUTES.includes(name) && !['id', 'href', 'xlink:href', 'fill'].includes(name)) throw new Error('SVG 动画包含不支持的属性。');
        }
        if (tag !== 'animatemotion' && !GRAPHIC_PROPERTIES.has(String(attrs.attributename || '').toLowerCase())) throw new Error('SVG 动画只能修改受支持的图形属性。');
        if (tag === 'animatetransform' && (attrs.attributename?.toLowerCase() !== 'transform' || !['translate', 'scale', 'rotate', 'skewX', 'skewY'].includes(attrs.type))) throw new Error('SVG 变换动画类型无效。');
        for (const name of ['begin', 'end']) {
            if (attrs[name] && !attrs[name].split(';').every(value => TIMING.test(value.trim()))) throw new Error('SVG 动画仅支持时间或动画间同步触发。');
        }
        return true;
    }

    const api = { ANIMATION_TAGS, ANIMATION_ATTRIBUTES, inspectAnimation };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.Pivot.exposeModule('chat.svgAnimationPolicy', api);
})(globalThis);
