'use strict';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function move(element, x, y, width, height) {
    if (!element || element.locked) return;
    element.x = Math.round(x); element.y = Math.round(y); element.width = Math.round(width); element.height = Math.round(height);
}

function titleElement(elements) {
    return elements.filter(element => !element.locked && element.type === 'text')
        .sort((a, b) => Number(b.style?.fontSize || 0) - Number(a.style?.fontSize || 0))[0] || null;
}

function buildVariant(slide, { id, name, description, arrange }) {
    const next = clone(slide);
    const movable = next.elements.filter(element => !element.locked && element.visible !== false);
    const title = titleElement(movable);
    const content = movable.filter(element => element.id !== title?.id);
    if (title) move(title, 80, 58, 1120, 72);
    arrange(content);
    return { id, name, description, slide: next };
}

function buildSlideLayoutVariants(slide = {}, { aspectRatio = '16:9' } = {}) {
    const width = aspectRatio === '4:3' ? 960 : 1280;
    const right = width - 80;
    const heroTypes = new Set(['chart', 'table', 'image', 'diagram', 'media']);
    return [
        buildVariant(slide, {
            id: 'executive-summary', name: '高管摘要', description: '左侧结论，右侧关键图表或证据，适合决策汇报。',
            arrange: content => {
                const hero = content.find(element => heroTypes.has(element.type));
                const text = content.filter(element => element !== hero);
                if (hero) move(hero, 670, 160, right - 670, 360);
                text.forEach((element, index) => move(element, 100, 165 + index * 128, hero ? 500 : 1080, Math.min(108, 470 - index * 20)));
            }
        }),
        buildVariant(slide, {
            id: 'evidence-focus', name: '证据聚焦', description: '放大一个核心图表、图片或表格，文字作为简短结论。',
            arrange: content => {
                const hero = content.find(element => heroTypes.has(element.type)) || content[0];
                if (hero) move(hero, 110, 155, width - 220, 365);
                content.filter(element => element !== hero).forEach((element, index) => move(element, 110 + index * 360, 550, Math.min(330, width - 190 - index * 360), 85));
            }
        }),
        buildVariant(slide, {
            id: 'balanced-comparison', name: '平衡对比', description: '将两个主要对象并列，适合方案、指标或前后对比。',
            arrange: content => {
                const columns = Math.min(2, Math.max(1, content.length));
                const columnWidth = columns === 2 ? Math.floor((width - 240) / 2) : width - 200;
                content.forEach((element, index) => {
                    const column = index % columns;
                    const row = Math.floor(index / columns);
                    move(element, 100 + column * (columnWidth + 40), 165 + row * 215, columnWidth, 175);
                });
            }
        })
    ];
}

module.exports = { buildSlideLayoutVariants };
