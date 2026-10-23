'use strict';

const parse5 = require('parse5');
const sharp = require('sharp');
const TAGS = new Set('svg g path rect text tspan circle ellipse line polyline polygon defs marker clipPath linearGradient radialGradient stop style title desc symbol use pattern'.toLowerCase().split(' '));

function sanitizeSvg(source) {
    if (Buffer.byteLength(source) > 1024 * 1024 || /<!ENTITY/i.test(source)) throw new Error('SVG 大小或声明不符合安全限制。');
    // Graphviz 固定的 SVG 1.1 声明不需要解析外部 DTD；仅删除此白名单声明和 XML 前导。
    source = source.replace(/^\s*<\?xml[^?]*\?>\s*/i, '')
        .replace(/<!DOCTYPE svg PUBLIC "-\/\/W3C\/\/DTD SVG 1\.1\/\/EN"\s+"http:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd">/i, '');
    if (/<!DOCTYPE/i.test(source)) throw new Error('SVG 文档类型声明不受支持。');
    const fragment = parse5.parseFragment(source);
    const roots = fragment.childNodes.filter(node => node.nodeName !== '#comment' && (node.nodeName !== '#text' || node.value.trim()));
    if (roots.length !== 1 || roots[0].tagName !== 'svg') throw new Error('图形必须是单个 SVG 元素。');
    let count = 0;
    function inspectSvgNode(node, depth) {
        if (++count > 20000 || depth > 100) throw new Error('SVG 结构超过限制。');
        if (node.nodeName === '#text' || node.nodeName === '#comment') return;
        if (!TAGS.has(String(node.tagName).toLowerCase()) || node.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('SVG 包含不允许的元素。');
        for (const attribute of node.attrs || []) {
            const value = attribute.value;
            if ((attribute.name === 'xmlns' && value === 'http://www.w3.org/2000/svg')
                || (attribute.prefix === 'xmlns' && attribute.name === 'xlink' && value === 'http://www.w3.org/1999/xlink')) continue;
            if (/^on/i.test(attribute.name) || /\\|(?:javascript|data|https?|file):|@|expression\s*\(/i.test(value)
                || (/href$/i.test(attribute.name) && !/^#[\w.-]+$/.test(value))
                || /url\s*\(\s*(?!#[\w.-]+\s*\))/i.test(value)) throw new Error('SVG 包含外部资源或动态内容。');
        }
        if (node.tagName === 'style') {
            const css = (node.childNodes || []).map(child => child.value || '').join('');
            const checkedCss = css.replace(/@(?:-webkit-)?keyframes\s+[\w-]+/gi, '');
            if (/\\|@|javascript:|expression\s*\(|url\s*\(\s*(?!#[\w.-]+\s*\))/i.test(checkedCss)) throw new Error('SVG 样式包含外部资源。');
        }
        for (const child of node.childNodes || []) inspectSvgNode(child, depth + 1);
    }
    inspectSvgNode(roots[0], 0);
    return parse5.serialize(fragment).trim();
}

async function renderImage(ir, format, options) {
    const images = ir.blocks.filter(block => block.type === 'image');
    if (images.length !== 1 || !options.imageResolver) throw new Error('图片导出需要一个受控 CAS 图片。');
    const bytes = await options.imageResolver(images[0].asset_ref);
    if (!bytes || bytes.length > 2 * 1024 * 1024) throw new Error('图形内容为空或超过限制。');
    if (format === 'svg') return Buffer.from(sanitizeSvg(bytes.toString('utf8')));
    const input = bytes.toString('utf8').trimStart().startsWith('<')
        ? Buffer.from(sanitizeSvg(bytes.toString('utf8'))) : bytes;
    return sharp(input, { limitInputPixels: 16000000 }).png().toBuffer();
}

module.exports = { sanitizeSvg, renderImage };
