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

function coverNavigationModel(presentation = {}) {
    const coverSlide = presentation.slides?.[0];
    const sections = (presentation.slides || []).slice(1, 6).map((slide, index) => {
        const title = (slide.elements || []).filter(element => element.type === 'text' && element.content?.text)
            .sort((left, right) => Number(right.style?.fontSize || 0) - Number(left.style?.fontSize || 0))[0]?.content?.text;
        const section = String(slide.sectionTitle || slide.section || title || `章节 ${index + 1}`)
            .split(/[\r\n|｜]/)[0].replace(/^\s*(?:第\s*)?[一二三四五六七八九十\d]+[、.．）)]\s*/, '').trim();
        const chars = Array.from(section);
        return chars.length > 9 ? `${chars.slice(0, 8).join('')}…` : section;
    });
    const visuals = (coverSlide?.elements || []).filter(element => element.visible !== false
        && element.type !== 'text' && Number(element.y) < 504 && Number(element.y) + Number(element.height) > 384
        && Number(element.x) < 1210 && Number(element.x) + Number(element.width) > 72);
    const existingNavigation = visuals.some(element => ['diagram', 'table', 'chart'].includes(element.type)
        || (element.type === 'shape' && Number(element.width) > 600))
        || visuals.filter(element => element.type === 'shape' && Number(element.width) >= 120 && Number(element.width) <= 260 && Number(element.height) >= 20 && Number(element.height) <= 90).length >= 4;
    return { sections, existingNavigation, visible: Boolean(sections.length || existingNavigation), generated: Boolean(sections.length && !existingNavigation) };
}

function presentationCanvas(presentation = {}) {
    const width = Number(presentation?.width);
    const height = Number(presentation?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        return { width, height };
    }
    const aspectRatio = String(presentation?.aspectRatio || '16:9');
    return aspectRatio === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 };
}

function templateLayerElements(template, layout, slideIndex, presentation = {}) {
    const masters = Array.isArray(template?.definition?.masters) ? template.definition.masters : (Array.isArray(template?.masters) ? template.masters : []);
    const master = masters.find(item => item.id === layout?.masterId) || null;
    const source = [...(master?.decorations || []), ...(layout?.decorations || [])];
    const coverNavigation = layout?.id === 'cover' ? coverNavigationModel(presentation) : { sections: [], visible: false, generated: false };

    const canvas = presentationCanvas(presentation);
    const scaleX = canvas.width / 1280;
    const clampIntoCanvas = element => {
        const width = Math.max(1, Math.min(Number(element.width) || 1, canvas.width));
        const height = Math.max(1, Math.min(Number(element.height) || 1, canvas.height));
        return {
            ...element,
            x: Math.round(Math.max(0, Math.min(Number(element.x) || 0, canvas.width - width)) * 100) / 100,
            y: Math.round(Math.max(0, Math.min(Number(element.y) || 0, canvas.height - height)) * 100) / 100,
            width: Math.round(width * 100) / 100,
            height: Math.round(height * 100) / 100
        };
    };
    return source.filter(element => {
        if (element.id === 'cover_nav_panel' && !coverNavigation.generated) return false;
        const navIndex = String(element.id || '').match(/^cover_nav_(?:pill|label)_(\d+)$/);
        return !navIndex || (coverNavigation.generated && Number(navIndex[1]) <= coverNavigation.sections.length);
    }).map((element, index) => {
        const cloned = JSON.parse(JSON.stringify(element));
        if (cloned.content?.text) {
            cloned.content.text = cloned.content.text.replace(/^[★✦]\s*/, '');
            cloned.content.text = cloned.content.text.replace(/\{\{presentationTitle\}\}/g, String(presentation.title || '演示文稿').slice(0, 40));
            cloned.content.text = cloned.content.text.replace(/\{\{coverSection(\d+)\}\}/g, (_match, number) => coverNavigation.sections[Number(number) - 1] || '');
        }
        return {
            ...cloned,
            ...clampIntoCanvas(cloned),
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

function reflowCoverAgendaGroups(elements, placed, layout, template, subSlot) {
    const titleSlot = (layout.placeholders || []).find(s => s.role === 'title');
    const contentLeft = titleSlot ? Number(titleSlot.x) : 80;
    const contentWidth = titleSlot ? Number(titleSlot.width) : 1120;

    const agendaPattern = /(?:agenda|nav|pill|tab|step)[_-]?(?:bg|bar|line|text|label|item)?[_-]?(\d+)/i;
    const candidates = elements.filter(el => !placed.has(el) && agendaPattern.test(String(el.id || '')));
    if (candidates.length) {
        const columnMap = new Map();
        candidates.forEach(el => {
            const match = String(el.id || '').match(agendaPattern);
            if (!match) return;
            const colIndex = Number(match[1]);
            if (!columnMap.has(colIndex)) columnMap.set(colIndex, []);
            columnMap.get(colIndex).push(el);
        });

        const sortedCols = [...columnMap.keys()].sort((a, b) => a - b);
        const count = sortedCols.length;
        if (count >= 2) {
            const minX = Math.min(...candidates.map(el => Number(el.x) || 0));
            const maxX = Math.max(...candidates.map(el => (Number(el.x) || 0) + (Number(el.width) || 0)));
            const needsReflow = minX < contentLeft - 10 || maxX > contentLeft + contentWidth + 10;

            if (needsReflow) {
                const isForest = template?.id === 'forest-green';
                const gap = count > 4 ? 14 : count > 3 ? 16 : 20;
                const itemWidth = Math.floor((contentWidth - (count - 1) * gap) / count);
                const startY = subSlot ? Math.max(isForest ? 320 : 340, Number(subSlot.y) + Number(subSlot.height) + 16) : 340;

                sortedCols.forEach((colNum, i) => {
                    const colX = contentLeft + i * (itemWidth + gap);
                    const colElements = columnMap.get(colNum);

                    const bgEl = colElements.find(el => el.type === 'shape' && !/bar|line/i.test(el.id))
                        || colElements.find(el => el.type === 'shape');
                    const barEl = colElements.find(el => el.type === 'shape' && /bar|line/i.test(el.id) && el !== bgEl);
                    const textEl = colElements.find(el => el.type === 'text');

                    const itemHeight = bgEl ? Math.max(36, Number(bgEl.height) || 42) : 42;

                    if (bgEl) {
                        bgEl.x = colX;
                        bgEl.y = startY;
                        bgEl.width = itemWidth;
                        bgEl.height = itemHeight;
                        bgEl.zIndex = 10;
                        if (bgEl.style) {
                            bgEl.style.radius = Math.round(itemHeight / 2);
                            if (isForest) {
                                bgEl.style.fill = '#F2F8F4';
                                bgEl.style.stroke = '#C2DCC8';
                                bgEl.style.strokeWidth = 1.5;
                            }
                        }
                        placed.add(bgEl);
                    }
                    if (barEl) {
                        barEl.x = colX;
                        barEl.y = startY;
                        barEl.width = itemWidth;
                        barEl.height = Math.min(4, Number(barEl.height) || 3.5);
                        barEl.zIndex = 11;
                        if (isForest && barEl.style) {
                            const palette = template.definition?.theme?.colors?.cardPalette || template.theme?.colors?.cardPalette || ['#1E7A4C', '#3FA97C', '#52B788', '#D8A23A', '#C97A56', '#74A892'];
                            const colColor = palette[i % palette.length];
                            barEl.style.fill = colColor;
                            barEl.style.stroke = colColor;
                            barEl.style.radius = 2;
                        }
                        placed.add(barEl);
                    }
                    if (textEl) {
                        textEl.x = colX;
                        textEl.y = startY + (barEl ? 6 : 4);
                        textEl.width = itemWidth;
                        textEl.height = itemHeight - (barEl ? 10 : 8);
                        textEl.zIndex = 12;
                        textEl.style = {
                            ...textEl.style,
                            fontSize: count > 4 ? 13 : 14,
                            fontWeight: 700,
                            color: isForest ? '#1B4A33' : (textEl.style?.color || '#1F2937'),
                            align: 'center',
                            verticalAlign: 'middle',
                            lineHeight: 1.2
                        };
                        placed.add(textEl);
                    }
                    colElements.forEach(el => {
                        if (!placed.has(el)) {
                            el.x = colX;
                            el.width = itemWidth;
                            placed.add(el);
                        }
                    });
                });
            }
        }
    }

    const panels = elements.filter(el => !placed.has(el) && (
        (el.type === 'shape' && Number(el.width) > 400 && /panel|steps|box|wrap|frame/i.test(el.id)) ||
        (el.type === 'diagram' && el.diagramType === 'process')
    ));
    panels.forEach(panel => {
        if (Number(panel.x) < contentLeft || Number(panel.x) + Number(panel.width) > contentLeft + contentWidth) {
            panel.x = contentLeft;
            panel.width = contentWidth;
            placed.add(panel);
        }
    });
}

function reflowCoverDescriptions(elements, placed, layout, template, subtitleSlot, presentation) {
    const isNavigationOrCardText = el => {
        const id = String(el.id || '').toLowerCase();
        if (/agenda|nav|step|pill|badge|tab|menu|card_text|col_text|grid_text|item_text/i.test(id)) return true;
        if (el.role && !['subtitle', 'description', 'body', 'summary', 'closing'].includes(el.role)) return true;
        const shapes = elements.filter(s => s.type === 'shape' && Number(s.width) > 0 && Number(s.height) > 0 && Number(s.width) < 500);
        return shapes.some(s => el.x >= s.x - 15 && el.x + el.width <= s.x + s.width + 15 && el.y >= s.y - 15 && el.y + el.height <= s.y + s.height + 15);
    };
    const descriptions = elements.filter(element => element.type === 'text' && !placed.has(element) && !isNavigationOrCardText(element));
    if (!descriptions.length || !subtitleSlot) return;

    const width = subtitleSlot.width;
    const left = subtitleSlot.x;
    const aspectRatio = String(template.aspectRatio || '16:9');
    const canvas = aspectRatio === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 };
    const footerLine = (layout.decorations || []).find(element => element.type === 'shape'
        && element.shapeType === 'line' && Number(element.y) > subtitleSlot.y + subtitleSlot.height);
    const footerMeta = (layout.decorations || []).find(element => element.id === 'cover_footer_meta');
    const bottomLimit = Math.min(Number(footerLine?.y || canvas.height), Number(footerMeta?.y || canvas.height));
    const end = Math.min(bottomLimit - 8, canvas.height - 48);
    const agendaPills = elements.filter(el => placed.has(el) && /(?:agenda|nav|pill|tab|step)[_-]?(?:bg|bar|line|text|label|item)?[_-]?(\d+)/i.test(el.id || ''));
    const maxAgendaY = agendaPills.length ? Math.max(...agendaPills.map(el => (Number(el.y) || 0) + (Number(el.height) || 0))) : 0;
    const start = Math.max(subtitleSlot.y + subtitleSlot.height + 4, maxAgendaY ? maxAgendaY + 16 : 0);
    const pageArea = canvas.width * canvas.height;
    const coverNavigation = coverNavigationModel(presentation);
    const master = (template.definition?.masters || template.masters || []).find(item => item.id === layout.masterId);
    const decorations = (layout.decorations || []).filter(element => element.id !== 'cover_nav_panel' || coverNavigation.generated)
        .filter(element => !/^cover_nav_(?:pill|label)_\d+$/.test(element.id || ''));
    const occupied = [...elements, ...decorations, ...(master?.decorations || [])]
        .filter(element => element.visible !== false)
        .filter(element => {
            if (element.type !== 'text') return true;
            if (element.locked && element.id === 'cover_footer_meta') return true;
            return false;
        })
        .filter(element => Number(element.width) > 0 && Number(element.height) > 0)
        .filter(element => Number(element.width) * Number(element.height) < pageArea * 0.35)
        .map(element => ({ x: Number(element.x), y: Number(element.y), width: Number(element.width), height: Number(element.height) }));

    const textLines = (value, fontSize) => String(value || '').split('\n').reduce((count, line) => {
        const charsPerLine = Math.max(8, Math.floor(width / Math.max(1, fontSize * 0.58)));
        return count + Math.max(1, Math.ceil(line.length / charsPerLine));
    }, 0);
    const findY = height => {
        const obstacles = occupied.filter(box => left < box.x + box.width && left + width > box.x)
            .map(box => [box.y, box.y + box.height]).sort((a, b) => a[0] - b[0]);
        let y = start;
        while (y + height <= end) {
            const collision = obstacles.find(([top, bottom]) => y < bottom && y + height > top);
            if (!collision) return y;
            y = Math.max(y + 2, collision[1] + 16);
        }
        return null;
    };

    descriptions.forEach((element, index) => {
        const preferredFontSize = Math.min(18, Math.max(14, Number(element.style?.fontSize) || 18));
        let placement = null;
        for (const fontSize of [preferredFontSize, 16, 14, 12]) {
            const lines = textLines(element.content?.text, fontSize);
            const height = Math.max(22, Math.ceil(lines * fontSize * 1.3));
            const y = findY(height);
            if (y !== null) {
                placement = { y, height, fontSize };
                break;
            }
        }
        if (!placement) {
            const fontSize = 12;
            const height = 22;
            placement = { y: Math.max(start, end - height), height, fontSize };
        }

        element.x = left;
        element.y = placement.y;
        element.width = width;
        element.height = placement.height;
        element.style = {
            ...element.style,
            fontSize: placement.fontSize,
            fontWeight: 400,
            color: element.style?.color || template.definition?.theme?.colors?.text || template.theme?.colors?.text || '#344054',
            align: 'left',
            verticalAlign: 'middle',
            lineHeight: 1.3
        };
        if (layout.slotAnimations?.subtitle) {
            element.animation = { ...layout.slotAnimations.subtitle, delayMs: (layout.slotAnimations.subtitle.delayMs || 220) + 100 + index * 80 };
        }
        occupied.push({ x: left, y: placement.y, width, height: placement.height });
        placed.add(element);
    });
}

function reflowSlideElements(elements, layout, template, presentation) {
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
        }
        reflowCoverAgendaGroups(editable, placed, layout, template, subSlot);
        reflowCoverDescriptions(editable, placed, layout, template, subSlot, presentation);
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
                title.style = { ...title.style, fontSize: 24, fontWeight: 700, color: cColor, align: 'left', lineHeight: 1.3 };
                body.x = slot.x;
                body.y = slot.y + 46;
                body.width = slot.width;
                body.height = slot.height - 46;
                body.style = { ...body.style, fontSize: 18, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.6 };
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
                title.style = { ...title.style, fontSize: 24, fontWeight: 700, color: colColor, align: 'left', lineHeight: 1.3 };
                body.x = slot.x;
                body.y = slot.y + 48;
                body.width = slot.width;
                body.height = slot.height - 48;
                body.style = { ...body.style, fontSize: 18, fontWeight: 400, color: colors.text || '#344054', align: 'left', lineHeight: 1.6 };
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
            elements = reflowSlideElements(elements, layout, template, content);
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
        return { ...slide, layoutId: layout.id, background, transition: layout.defaultTransition?.type !== 'none' ? { ...layout.defaultTransition } : slide.transition, elements: [...templateLayerElements(template, layout, slideIndex, content), ...elements] };
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
