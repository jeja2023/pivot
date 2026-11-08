'use strict';

const { diagramScene } = require('../../../client/chat/presentation-graphics');

function addNativeDiagram(slide, pptx, element, pos, fontFace) {
    const scene = diagramScene(element), prefix = `pivotAnim_${element.id}`;
    const sx = pos.w / scene.width, sy = pos.h / scene.height;
    const stroke = element.style.stroke.replace('#', '');
    for (const edge of scene.edges) {
        const x1 = pos.x + edge.start.x * sx, y1 = pos.y + edge.start.y * sy;
        const x2 = pos.x + edge.end.x * sx, y2 = pos.y + edge.end.y * sy;
        slide.addShape(pptx.ShapeType.line, {
            x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
            flipH: x1 > x2, flipV: y1 > y2,
            line: { color: stroke, width: 1.5, beginArrowType: 'none', endArrowType: edge.directed === false ? 'none' : 'triangle' },
            objectName: `${prefix}__edge_${edge.id}`
        });
        if (edge.label) slide.addText(edge.label, {
            x: (x1 + x2) / 2 - 0.55, y: (y1 + y2) / 2 - 0.23, w: 1.1, h: 0.22,
            fontFace, fontSize: element.style.fontSize * 0.6, color: element.style.textColor.replace('#', ''), align: 'center',
            margin: 0, objectName: `${prefix}__edge_label_${edge.id}`
        });
    }
    for (const node of scene.nodes) {
        const bounds = { x: pos.x + node.x * sx, y: pos.y + node.y * sy, w: node.width * sx, h: node.height * sy };
        slide.addShape(pptx.ShapeType.roundRect, {
            ...bounds, rectRadius: 0.08,
            fill: { color: element.style.fill.replace('#', '') }, line: { color: stroke, width: 1 },
            objectName: `${prefix}__node_${node.id}`
        });
        slide.addText(node.label, {
            ...bounds, margin: 0.04, fontFace, color: element.style.textColor.replace('#', ''), fontSize: element.style.fontSize * 0.75,
            align: 'center', valign: 'mid', breakLine: false, wrap: true, fit: 'none',
            objectName: `${prefix}__node_label_${node.id}`
        });
    }
    return scene;
}

module.exports = { addNativeDiagram };
