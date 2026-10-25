import contents from 'simple-mind-map/src/core/render/node/nodeCreateContents.js';
import { G, Text } from '@svgdotjs/svg.js';
const original = contents.createTextNode;
// 纯文本使用 Canvas 测量，消除上游逐字创建 SVG 并同步触发布局的开销。
contents.createTextNode = function createMeasuredText(specifyText) {
    if (this.getData('richText')) return original.call(this, specifyText);
    delete this.nodeData.data.needUpdate; delete this.nodeData.data.resetRichText;
    const value = String(typeof specifyText === 'string' ? specifyText : this.getData('text') || '');
    const size = Number(this.getStyle('fontSize', false)) || 16;
    const align = this.getStyle('textAlign', false) || 'left';
    const family = this.getStyle('fontFamily', false) || 'sans-serif';
    const weight = this.getStyle('fontWeight', false) || 'normal';
    const italic = this.getStyle('fontStyle', false) || 'normal';
    const cache = this.mindMap.commonCaches;
    const context = cache.pivotTextContext ||= document.createElement('canvas').getContext('2d');
    context.font = `${italic} ${weight} ${size}px ${family}`;
    const maxWidth = this.mindMap.opt.textAutoWrapWidth;
    const lines = [];
    for (const paragraph of value.split('\n')) {
        if (!paragraph || context.measureText(paragraph).width <= maxWidth) { lines.push(paragraph); continue; }
        let line = '';
        for (const character of paragraph) {
            const next = line + character;
            if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = character; } else line = next;
        }
        lines.push(line);
    }
    let width = 0;
    const group = new G();
    const metrics = context.measureText('国Ag');
    const ascent = Math.max(metrics.actualBoundingBoxAscent || 0, size * 0.85);
    const descent = Math.max(metrics.actualBoundingBoxDescent || 0, size * 0.2);
    const lineHeight = Math.max(size * 1.2, ascent + descent);
    lines.forEach((line, index) => {
        width = Math.max(width, context.measureText(line).width);
        const node = new Text().text(line || '\ufeff').addClass('smm-text-node-wrap');
        this.style.text(node);
        node.attr({ 'text-anchor': { left: 'start', center: 'middle', right: 'end' }[align] || 'start', y: ascent + index * lineHeight });
        group.add(node);
    });
    width = Math.min(Math.ceil(width), maxWidth);
    const height = Math.ceil(lines.length * lineHeight);
    group.attr({ 'data-width': width, 'data-height': height, 'data-ismultiLine': lines.length > 1 });
    return { node: group, width, height };
};
