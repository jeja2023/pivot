'use strict';

const { shape, label } = require('./presentation-editorial-templates');

function roleOf(id, roles) { return roles.find(role => id === role || new RegExp(`^${role}_[2-9]$`).test(id)); }
function grouped(slide, roles) {
    return (slide.elements || []).filter(element => !element.locked && element.type === 'text' && roleOf(element.id, roles))
        .flatMap(element => String(element.content?.text || '').split('\n\n').map(text => ({ ...element, content: { text } })));
}

function resolveEditorialLayout(layout, slide) {
    const next = JSON.parse(JSON.stringify(layout)), { kind, rule, primary, muted, ink } = layout.editorial;
    const slots = next.placeholders;
    const groups = ['executive-summary', 'comparison', 'risk-actions', 'two-column'].includes(kind)
        ? kind === 'executive-summary' ? ['body', 'evidence'] : ['left', 'right'] : [];
    for (const role of groups) {
        const original = slots.find(slot => slot.role === role);
        const items = grouped(slide, [role]);
        const count = Math.max(1, items.length), gap = 24;
        original.height = (300 - gap * (count - 1)) / count;
        for (let index = 1; index < count; index++) slots.push({ ...original, id: `slot_${role}_${index + 1}`, role: `${role}_${index + 1}`, y: original.y + index * (original.height + gap) });
        if (count === 2) {
            original.y = 286; original.height = 112;
            const second = slots.find(slot => slot.role === `${role}_2`); second.y = 458; second.height = 112;
        }
    }
    if (kind === 'agenda') {
        const count = Math.max(1, grouped(slide, Array.from({ length: 8 }, (_, i) => `step${i + 1}`)).length);
        const rowHeight = Math.min(120, 370 / count), top = 226;
        next.placeholders = slots.filter(slot => !/^step/.test(slot.role) || Number(slot.role.slice(4)) <= count).map(slot => /^step/.test(slot.role)
            ? { ...slot, x: 198, y: top + (Number(slot.role.slice(4)) - 1) * rowHeight + 14, height: rowHeight - 28, width: 948, style: { ...slot.style, fontSize: count > 5 ? 27 : 32, fontWeight: 500 } } : slot);
        for (let index = 0; index < count; index++) next.decorations.push(label(`agenda_number_${index}`, String(index + 1).padStart(2, '0'), 94, top + index * rowHeight + 10, 72, primary, 42),
            shape(`agenda_rule_${index}`, 192, top + index * rowHeight + rowHeight - 5, 1004, 1, rule));
    }
    if (['process', 'timeline', 'three-card', 'roadmap', 'key-metrics'].includes(kind)) {
        const prefix = kind === 'key-metrics' ? 'value' : ['process', 'timeline'].includes(kind) ? 'step' : 'card';
        const count = Math.max(1, (slide.elements || []).filter(element => new RegExp(`^${prefix}\\d+$`).test(element.id)).length);
        const gap = 34, width = (1120 - gap * (count - 1)) / count;
        next.placeholders = slots.filter(slot => !/\d+$/.test(slot.role) || Number(slot.role.match(/\d+$/)[0]) <= count).map(slot => {
            const number = slot.role.match(/\d+$/);
            return number ? { ...slot, x: 94 + (Number(number[0]) - 1) * (width + gap), width: width - 12 } : slot;
        });
        for (let index = 0; index < count; index++) {
            const x = 88 + index * (width + gap);
            next.decorations.push(shape(`item_rule_${index}`, x, kind === 'key-metrics' ? 236 : 268, width, 2, rule));
            if (kind !== 'key-metrics') next.decorations.push(label(`item_number_${index}`, String(index + 1).padStart(2, '0'), x + 6, 210, width, primary, 32));
        }
    }
    if (kind === 'title-content') {
        const items = grouped(slide, ['body']);
        const count = Math.max(1, items.length), height = (360 - 20 * (count - 1)) / count;
        const original = slots.find(slot => slot.role === 'body');
        original.height = height;
        for (let index = 1; index < count; index++) slots.push({ ...original, id: `slot_body_${index + 1}`, role: `body_${index + 1}`, y: original.y + index * (height + 20) });
        for (let index = 0; index < count; index++) next.decorations.push(label(`body_number_${index}`, String(index + 1).padStart(2, '0'), 82, original.y + index * (height + 20) + 1, 42, muted, 22));
    }
    if (!['cover', 'section', 'summary'].includes(kind)) next.decorations.push(shape('footer_rule', 80, 656, 1120, 1, rule));
    // 版式中的文字都使用内容色，装饰标号仅辅助阅读，不作为材料事实。
    for (const slot of next.placeholders) if (slot.style && !slot.style.color) slot.style.color = ink;
    return next;
}

module.exports = { resolveEditorialLayout };
