'use strict';

/**
 * 演示文稿模板母版、布局图层叠加与智能排版（Smart Reflow）
 * 依据 PPTX/NotebookLM/GPT/Opus 规范进行多色卡片与结构化对齐
 */

function layoutForSlide(template, slide) {
    const layouts = Array.isArray(template?.definition?.layouts) ? template.definition.layouts : (Array.isArray(template?.layouts) ? template.layouts : []);
    const requested = String(slide?.layoutId || '').trim();
    return layouts.find(layout => layout.id === requested)
        || layouts.find(layout => layout.legacyLayoutId === requested)
        || layouts.find(layout => slide?.type === 'cover' && (layout.legacyLayoutId === 'cover' || /封面|cover/i.test(layout.name)))
        || layouts[0]
        || null;
}

function templateLayerElements(template, layout, slideIndex) {
    const masters = Array.isArray(template?.definition?.masters) ? template.definition.masters : (Array.isArray(template?.masters) ? template.masters : []);
    const master = masters.find(item => item.id === layout?.masterId) || null;
    const source = [...(master?.decorations || []), ...(layout?.decorations || [])];
    return source.map((element, index) => {
        const cloned = JSON.parse(JSON.stringify(element));
        if (cloned.content?.text) {
            cloned.content.text = cloned.content.text.replace(/^[★✦]\s*/, '');
        }
        return {
            ...cloned,
            id: `pivotTemplate_${String(master?.id || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(layout?.id || 'layout').replace(/[^A-Za-z0-9_-]/g, '_')}_${slideIndex + 1}_${index + 1}`,
            locked: element.locked !== false,
            visible: element.visible !== false,
            sourceRefs: []
        };
    });
}

function slotForTextElement(element, placeholders, used) {
    const text = String(element?.content?.text || '');
    const isTitle = element?.id === 'title' || element?.role === 'title';
    const role = isTitle ? 'title' : /副标题|subtitle/i.test(text) ? 'subtitle' : 'body';
    return placeholders.find(slot => slot.kind === 'text' && !used.has(slot.id) && slot.role === role)
        || placeholders.find(slot => slot.kind === 'text' && !used.has(slot.id) && (isTitle ? slot.role === 'title' : slot.role !== 'title'));
}

function reflowSlideElements(elements, layout, template) {
    const theme = template.definition?.theme || template.theme || {};
    const colors = theme.colors || {};
    const placeholders = layout.placeholders || [];
    const used = new Set();
    const placed = new Set();

    const hasDecorations = (layout.decorations || []).some(d => d.type === 'shape');
    let editable = elements.filter(el => {
        if (!hasDecorations) return true;
        if (el.type !== 'shape') return true;
        const id = String(el.id || '').toLowerCase();
        return !/^(?:card_\d+|card\d+|left_box|right_box|focus_box|summary_box|content_box|backdrop|box_\d+|line|cover_accent|accent_.*|header_.*|title_.*|divider.*|border_.*|rect_.*|bg_.*)$/i.test(id);
    });

    editable.forEach(el => {
        el.zIndex = Math.max(Number(el.zIndex) || 10, 10);
    });

    // 1. 识别并放置主标题元素
    const titleSlot = placeholders.find(s => s.role === 'title' && s.kind === 'text');
    let titleEl = editable.find(el => el.type === 'text' && (el.id === 'title' || el.role === 'title'));
    if (!titleEl && titleSlot) {
        const texts = editable.filter(el => el.type === 'text').sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
        if (texts.length && (texts[0].style?.fontSize || 0) >= 26) {
            titleEl = texts[0];
        }
    }

    if (titleEl && titleSlot) {
        used.add(titleSlot.id);
        placed.add(titleEl);
        titleEl.x = titleSlot.x;
        titleEl.y = titleSlot.y;
        titleEl.width = titleSlot.width;
        titleEl.height = titleSlot.height;
        titleEl.rotation = titleSlot.rotation || 0;
        if (titleSlot.style && Object.keys(titleSlot.style).length) {
            titleEl.style = { ...titleEl.style, ...titleSlot.style };
        }
        if (layout.slotAnimations?.[titleSlot.role]) {
            titleEl.animation = { ...layout.slotAnimations[titleSlot.role] };
        }
    }

    // 2. 专用版式插槽映射
    const layoutId = layout.id || layout.legacyLayoutId;
    const remaining = editable.filter(el => !placed.has(el));

    if (layoutId === 'cover') {
        const subSlot = placeholders.find(s => s.role === 'subtitle');
        const subEl = remaining.find(el => /sub|message|desc/i.test(el.id)) || remaining.find(el => el.type === 'text');
        if (subEl && subSlot) {
            placed.add(subEl);
            used.add(subSlot.id);
            subEl.x = subSlot.x;
            subEl.y = subSlot.y;
            subEl.width = subSlot.width;
            subEl.height = subSlot.height;
            if (subSlot.style) subEl.style = { ...subEl.style, ...subSlot.style };
            if (layout.slotAnimations?.subtitle) subEl.animation = { ...layout.slotAnimations.subtitle };

            const secondEl = remaining.find(el => el !== subEl && el.type === 'text' && !placed.has(el));
            if (secondEl) {
                placed.add(secondEl);
                secondEl.x = subSlot.x;
                secondEl.y = subSlot.y + 64;
                secondEl.width = subSlot.width;
                secondEl.height = 42;
                secondEl.style = {
                    ...secondEl.style,
                    fontSize: 18,
                    fontWeight: 400,
                    color: colors.text || '#64748B',
                    align: 'left',
                    lineHeight: 1.4
                };
                if (layout.slotAnimations?.subtitle) {
                    secondEl.animation = { ...layout.slotAnimations.subtitle, delayMs: (layout.slotAnimations.subtitle.delayMs || 220) + 100 };
                }
            }
        }
    } else if (layoutId === 'three-card') {
        const cardSlots = [
            placeholders.find(s => s.role === 'card1'),
            placeholders.find(s => s.role === 'card2'),
            placeholders.find(s => s.role === 'card3')
        ];
        const cardPalette = colors.cardPalette || [
            colors.primary || '#1769AA',
            colors.secondary || '#5B8FF9',
            colors.accent || '#61DDAA',
            '#D8A23A',
            '#7A5AF8',
            '#C84A4A'
        ];

        for (let i = 0; i < 3; i++) {
            const slot = cardSlots[i];
            if (!slot) continue;
            used.add(slot.id);
            const num = i + 1;
            const cardRegex = new RegExp(`card[_-]?${num}`, 'i');
            const cardElements = remaining.filter(el => cardRegex.test(el.id) || el.cardIndex === i);
            const title = cardElements.find(el => /title|heading|header/i.test(el.id));
            const body = cardElements.find(el => /body|content|text|desc/i.test(el.id)) || cardElements.find(el => el !== title);

            const anim = layout.slotAnimations?.[slot.role];
            if (title && body && title !== body) {
                placed.add(title);
                placed.add(body);
                const cColor = cardPalette[i % cardPalette.length];
                title.x = slot.x;
                title.y = slot.y;
                title.width = slot.width;
                title.height = 38;
                title.style = { ...title.style, fontSize: 20, fontWeight: 700, color: cColor, align: 'left', lineHeight: 1.3 };
                body.x = slot.x;
                body.y = slot.y + 46;
                body.width = slot.width;
                body.height = slot.height - 46;
                body.style = { ...body.style, fontSize: 15, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.55 };
                if (anim) {
                    title.animation = { ...anim };
                    body.animation = { ...anim, delayMs: (anim.delayMs || 0) + 60 };
                }
            } else if (cardElements.length) {
                const single = cardElements[0];
                placed.add(single);
                single.x = slot.x;
                single.y = slot.y;
                single.width = slot.width;
                single.height = slot.height;
                if (slot.style) single.style = { ...single.style, ...slot.style };
                if (anim) single.animation = { ...anim };
            }
        }
    } else if (layoutId === 'two-column') {
        const leftSlot = placeholders.find(s => s.role === 'left');
        const rightSlot = placeholders.find(s => s.role === 'right');
        const cardPalette = colors.cardPalette || [
            colors.primary || '#1769AA',
            colors.secondary || '#5B8FF9',
            colors.accent || '#61DDAA',
            '#D8A23A',
            '#7A5AF8',
            '#C84A4A'
        ];

        const layoutCol = (slot, regex) => {
            if (!slot) return;
            used.add(slot.id);
            const colElements = remaining.filter(el => regex.test(el.id));
            const title = colElements.find(el => /title|heading|header/i.test(el.id));
            const body = colElements.find(el => /body|content|text|desc/i.test(el.id)) || colElements.find(el => el !== title);
            const anim = layout.slotAnimations?.[slot.role];

            if (title && body && title !== body) {
                placed.add(title);
                placed.add(body);
                const colColor = slot.role === 'left' ? cardPalette[0] : cardPalette[1];
                title.x = slot.x;
                title.y = slot.y;
                title.width = slot.width;
                title.height = 40;
                title.style = { ...title.style, fontSize: 22, fontWeight: 700, color: colColor, align: 'left', lineHeight: 1.3 };
                body.x = slot.x;
                body.y = slot.y + 48;
                body.width = slot.width;
                body.height = slot.height - 48;
                body.style = { ...body.style, fontSize: 17, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.95 };
                if (anim) {
                    title.animation = { ...anim };
                    body.animation = { ...anim, delayMs: (anim.delayMs || 0) + 60 };
                }
            } else if (colElements.length) {
                const single = colElements[0];
                placed.add(single);
                single.x = slot.x;
                single.y = slot.y;
                single.width = slot.width;
                single.height = slot.height;
                if (slot.style) single.style = { ...single.style, ...slot.style };
                if (anim) single.animation = { ...anim };
            }
        };

        layoutCol(leftSlot, /left|col_?1/i);
        layoutCol(rightSlot, /right|col_?2/i);
    } else if (layoutId === 'title-content') {
        const bodySlot = placeholders.find(s => s.role === 'body' && s.kind === 'text');
        if (bodySlot) {
            used.add(bodySlot.id);
            const textElements = remaining.filter(el => el.type === 'text');
            const points = textElements.filter(el => /point|bullet|item/i.test(el.id));
            const notes = textElements.filter(el => /note|hint|source/i.test(el.id));
            const regular = textElements.filter(el => !points.includes(el) && !notes.includes(el));
            const ordered = [...points, ...regular, ...notes];

            if (ordered.length === 1) {
                const el = ordered[0];
                placed.add(el);
                el.x = bodySlot.x;
                el.y = bodySlot.y;
                el.width = bodySlot.width;
                el.height = bodySlot.height;
                if (bodySlot.style) el.style = { ...el.style, ...bodySlot.style };
                if (layout.slotAnimations?.body) el.animation = { ...layout.slotAnimations.body };
            } else if (ordered.length > 1) {
                const count = ordered.length;
                const spacing = Math.min(105, Math.max(68, Math.floor((bodySlot.height - (notes.length ? 50 : 20)) / count)));
                ordered.forEach((el, idx) => {
                    placed.add(el);
                    const isNote = notes.includes(el);
                    el.x = bodySlot.x;
                    el.y = isNote ? (bodySlot.y + bodySlot.height - 40) : (bodySlot.y + idx * spacing);
                    el.width = bodySlot.width;
                    el.height = isNote ? 36 : Math.min(80, spacing - 8);
                    el.style = {
                        ...el.style,
                        fontSize: isNote ? 14 : count <= 3 ? 22 : count <= 5 ? 19 : 17,
                        fontWeight: isNote ? 400 : 500,
                        lineHeight: 1.6,
                        color: isNote ? '#64748B' : (colors.text || '#1F2937'),
                        align: 'left'
                    };
                    if (layout.slotAnimations?.body) {
                        el.animation = { ...layout.slotAnimations.body, delayMs: (layout.slotAnimations.body.delayMs || 150) + idx * 90 };
                    }
                });
            }
        }
    } else if (layoutId === 'summary') {
        const sumSlot = placeholders.find(s => s.role === 'summary');
        const nextSlot = placeholders.find(s => s.role === 'nextSteps');

        const sumEl = remaining.find(el => /summary|recap/i.test(el.id)) || remaining.find(el => el.type === 'text' && !placed.has(el));
        if (sumEl && sumSlot) {
            placed.add(sumEl);
            used.add(sumSlot.id);
            sumEl.x = sumSlot.x; sumEl.y = sumSlot.y; sumEl.width = sumSlot.width; sumEl.height = sumSlot.height;
            if (sumSlot.style) sumEl.style = { ...sumEl.style, ...sumSlot.style };
            if (layout.slotAnimations?.summary) sumEl.animation = { ...layout.slotAnimations.summary };
        }
        const nextEl = remaining.find(el => /next|closing|action|step/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
        if (nextEl && nextSlot) {
            placed.add(nextEl);
            used.add(nextSlot.id);
            nextEl.x = nextSlot.x; nextEl.y = nextSlot.y; nextEl.width = nextSlot.width; nextEl.height = nextSlot.height;
            if (nextSlot.style) nextEl.style = { ...nextEl.style, ...nextSlot.style };
            if (layout.slotAnimations?.nextSteps) nextEl.animation = { ...layout.slotAnimations.nextSteps };
        }
    } else if (layoutId === 'image-focus') {
        const capSlot = placeholders.find(s => s.role === 'caption');
        const imgSlot = placeholders.find(s => s.role === 'image');
        const imgEl = remaining.find(el => el.type === 'image' && !placed.has(el));
        if (imgEl && imgSlot) {
            placed.add(imgEl);
            used.add(imgSlot.id);
            imgEl.x = imgSlot.x; imgEl.y = imgSlot.y; imgEl.width = imgSlot.width; imgEl.height = imgSlot.height;
            if (layout.slotAnimations?.image) imgEl.animation = { ...layout.slotAnimations.image };
        }
        const capEl = remaining.find(el => /cap|text|desc/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
        if (capEl && capSlot) {
            placed.add(capEl);
            used.add(capSlot.id);
            capEl.x = capSlot.x; capEl.y = capSlot.y; capEl.width = capSlot.width; capEl.height = capSlot.height;
            if (capSlot.style) capEl.style = { ...capEl.style, ...capSlot.style };
            if (layout.slotAnimations?.caption) capEl.animation = { ...layout.slotAnimations.caption };
        }
    } else if (layoutId === 'quote') {
        const quoteSlot = placeholders.find(s => s.role === 'quote');
        const attrSlot = placeholders.find(s => s.role === 'attribution');
        const quoteEl = remaining.find(el => /quote|golden|statement/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
        if (quoteEl && quoteSlot) {
            placed.add(quoteEl);
            used.add(quoteSlot.id);
            quoteEl.x = quoteSlot.x; quoteEl.y = quoteSlot.y; quoteEl.width = quoteSlot.width; quoteEl.height = quoteSlot.height;
            if (quoteSlot.style) quoteEl.style = { ...quoteEl.style, ...quoteSlot.style };
            if (layout.slotAnimations?.quote) quoteEl.animation = { ...layout.slotAnimations.quote };
        }
        const attrEl = remaining.find(el => /attr|author|source|note/i.test(el.id) && !placed.has(el)) || remaining.find(el => el.type === 'text' && !placed.has(el));
        if (attrEl && attrSlot) {
            placed.add(attrEl);
            used.add(attrSlot.id);
            attrEl.x = attrSlot.x; attrEl.y = attrSlot.y; attrEl.width = attrSlot.width; attrEl.height = attrSlot.height;
            if (attrSlot.style) attrEl.style = { ...attrEl.style, ...attrSlot.style };
            if (layout.slotAnimations?.attribution) attrEl.animation = { ...layout.slotAnimations.attribution };
        }
    }

    // 3. 兜底处理未放置的元素
    editable.forEach(el => {
        if (!placed.has(el)) {
            const slot = slotForTextElement(el, placeholders, used);
            if (slot) {
                used.add(slot.id);
                el.x = slot.x; el.y = slot.y; el.width = slot.width; el.height = slot.height;
                if (slot.style) el.style = { ...el.style, ...slot.style };
                if (layout.slotAnimations?.[slot.role]) el.animation = { ...layout.slotAnimations[slot.role] };
            }
        }
    });

    return editable;
}

function applyTemplateLayoutLayers(content, template, { reflow = false, normalizePresentation } = {}) {
    const definition = template?.definition || template || {};
    if (!Array.isArray(definition.masters) || !definition.masters.length) return content;
    const theme = definition.theme || content.theme || {};
    const slides = (content.slides || []).map((slide, slideIndex) => {
        const layout = layoutForSlide(template, slide);
        if (!layout) return slide;
        const master = definition.masters.find(item => item.id === layout.masterId) || null;
        let elements = (slide.elements || []).filter(element => !String(element.id || '').startsWith('pivotTemplate_')).map(element => JSON.parse(JSON.stringify(element)));
        if (reflow) {
            elements = reflowSlideElements(elements, layout, template);
        } else {
            elements.forEach(element => {
                element.zIndex = Math.max(Number(element.zIndex) || 10, 10);
            });
        }
        const background = master?.background ? {
            fill: master.background.fill || slide.background?.fill || theme.colors?.background || '#FFFFFF',
            imageAssetRef: master.background.imageAssetRef || '',
            opacity: master.background.opacity === undefined ? 1 : master.background.opacity
        } : slide.background;
        return { ...slide, layoutId: layout.id, background, transition: layout.defaultTransition?.type !== 'none' ? { ...layout.defaultTransition } : slide.transition, elements: [...templateLayerElements(template, layout, slideIndex), ...elements] };
    });
    const result = { ...content, theme: { ...content.theme, ...theme, colors: { ...(content.theme?.colors || {}), ...(theme.colors || {}) }, fonts: { ...(content.theme?.fonts || {}), ...(theme.fonts || {}) } }, slides };
    return typeof normalizePresentation === 'function' ? normalizePresentation(result) : result;
}

function applyTemplateBrandControls(content, template, { normalizePresentation } = {}) {
    const controls = template?.definition?.brandControls || template?.brandControls || {};
    const hasExistingBrandElements = (content.slides || []).some(slide => (slide.elements || []).some(element => String(element.id || '').startsWith('pivotBrand_')));
    if (!controls.lockBrandElements && !controls.lockFonts && !hasExistingBrandElements) return content;
    const theme = template?.definition?.theme || content.theme || {};
    const slides = (content.slides || []).map((slide, slideIndex) => {
        let elements = (slide.elements || []).filter(element => !String(element.id || '').startsWith('pivotBrand_')).map(element => ({ ...element, style: element.style ? { ...element.style } : element.style }));
        if (controls.lockFonts) {
            elements = elements.map(element => element.type === 'text' ? { ...element, style: { ...element.style, fontFamily: Number(element.style?.fontSize || 0) >= 24 ? theme.fonts?.heading || element.style?.fontFamily : theme.fonts?.body || element.style?.fontFamily } } : element);
        }
        if (controls.lockBrandElements) {
            const textColor = theme.colors?.text || '#1F2937';
            const footerY = Math.max(664, Number(content.height || 720) - 48);
            if (controls.footerText) elements.push({ id: 'pivotBrand_footer', type: 'text', x: 64, y: footerY, width: 900, height: 24, rotation: 0, zIndex: 990, locked: true, visible: true, sourceRefs: [], content: { text: controls.footerText }, style: { fontFamily: theme.fonts?.body || 'Microsoft YaHei', fontSize: 10, fontWeight: 400, color: textColor, align: 'left', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } });
            if (controls.showPageNumber) elements.push({ id: 'pivotBrand_page', type: 'text', x: 1160, y: footerY, width: 56, height: 24, rotation: 0, zIndex: 991, locked: true, visible: true, sourceRefs: [], content: { text: String(slideIndex + 1) }, style: { fontFamily: theme.fonts?.body || 'Microsoft YaHei', fontSize: 10, fontWeight: 400, color: textColor, align: 'right', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } });
            if (controls.logoAssetRef) elements.push({ id: 'pivotBrand_logo', type: 'image', x: 1080, y: 28, width: 120, height: 48, rotation: 0, zIndex: 992, locked: true, visible: true, sourceRefs: [], assetRef: controls.logoAssetRef, fit: 'contain', opacity: 1, alt: '组织品牌 Logo' });
        }
        return { ...slide, elements };
    });
    const result = { ...content, theme: { ...content.theme, ...theme, colors: { ...(content.theme?.colors || {}), ...(theme.colors || {}) }, fonts: { ...(content.theme?.fonts || {}), ...(theme.fonts || {}) } }, slides };
    return typeof normalizePresentation === 'function' ? normalizePresentation(result) : result;
}

module.exports = {
    applyTemplateLayoutLayers,
    applyTemplateBrandControls
};
