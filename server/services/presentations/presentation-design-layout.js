'use strict';

function resolveDesignLayout(layout, slide) {
    if (!layout || !String(layout.id).startsWith('design-')) return layout;
    const kind = layout.id.slice(7);
    if (!['key-metrics', 'timeline', 'three-card', 'roadmap'].includes(kind)) return layout;
    const expression = kind === 'key-metrics' ? /^value\d+$/ : kind === 'timeline' ? /^step\d+$/ : /^card\d+$/;
    const count = Math.max(1, (slide.elements || []).filter(element => expression.test(element.id)).length);
    const width = (1112 - (count - 1) * 40) / count;
    return { ...layout, placeholders: layout.placeholders.filter(slot => !/\d+$/.test(slot.role) || Number(slot.role.match(/\d+$/)[0]) <= count).map(slot => {
        const number = slot.role.match(/\d+$/);
        return number ? { ...slot, x: 88 + (Number(number[0]) - 1) * (width + 40), width } : slot;
    }), decorations: layout.decorations.filter(element => !/^step_rule_/.test(element.id) || Number(element.id.slice(10)) < count).map(element => {
        const number = element.id.match(/^step_rule_(\d+)$/);
        return number ? { ...element, x: 88 + Number(number[1]) * (width + 40), width } : element;
    }) };
}

function reflowDesignElements(elements, layout, presentation = {}) {
    const movable = elements.filter(element => !element.locked && element.visible !== false);
    const scale = Number(presentation.width || (presentation.aspectRatio === '4:3' ? 960 : 1280)) / 1280;
    const slots = (layout.placeholders || []).map(slot => ({ ...slot, x: slot.x * scale, width: slot.width * scale }));
    const assigned = new Set();
    const groups = new Map(slots.map(slot => [slot.id, []]));
    for (const element of movable) {
        const type = element.type;
        const title = element.id === 'title';
        const target = slots.find(slot => slot.kind === type && (element.id === slot.role || element.id === slot.id || element.role === slot.role))
            || slots.find(slot => slot.kind === type && !assigned.has(slot.id) && (title ? slot.role === 'title' : slot.role !== 'title'))
            || slots.find(slot => slot.kind === type && (title ? slot.role === 'title' : slot.role !== 'title'));
        if (target) { groups.get(target.id).push(element); assigned.add(target.id); }
    }
    for (const slot of slots) {
        const items = groups.get(slot.id);
        const gap = 18, height = (slot.height - (items.length - 1) * gap) / Math.max(1, items.length);
        items.forEach((element, index) => {
            Object.assign(element, { x: slot.x, y: slot.y + index * (height + gap), width: slot.width, height: Math.max(24, height), rotation: 0 });
            if (element.type === 'text') element.style = { ...element.style, ...slot.style, fontFamily: slot.style?.fontFamily || element.style.fontFamily };
        });
    }
    return elements;
}

module.exports = { reflowDesignElements, resolveDesignLayout };
