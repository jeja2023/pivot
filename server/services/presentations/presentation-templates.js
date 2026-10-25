'use strict';

const crypto = require('crypto');
const { canonicalJson } = require('../canonical-json');

const STANDARD_LAYOUTS = Object.freeze([
    { id: 'cover', name: '封面页', category: '封面', slots: ['title', 'subtitle'] },
    { id: 'section', name: '章节过渡页', category: '章节', slots: ['section', 'title'] },
    { id: 'title-content', name: '标题与正文', category: '内容', slots: ['title', 'body'] },
    { id: 'two-column', name: '双栏图文', category: '内容', slots: ['title', 'left', 'right'] },
    { id: 'three-card', name: '三栏卡片', category: '内容', slots: ['title', 'card1', 'card2', 'card3'] },
    { id: 'image-focus', name: '大图重点页', category: '内容', slots: ['title', 'image', 'caption'] },
    { id: 'chart', name: '数据图表页', category: '数据', slots: ['title', 'chart', 'insight'] },
    { id: 'table', name: '数据表格页', category: '数据', slots: ['title', 'table', 'insight'] },
    { id: 'quote', name: '引用重点页', category: '内容', slots: ['quote', 'attribution'] },
    { id: 'summary', name: '总结行动页', category: '总结', slots: ['title', 'summary', 'nextSteps'] }
]);

const THEME_SEEDS = Object.freeze([
    ['business-blue', '商务蓝汇报', '适用于项目阶段汇报、方案评审与经营复盘', '#1F5EA8', '#17A8C7', '#2E8B57', '#344054', '#F5F8FC', '#FFFFFF', '#D8E2EE', false, ['项目', '阶段汇报', '复盘']],
    ['forest-green', '森林绿简报', '适用于环保、健康与自然主题的内容分享与产品介绍', '#1E7A4C', '#3FA97C', '#D8A23A', '#2B3A31', '#F6FAF7', '#FFFFFF', '#D5E4DA', false, ['环保', '健康', '产品介绍']]
]);

function buildThemeMasters(colors, _isDark, useReferenceStyle = false, useForestStyle = false) {
    const { cardBorder, background, secondary, primary } = colors;
    return [
        {
            id: 'master_content',
            name: '标准内容母版',
            background: { fill: background },
            decorations: [
                ...(useForestStyle ? [
                    {
                        id: 'master_leaf_shadow',
                        type: 'shape',
                        shapeType: 'ellipse',
                        x: 1080,
                        y: 640,
                        width: 260,
                        height: 160,
                        rotation: -18,
                        zIndex: 0,
                        locked: true,
                        visible: true,
                        sourceRefs: [],
                        style: { fill: secondary, stroke: secondary, strokeWidth: 0, opacity: 0.08, radius: 80 }
                    },
                    {
                        id: 'master_corner_leaf',
                        type: 'shape',
                        shapeType: 'ellipse',
                        x: 1190,
                        y: 18,
                        width: 140,
                        height: 90,
                        rotation: -28,
                        zIndex: 0,
                        locked: true,
                        visible: true,
                        sourceRefs: [],
                        style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 0.05, radius: 45 }
                    }
                ] : []),
                ...(useReferenceStyle ? [{
                    id: 'master_header_band',
                    type: 'shape',
                    shapeType: 'rect',
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 21,
                    rotation: 0,
                    zIndex: 0,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: '#10233F', stroke: '#10233F', strokeWidth: 0, opacity: 1, radius: 0 }
                }] : []),
                {
                    id: 'master_footer_line',
                    type: 'shape',
                    shapeType: 'line',
                    x: 80,
                    y: 664,
                    width: 1120,
                    height: 1,
                    rotation: 0,
                    zIndex: 1,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { stroke: cardBorder, strokeWidth: 1, opacity: 0.7 }
                },
                ...(useForestStyle ? [{
                    id: 'master_footer_meta',
                    type: 'text',
                    x: 80,
                    y: 673,
                    width: 600,
                    height: 24,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    content: { text: '自然简报 · {{presentationTitle}}' },
                    style: { fontSize: 12, fontWeight: 500, color: '#7E9285', align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                }] : []),
                ...(useReferenceStyle ? [{
                    id: 'master_footer_title',
                    type: 'text',
                    x: 65,
                    y: 673,
                    width: 520,
                    height: 24,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    content: { text: '{{presentationTitle}}' },
                    style: { fontSize: 13, fontWeight: 400, color: '#98A2B3', align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                }] : [])
            ]
        },
        {
            id: 'master_cover',
            name: '标准封面母版',
            background: { fill: background },
            decorations: useReferenceStyle ? [
                {
                    id: 'cover_top_band', type: 'shape', shapeType: 'rect', x: 0, y: 0, width: 1280, height: 101,
                    rotation: 0, zIndex: 0, locked: true, visible: true, sourceRefs: [],
                    style: { fill: '#10233F', stroke: '#10233F', strokeWidth: 0, opacity: 1, radius: 0 }
                },
                {
                    id: 'cover_bottom_band', type: 'shape', shapeType: 'rect', x: 0, y: 667, width: 1280, height: 53,
                    rotation: 0, zIndex: 0, locked: true, visible: true, sourceRefs: [],
                    style: { fill: '#10233F', stroke: '#10233F', strokeWidth: 0, opacity: 1, radius: 0 }
                }
            ] : []
        }
    ];
}

function applyForestGreenLayoutStyles(layouts, colors) {
    const { primary, secondary, accent, text, cardBg, cardBorder, background, cardPalette } = colors;
    const leafShape = (id, bounds, fill, opacity = 1, rotation = 0, zIndex = 2) => ({
        id, type: 'shape', shapeType: 'ellipse', ...bounds, rotation, zIndex, locked: true, visible: true, sourceRefs: [],
        style: { fill, stroke: fill, strokeWidth: 0, opacity, radius: Math.round(Math.min(100, Math.min(bounds.width, bounds.height) / 2)) }
    });
    const leafMark = (id, x, y) => [
        leafShape(`${id}_a`, { x, y, width: 16, height: 10 }, secondary, 1, -24, 2),
        leafShape(`${id}_b`, { x: x + 9, y: y + 6, width: 12, height: 8 }, accent, 1, -24, 2)
    ];
    const rule = (id, bounds, color, opacity = 1, strokeWidth = 1) => ({
        id, type: 'shape', shapeType: 'line', ...bounds, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [],
        style: { stroke: color, strokeWidth, opacity }
    });
    const pill = (id, bounds, fill, stroke = fill, radius = 14, zIndex = 2, opacity = 1) => ({
        id, type: 'shape', shapeType: 'roundRect', ...bounds, rotation: 0, zIndex, locked: true, visible: true, sourceRefs: [],
        style: { fill, stroke, strokeWidth: stroke === fill ? 0 : 1, opacity, radius }
    });
    const tagText = (id, bounds, textContent, color, fontSize = 11, align = 'center', zIndex = 3) => ({
        id, type: 'text', ...bounds, rotation: 0, zIndex, locked: true, visible: true, sourceRefs: [],
        content: { text: textContent },
        style: { fontSize, fontWeight: 700, color, align, verticalAlign: 'middle', lineHeight: 1 }
    });
    const byId = (layout, slotId) => layout.placeholders.find(slot => slot.id === slotId);

    return layouts.map(layout => {
        if (layout.id === 'cover') {
            const palette = cardPalette || [primary, secondary, '#52B788', accent, '#C97A56', '#74A892'];
            const nav = Array.from({ length: 5 }, (_, index) => {
                const x = 420 + index * 159;
                const color = palette[index % palette.length];
                return [
                    {
                        id: `cover_nav_pill_${index + 1}`, type: 'shape', shapeType: 'roundRect', x, y: 326, width: 144, height: 42, rotation: 0,
                        zIndex: 2, locked: true, visible: true, sourceRefs: [],
                        style: { fill: '#F2F8F4', stroke: color, strokeWidth: 1.5, opacity: 1, radius: 21 }
                    },
                    leafShape(`cover_nav_dot_${index + 1}`, { x: x + 12, y: 342, width: 10, height: 10 }, color, 1, 0, 3),
                    {
                        id: `cover_nav_label_${index + 1}`, type: 'text', x: x + 24, y: 332, width: 112, height: 30, rotation: 0,
                        zIndex: 3, locked: true, visible: true, sourceRefs: [], content: { text: `{{coverSection${index + 1}}}` },
                        style: { fontSize: 13, fontWeight: 700, color: '#1B4A33', align: 'center', verticalAlign: 'middle', lineHeight: 1.15 }
                    }
                ];
            }).flat();
            return {
                ...layout,
                decorations: [
                    { id: 'cover_side_band', type: 'shape', shapeType: 'roundRect', x: 0, y: 0, width: 320, height: 720, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: '#164E33', stroke: '#164E33', strokeWidth: 0, opacity: 1, radius: 0 } },
                    leafShape('cover_leaf_big', { x: -20, y: 430, width: 270, height: 210 }, secondary, 0.35, -24, 2),
                    leafShape('cover_leaf_mid', { x: 140, y: 550, width: 190, height: 130 }, '#F6FAF7', 0.22, -18, 3),
                    leafShape('cover_leaf_small', { x: 60, y: 80, width: 90, height: 56 }, accent, 0.5, -20, 4),

                    pill('cover_kicker_badge', { x: 420, y: 88, width: 172, height: 30 }, '#EBF5EF', '#C5DFCC', 15, 2),
                    leafShape('cover_kicker_dot', { x: 434, y: 98, width: 10, height: 10 }, accent, 1, 0, 3),
                    tagText('cover_kicker_text', { x: 450, y: 90, width: 132, height: 26 }, '专题简报 · BRIEFING', '#1B4A33', 12, 'left', 3),

                    pill('cover_nav_panel', { x: 420, y: 318, width: 780, height: 58 }, '#F6FAF7', cardBorder, 14, 1),
                    ...nav,
                    rule('cover_baseline', { x: 420, y: 570, width: 780, height: 1 }, cardBorder, 0.9, 1),
                    {
                        id: 'cover_meta', type: 'text', x: 420, y: 588, width: 780, height: 28, rotation: 0,
                        zIndex: 2, locked: true, visible: true, sourceRefs: [], content: { text: '{{presentationTitle}} · 自然生态特辑 · 绿色主题分享' },
                        style: { fontSize: 13, fontWeight: 500, color: '#385243', align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                    }
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 420, y: 142, width: 780, height: 84, style: { ...byId(layout, 'slot_title').style, fontSize: 48, fontWeight: 800, color: '#143826', align: 'left', verticalAlign: 'middle', lineHeight: 1.25 } },
                    { ...byId(layout, 'slot_subtitle'), x: 420, y: 244, width: 780, height: 48, style: { ...byId(layout, 'slot_subtitle').style, fontSize: 21, fontWeight: 600, color: '#2D6A4F', align: 'left', verticalAlign: 'middle', lineHeight: 1.4 } }
                ]
            };
        }

        if (layout.id === 'section') {
            return {
                ...layout,
                decorations: [
                    { id: 'section_full_band', type: 'shape', shapeType: 'roundRect', x: 0, y: 0, width: 1280, height: 720, rotation: 0, zIndex: 0, locked: true, visible: true, sourceRefs: [], style: { fill: '#143D28', stroke: '#143D28', strokeWidth: 0, opacity: 1, radius: 0 } },
                    leafShape('section_leaf_glow', { x: 880, y: 50, width: 400, height: 320 }, secondary, 0.32, -16, 1),
                    leafShape('section_leaf_deep', { x: 50, y: 510, width: 280, height: 180 }, '#0D2B1B', 0.65, -22, 1),
                    leafShape('section_leaf_sun', { x: 1060, y: 440, width: 180, height: 120 }, accent, 0.25, 24, 1),
                    pill('section_badge', { x: 120, y: 180, width: 180, height: 32 }, '#FFFFFF', '#FFFFFF', 16, 2, 0.16),
                    leafShape('section_badge_dot', { x: 134, y: 191, width: 10, height: 10 }, accent, 1, 0, 3),
                    tagText('section_kicker', { x: 150, y: 182, width: 140, height: 28 }, 'CHAPTER 专题章节', '#D5EFE0', 12, 'left', 3)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_section'), x: 120, y: 236, width: 950, height: 40, style: { ...byId(layout, 'slot_section').style, fontSize: 17, color: '#9CD7B7', fontWeight: 600 } },
                    { ...byId(layout, 'slot_title'), x: 120, y: 292, width: 950, height: 190, style: { ...byId(layout, 'slot_title').style, fontSize: 46, fontWeight: 800, color: '#FFFFFF', lineHeight: 1.25 } }
                ]
            };
        }

        if (layout.id === 'title-content') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('content_leaf', 80, 60),
                    rule('content_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('content_card_frame', { x: 80, y: 145, width: 1120, height: 495 }, cardBg, cardBorder, 18, 1),
                    pill('content_top_accent', { x: 112, y: 145, width: 72, height: 4 }, primary, primary, 2, 2)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_body'), x: 116, y: 175, width: 1048, height: 435, style: { ...byId(layout, 'slot_body').style, fontSize: 18, lineHeight: 1.8, color: '#2B3A31' } }
                ]
            };
        }

        if (layout.id === 'two-column') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('twocol_leaf', 80, 60),
                    rule('twocol_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('twocol_card_left', { x: 80, y: 145, width: 544, height: 495 }, '#F8FBF9', cardBorder, 18, 1),
                    pill('twocol_badge_left', { x: 108, y: 168, width: 110, height: 26 }, '#E0EFE5', '#C5DFCC', 13, 2),
                    tagText('twocol_badge_text_left', { x: 114, y: 170, width: 98, height: 22 }, '议题洞察 01', primary, 11, 'center', 3),

                    pill('twocol_card_right', { x: 656, y: 145, width: 544, height: 495 }, '#FAFBF8', cardBorder, 18, 1),
                    pill('twocol_badge_right', { x: 684, y: 168, width: 110, height: 26 }, '#F7EEDC', '#E8D5B5', 13, 2),
                    tagText('twocol_badge_text_right', { x: 690, y: 170, width: 98, height: 22 }, '实践方案 02', '#B57E1E', 11, 'center', 3)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_left'), x: 108, y: 212, width: 488, height: 400, style: { ...byId(layout, 'slot_left').style, fontSize: 17, lineHeight: 1.8, color: '#2B3A31' } },
                    { ...byId(layout, 'slot_right'), x: 684, y: 212, width: 488, height: 400, style: { ...byId(layout, 'slot_right').style, fontSize: 17, lineHeight: 1.8, color: '#2B3A31' } }
                ]
            };
        }

        if (layout.id === 'three-card') {
            const columns = [
                { x: 80, badgeBg: '#E0EFE5', badgeBorder: '#C5DFCC', dot: primary, badgeText: '核心洞察', textColor: primary },
                { x: 464, badgeBg: '#E3F3EA', badgeBorder: '#C3E2CF', dot: secondary, badgeText: '策略路径', textColor: '#2D7A54' },
                { x: 848, badgeBg: '#F7EEDC', badgeBorder: '#E8D5B5', dot: accent, badgeText: '预期成果', textColor: '#B57E1E' }
            ];
            return {
                ...layout,
                decorations: [
                    ...leafMark('threecard_leaf', 80, 60),
                    rule('threecard_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    ...columns.flatMap((col, index) => [
                        pill(`threecard_card_${index + 1}`, { x: col.x, y: 145, width: 352, height: 495 }, '#FFFFFF', cardBorder, 18, 1),
                        pill(`threecard_badge_${index + 1}`, { x: col.x + 24, y: 168, width: 100, height: 26 }, col.badgeBg, col.badgeBorder, 13, 2),
                        tagText(`threecard_badge_text_${index + 1}`, { x: col.x + 28, y: 170, width: 92, height: 22 }, col.badgeText, col.textColor, 11, 'center', 3)
                    ])
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    ...['slot_card1', 'slot_card2', 'slot_card3'].map((slotId, index) => ({
                        ...byId(layout, slotId), x: columns[index].x + 24, y: 212, width: 304, height: 400,
                        style: { ...byId(layout, slotId).style, fontSize: 16, lineHeight: 1.75, color: '#2B3A31' }
                    }))
                ]
            };
        }

        if (layout.id === 'image-focus') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('img_leaf', 80, 60),
                    rule('img_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('img_callout_box', { x: 80, y: 145, width: 440, height: 495 }, '#F6FAF7', cardBorder, 18, 1),
                    pill('img_callout_badge', { x: 104, y: 168, width: 104, height: 26 }, '#E0EFE5', '#C5DFCC', 13, 2),
                    tagText('img_callout_tag', { x: 108, y: 170, width: 96, height: 22 }, '图文聚焦', primary, 11, 'center', 3),
                    pill('img_frame', { x: 550, y: 145, width: 650, height: 495 }, '#EBF3EE', cardBorder, 20, 1),
                    leafShape('img_leaf_corner', { x: 1140, y: 600, width: 120, height: 80 }, secondary, 0.35, -20, 2)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_caption'), x: 104, y: 212, width: 392, height: 400, style: { ...byId(layout, 'slot_caption').style, fontSize: 17, lineHeight: 1.8, color: '#2B3A31' } },
                    { ...byId(layout, 'slot_image'), x: 575, y: 170, width: 600, height: 445 }
                ]
            };
        }

        if (layout.id === 'chart') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('chart_leaf', 80, 60),
                    rule('chart_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('chart_frame', { x: 80, y: 145, width: 1120, height: 395 }, cardBg, cardBorder, 18, 1),
                    pill('chart_insight_band', { x: 80, y: 556, width: 1120, height: 84 }, '#EAF4EE', cardBorder, 14, 1),
                    leafShape('chart_band_dot', { x: 104, y: 588, width: 14, height: 14 }, accent, 1, 0, 2),
                    tagText('chart_band_label', { x: 128, y: 566, width: 120, height: 20 }, '简报洞察结论', primary, 11, 'left', 3)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_chart'), x: 110, y: 165, width: 1060, height: 355 },
                    { ...byId(layout, 'slot_insight'), x: 128, y: 586, width: 1040, height: 46, style: { ...byId(layout, 'slot_insight').style, fontSize: 15, lineHeight: 1.5, verticalAlign: 'middle', color: '#1E4D34' } }
                ]
            };
        }

        if (layout.id === 'table') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('table_leaf', 80, 60),
                    rule('table_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('table_header_band', { x: 80, y: 140, width: 1120, height: 54 }, primary, primary, 12, 1),
                    pill('table_body_frame', { x: 80, y: 202, width: 1120, height: 438 }, cardBg, cardBorder, 14, 1)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_insight'), x: 104, y: 148, width: 1072, height: 38, style: { ...byId(layout, 'slot_insight').style, fontSize: 15, color: '#FFFFFF', verticalAlign: 'middle', fontWeight: 600 } },
                    { ...byId(layout, 'slot_table'), x: 96, y: 216, width: 1088, height: 410 }
                ]
            };
        }

        if (layout.id === 'quote') {
            return {
                ...layout,
                decorations: [
                    leafShape('quote_leaf_big', { x: 120, y: 110, width: 150, height: 100 }, secondary, 0.32, -24, 1),
                    leafShape('quote_leaf_small', { x: 1030, y: 520, width: 130, height: 80 }, accent, 0.35, -18, 1),
                    {
                        id: 'quote_mark', type: 'text', x: 150, y: 140, width: 120, height: 90, rotation: 0,
                        zIndex: 2, locked: true, visible: true, sourceRefs: [], content: { text: '"' },
                        style: { fontSize: 76, fontWeight: 800, color: '#1E7A4C', align: 'left', verticalAlign: 'top', lineHeight: 1 }
                    },
                    pill('quote_attribution_pill', { x: 180, y: 512, width: 920, height: 56 }, '#EAF4EE', cardBorder, 20, 1)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_quote'), x: 180, y: 220, width: 920, height: 260, style: { ...byId(layout, 'slot_quote').style, fontSize: 26, fontWeight: 600, color: '#143826', align: 'center', verticalAlign: 'middle', lineHeight: 1.65 } },
                    { ...byId(layout, 'slot_attribution'), x: 200, y: 516, width: 880, height: 48, style: { ...byId(layout, 'slot_attribution').style, fontSize: 15, fontWeight: 500, color: '#1B4A33', align: 'center', verticalAlign: 'middle', lineHeight: 1.4 } }
                ]
            };
        }

        if (layout.id === 'summary') {
            return {
                ...layout,
                decorations: [
                    ...leafMark('summary_leaf', 80, 60),
                    rule('summary_rule', { x: 80, y: 116, width: 1120, height: 1 }, cardBorder, 1, 2),
                    pill('summary_band_1', { x: 80, y: 145, width: 1120, height: 235 }, '#EAF4EE', cardBorder, 18, 1),
                    pill('summary_tag_1', { x: 108, y: 166, width: 110, height: 26 }, '#D2EAD9', '#BFE0C8', 13, 2),
                    tagText('summary_tag_text_1', { x: 114, y: 168, width: 98, height: 22 }, '核心总结速览', primary, 11, 'center', 3),

                    pill('summary_band_2', { x: 80, y: 400, width: 1120, height: 245 }, primary, primary, 18, 1),
                    pill('summary_tag_2', { x: 108, y: 420, width: 110, height: 26 }, '#164E33', '#164E33', 13, 2),
                    tagText('summary_tag_text_2', { x: 114, y: 422, width: 98, height: 22 }, '下一步行动建议', '#C2E8D2', 11, 'center', 3)
                ],
                placeholders: [
                    { ...byId(layout, 'slot_title'), x: 116, y: 48, width: 1084, height: 60, style: { ...byId(layout, 'slot_title').style, fontSize: 32, fontWeight: 700, color: '#143826' } },
                    { ...byId(layout, 'slot_summary'), x: 116, y: 202, width: 1048, height: 155, style: { ...byId(layout, 'slot_summary').style, fontSize: 17, lineHeight: 1.75, color: '#2B3A31' } },
                    { ...byId(layout, 'slot_nextSteps'), x: 116, y: 456, width: 1048, height: 165, style: { ...byId(layout, 'slot_nextSteps').style, fontSize: 23, fontWeight: 700, color: '#FFFFFF', lineHeight: 1.5 } }
                ]
            };
        }

        return layout;
    });
}

function buildThemeLayouts(colors, _isDark) {
    const { primary, secondary, accent, text, cardBg, cardBorder } = colors;
    return [
        {
            id: 'cover',
            name: '封面页',
            category: '封面',
            slots: ['title', 'subtitle'],
            masterId: 'master_cover',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 500, delayMs: 80, direction: '' },
                subtitle: { type: 'fly', durationMs: 500, delayMs: 220, direction: '' }
            },
            decorations: [
                {
                    id: 'cover_card',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 60,
                    y: 50,
                    width: 1160,
                    height: 620,
                    rotation: 0,
                    zIndex: 1,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 24 }
                },
                {
                    id: 'cover_pill_bg',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 100,
                    y: 96,
                    width: 206,
                    height: 30,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 0.12, radius: 15 }
                },
                {
                    id: 'cover_pill_dot',
                    type: 'shape',
                    shapeType: 'ellipse',
                    x: 112,
                    y: 107,
                    width: 8,
                    height: 8,
                    rotation: 0,
                    zIndex: 3,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 4 }
                },
                {
                    id: 'cover_pill_text',
                    type: 'text',
                    x: 126,
                    y: 96,
                    width: 174,
                    height: 30,
                    rotation: 0,
                    zIndex: 3,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    content: { text: '团队关怀 / 节日寄语' },
                    style: { fontSize: 13, fontWeight: 700, color: primary, align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                },
                {
                    id: 'cover_divider',
                    type: 'shape',
                    shapeType: 'line',
                    x: 100,
                    y: 540,
                    width: 1080,
                    height: 1,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { stroke: cardBorder, strokeWidth: 1, opacity: 0.6 }
                },
                {
                    id: 'cover_footer_meta',
                    type: 'text',
                    x: 100,
                    y: 556,
                    width: 1080,
                    height: 30,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    content: { text: '汇报组织：团队管理部   |   适用场景：全员与部门沟通   |   2026年·中秋特辑' },
                    style: { fontSize: 13, fontWeight: 500, color: '#94A3B8', align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                }
            ],
            placeholders: [
                {
                    id: 'slot_title',
                    role: 'title',
                    kind: 'text',
                    x: 100,
                    y: 175,
                    width: 1080,
                    height: 135,
                    rotation: 0,
                    style: { fontSize: 46, fontWeight: 800, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.25 },
                    required: true
                },
                {
                    id: 'slot_subtitle',
                    role: 'subtitle',
                    kind: 'text',
                    x: 100,
                    y: 330,
                    width: 1080,
                    height: 56,
                    rotation: 0,
                    style: { fontSize: 22, fontWeight: 500, color: primary, align: 'left', verticalAlign: 'middle', lineHeight: 1.4 },
                    required: false
                }
            ]
        },
        {
            id: 'section',
            name: '章节过渡页',
            category: '章节',
            slots: ['section', 'title'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                section: { type: 'fade', durationMs: 400, delayMs: 80, direction: '' },
                title: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' }
            },
            decorations: [
                {
                    id: 'section_card',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 120,
                    y: 160,
                    width: 1040,
                    height: 400,
                    rotation: 0,
                    zIndex: 1,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 16 }
                },
                {
                    id: 'section_bar',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 120,
                    y: 160,
                    width: 8,
                    height: 400,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 4 }
                }
            ],
            placeholders: [
                { id: 'slot_section', role: 'section', kind: 'text', x: 160, y: 200, width: 950, height: 40, rotation: 0, style: { fontSize: 16, fontWeight: 700, color: primary, align: 'left', verticalAlign: 'middle' }, required: false },
                { id: 'slot_title', role: 'title', kind: 'text', x: 160, y: 260, width: 950, height: 180, rotation: 0, style: { fontSize: 40, fontWeight: 800, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.25 }, required: true }
            ]
        },
        {
            id: 'title-content',
            name: '标题与正文',
            category: '内容',
            slots: ['title', 'body'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                body: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' }
            },
            decorations: [
                {
                    id: 'title_bar',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 80,
                    y: 56,
                    width: 5,
                    height: 44,
                    rotation: 0,
                    zIndex: 2,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 }
                },
                {
                    id: 'content_card',
                    type: 'shape',
                    shapeType: 'roundRect',
                    x: 80,
                    y: 135,
                    width: 1120,
                    height: 505,
                    rotation: 0,
                    zIndex: 1,
                    locked: true,
                    visible: true,
                    sourceRefs: [],
                    style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 }
                }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_body', role: 'body', kind: 'text', x: 116, y: 165, width: 1048, height: 445, rotation: 0, style: { fontSize: 18, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.65 }, required: false }
            ]
        },
        {
            id: 'two-column',
            name: '双栏图文',
            category: '内容',
            slots: ['title', 'left', 'right'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                left: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' },
                right: { type: 'fly', durationMs: 500, delayMs: 320, direction: '' }
            },
            decorations: [
                { id: 'two_col_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'two_col_card_left', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 544, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'two_col_bar_left', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 544, height: 5, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'two_col_card_right', type: 'shape', shapeType: 'roundRect', x: 656, y: 135, width: 544, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'two_col_bar_right', type: 'shape', shapeType: 'roundRect', x: 656, y: 135, width: 544, height: 5, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: secondary, stroke: secondary, strokeWidth: 0, opacity: 1, radius: 3 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_left', role: 'left', kind: 'text', x: 108, y: 165, width: 488, height: 445, rotation: 0, style: { fontSize: 17, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.95 }, required: false },
                { id: 'slot_right', role: 'right', kind: 'text', x: 684, y: 165, width: 488, height: 445, rotation: 0, style: { fontSize: 17, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.95 }, required: false }
            ]
        },
        {
            id: 'three-card',
            name: '三栏卡片',
            category: '内容',
            slots: ['title', 'card1', 'card2', 'card3'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                card1: { type: 'fly', durationMs: 480, delayMs: 160, direction: '' },
                card2: { type: 'fly', durationMs: 480, delayMs: 280, direction: '' },
                card3: { type: 'fly', durationMs: 480, delayMs: 400, direction: '' }
            },
            decorations: [
                { id: 'three_card_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'three_card_1', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 352, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'three_bar_1', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 352, height: 5, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'three_card_2', type: 'shape', shapeType: 'roundRect', x: 464, y: 135, width: 352, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'three_bar_2', type: 'shape', shapeType: 'roundRect', x: 464, y: 135, width: 352, height: 5, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: secondary, stroke: secondary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'three_card_3', type: 'shape', shapeType: 'roundRect', x: 848, y: 135, width: 352, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'three_bar_3', type: 'shape', shapeType: 'roundRect', x: 848, y: 135, width: 352, height: 5, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: accent, stroke: accent, strokeWidth: 0, opacity: 1, radius: 3 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_card1', role: 'card1', kind: 'text', x: 104, y: 165, width: 304, height: 445, rotation: 0, style: { fontSize: 16, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.6 }, required: false },
                { id: 'slot_card2', role: 'card2', kind: 'text', x: 488, y: 165, width: 304, height: 445, rotation: 0, style: { fontSize: 16, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.6 }, required: false },
                { id: 'slot_card3', role: 'card3', kind: 'text', x: 872, y: 165, width: 304, height: 445, rotation: 0, style: { fontSize: 16, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.6 }, required: false }
            ]
        },
        {
            id: 'image-focus',
            name: '大图重点页',
            category: '内容',
            slots: ['title', 'caption', 'image'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                caption: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' },
                image: { type: 'zoom', durationMs: 500, delayMs: 300, direction: '' }
            },
            decorations: [
                { id: 'img_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'img_card_left', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 440, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'img_frame_right', type: 'shape', shapeType: 'roundRect', x: 550, y: 135, width: 650, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_caption', role: 'caption', kind: 'text', x: 108, y: 165, width: 384, height: 445, rotation: 0, style: { fontSize: 17, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.65 }, required: false },
                { id: 'slot_image', role: 'image', kind: 'image', x: 570, y: 155, width: 610, height: 465, rotation: 0, style: {}, required: false }
            ]
        },
        {
            id: 'chart',
            name: '数据图表页',
            category: '数据',
            slots: ['title', 'insight', 'chart'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                insight: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' },
                chart: { type: 'zoom', durationMs: 500, delayMs: 300, direction: '' }
            },
            decorations: [
                { id: 'chart_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'chart_card_left', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 360, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'chart_bar_left', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 5, height: 505, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'chart_card_right', type: 'shape', shapeType: 'roundRect', x: 470, y: 135, width: 730, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_insight', role: 'insight', kind: 'text', x: 108, y: 165, width: 304, height: 445, rotation: 0, style: { fontSize: 16, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.65 }, required: false },
                { id: 'slot_chart', role: 'chart', kind: 'chart', x: 495, y: 155, width: 680, height: 465, rotation: 0, style: {}, required: false }
            ]
        },
        {
            id: 'table',
            name: '数据表格页',
            category: '数据',
            slots: ['title', 'insight', 'table'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                insight: { type: 'fly', durationMs: 450, delayMs: 160, direction: '' },
                table: { type: 'fade', durationMs: 500, delayMs: 280, direction: '' }
            },
            decorations: [
                { id: 'table_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'table_card_top', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 1120, height: 65, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 10 } },
                { id: 'table_card_bottom', type: 'shape', shapeType: 'roundRect', x: 80, y: 215, width: 1120, height: 425, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 12 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_insight', role: 'insight', kind: 'text', x: 108, y: 150, width: 1064, height: 36, rotation: 0, style: { fontSize: 17, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle' }, required: false },
                { id: 'slot_table', role: 'table', kind: 'table', x: 96, y: 230, width: 1088, height: 395, rotation: 0, style: {}, required: false }
            ]
        },
        {
            id: 'quote',
            name: '引用重点页',
            category: '内容',
            slots: ['title', 'quote', 'attribution'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                quote: { type: 'zoom', durationMs: 500, delayMs: 120, direction: '' },
                attribution: { type: 'fade', durationMs: 450, delayMs: 300, direction: '' }
            },
            decorations: [
                { id: 'quote_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'quote_card_center', type: 'shape', shapeType: 'roundRect', x: 140, y: 135, width: 1000, height: 505, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 20 } },
                { id: 'quote_card_bar', type: 'shape', shapeType: 'roundRect', x: 140, y: 135, width: 6, height: 505, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle' }, required: false },
                { id: 'slot_quote', role: 'quote', kind: 'text', x: 190, y: 200, width: 900, height: 260, rotation: 0, style: { fontSize: 28, fontWeight: 600, color: text, align: 'center', verticalAlign: 'middle', lineHeight: 1.65 }, required: true },
                { id: 'slot_attribution', role: 'attribution', kind: 'text', x: 340, y: 490, width: 600, height: 50, rotation: 0, style: { fontSize: 18, color: primary, align: 'center', verticalAlign: 'middle' }, required: false }
            ]
        },
        {
            id: 'summary',
            name: '总结行动页',
            category: '总结',
            slots: ['title', 'summary', 'nextSteps'],
            masterId: 'master_content',
            defaultTransition: { type: 'fade', durationMs: 400, direction: '' },
            slotAnimations: {
                title: { type: 'fly', durationMs: 450, delayMs: 50, direction: '' },
                summary: { type: 'fly', durationMs: 500, delayMs: 180, direction: '' },
                nextSteps: { type: 'fly', durationMs: 500, delayMs: 340, direction: '' }
            },
            decorations: [
                { id: 'summary_title_bar', type: 'shape', shapeType: 'roundRect', x: 80, y: 56, width: 5, height: 44, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 3 } },
                { id: 'summary_card_1', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 1120, height: 235, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'summary_bar_1', type: 'shape', shapeType: 'roundRect', x: 80, y: 135, width: 6, height: 235, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: primary, stroke: primary, strokeWidth: 0, opacity: 1, radius: 4 } },
                { id: 'summary_card_2', type: 'shape', shapeType: 'roundRect', x: 80, y: 395, width: 1120, height: 245, rotation: 0, zIndex: 1, locked: true, visible: true, sourceRefs: [], style: { fill: cardBg, stroke: cardBorder, strokeWidth: 1, opacity: 1, radius: 14 } },
                { id: 'summary_bar_2', type: 'shape', shapeType: 'roundRect', x: 80, y: 395, width: 6, height: 245, rotation: 0, zIndex: 2, locked: true, visible: true, sourceRefs: [], style: { fill: secondary, stroke: secondary, strokeWidth: 0, opacity: 1, radius: 4 } }
            ],
            placeholders: [
                { id: 'slot_title', role: 'title', kind: 'text', x: 100, y: 50, width: 1096, height: 56, rotation: 0, style: { fontSize: 32, fontWeight: 700, color: text, align: 'left', verticalAlign: 'middle', lineHeight: 1.3 }, required: true },
                { id: 'slot_summary', role: 'summary', kind: 'text', x: 115, y: 160, width: 1050, height: 185, rotation: 0, style: { fontSize: 18, color: text, align: 'left', verticalAlign: 'top', lineHeight: 1.8 }, required: false },
                { id: 'slot_nextSteps', role: 'nextSteps', kind: 'text', x: 115, y: 420, width: 1050, height: 195, rotation: 0, style: { fontSize: 24, fontWeight: 700, color: primary, align: 'center', verticalAlign: 'middle', lineHeight: 1.5 }, required: false }
            ]
        }
    ];
}

function applyReferenceLayoutStyles(layouts, colors) {
    const titleBounds = { x: 82, y: 46, width: 1128, height: 48 };
    const chapterPalette = colors.cardPalette || [colors.primary, colors.secondary, colors.accent, '#D8A23A', '#7A5AF8'];
    const templateShape = (id, shapeType, bounds, fill, stroke = fill, radius = 0, zIndex = 1) => ({
        id, type: 'shape', shapeType, ...bounds, rotation: 0, zIndex, locked: true, visible: true, sourceRefs: [],
        style: { fill, stroke, strokeWidth: stroke === fill ? 0 : 1, opacity: 1, radius }
    });
    const titleMarker = () => templateShape('reference_title_marker', 'roundRect', { x: 62, y: 56, width: 12, height: 44 }, '#17A8C7', '#17A8C7', 3, 2);

    return layouts.map(layout => {
        if (layout.id === 'cover') {
            const nav = Array.from({ length: 5 }, (_, index) => {
                const x = 96 + index * 216;
                const color = chapterPalette[index % chapterPalette.length];
                return [
                    templateShape(`cover_nav_pill_${index + 1}`, 'roundRect', { x, y: 416, width: 198, height: 50 }, color, color, 5, 2),
                    {
                        id: `cover_nav_label_${index + 1}`, type: 'text', x: x + 8, y: 424, width: 182, height: 34, rotation: 0,
                        zIndex: 3, locked: true, visible: true, sourceRefs: [], content: { text: `{{coverSection${index + 1}}}` },
                        style: { fontSize: 17, fontWeight: 700, color: '#FFFFFF', align: 'center', verticalAlign: 'middle', lineHeight: 1.15 }
                    }
                ];
            }).flat();
            return {
                ...layout,
                decorations: [
                    templateShape('cover_accent_line', 'rect', { x: 53, y: 149, width: 106, height: 10 }, '#17A8C7', '#17A8C7', 0, 2),
                    templateShape('cover_nav_panel', 'roundRect', { x: 72, y: 384, width: 1138, height: 120 }, colors.cardBg, colors.cardBorder, 8, 1),
                    ...nav,
                    {
                        id: 'cover_footer_meta', type: 'text', x: 72, y: 630, width: 1136, height: 26, rotation: 0,
                        zIndex: 2, locked: true, visible: true, sourceRefs: [], content: { text: '阶段性汇报 · {{presentationTitle}}' },
                        style: { fontSize: 13, fontWeight: 500, color: '#667085', align: 'left', verticalAlign: 'middle', lineHeight: 1 }
                    }
                ],
                placeholders: layout.placeholders.map(slot => slot.role === 'title'
                    ? { ...slot, x: 72, y: 175, width: 1136, height: 96, style: { ...slot.style, fontSize: 49, fontWeight: 800, color: '#10233F', align: 'left', verticalAlign: 'middle', lineHeight: 1.2 } }
                    : slot.role === 'subtitle'
                        ? { ...slot, x: 72, y: 276, width: 1136, height: 68, style: { ...slot.style, fontSize: 27, fontWeight: 500, color: '#475467', align: 'left', verticalAlign: 'middle', lineHeight: 1.35 } }
                        : slot)
            };
        }

        let decorations = layout.decorations.map(element => {
            if (/(?:^|_)title_bar$/.test(element.id || '')) {
                return { ...element, ...titleMarker(), id: element.id };
            }
            return element;
        });
        let placeholders = layout.placeholders.map(slot => slot.role === 'title'
            ? { ...slot, ...titleBounds, style: { ...slot.style, fontSize: 32, fontWeight: 700, color: '#10233F', align: 'left', verticalAlign: 'middle', lineHeight: 1.25 } }
            : slot);

        if (layout.id === 'title-content') {
            decorations = decorations.map(element => element.id === 'content_card'
                ? { ...element, x: 72, y: 149, width: 1136, height: 437 }
                : element);
            placeholders = placeholders.map(slot => slot.role === 'body'
                ? { ...slot, x: 100, y: 165, width: 1080, height: 400, style: { ...slot.style, fontSize: 18, color: '#344054', align: 'left', verticalAlign: 'top', lineHeight: 1.65 } }
                : slot);
        }

        if (layout.id === 'two-column') {
            const columns = { left: { x: 72, color: chapterPalette[0] }, right: { x: 664, color: chapterPalette[1] } };
            decorations = decorations.map(element => {
                const card = element.id.match(/^two_col_card_(left|right)$/);
                const bar = element.id.match(/^two_col_bar_(left|right)$/);
                if (card) return { ...element, x: columns[card[1]].x, y: 149, width: 544, height: 437 };
                if (bar) return { ...element, x: columns[bar[1]].x, y: 149, width: 10, height: 437, style: { ...element.style, fill: columns[bar[1]].color, stroke: columns[bar[1]].color } };
                return element;
            });
            placeholders = placeholders.map(slot => ['left', 'right'].includes(slot.role)
                ? { ...slot, x: columns[slot.role].x + 24, y: 162, width: 496, height: 408, style: { ...slot.style, fontSize: 18, color: '#344054', align: 'left', verticalAlign: 'top', lineHeight: 1.6 } }
                : slot);
        }

        if (layout.id === 'three-card') {
            const cards = [
                { id: 1, x: 72, role: 'card1', color: chapterPalette[0] },
                { id: 2, x: 466, role: 'card2', color: chapterPalette[1] },
                { id: 3, x: 860, role: 'card3', color: chapterPalette[3] }
            ];
            decorations = decorations.map(element => {
                const card = element.id.match(/^three_card_(\d)$/);
                const bar = element.id.match(/^three_bar_(\d)$/);
                if (card) {
                    const item = cards[Number(card[1]) - 1];
                    return { ...element, x: item.x, y: 149, width: 370, height: 437 };
                }
                if (bar) {
                    const item = cards[Number(bar[1]) - 1];
                    return { ...element, x: item.x, y: 149, width: 10, height: 437, style: { ...element.style, fill: item.color, stroke: item.color } };
                }
                return element;
            });
            placeholders = placeholders.map(slot => {
                const card = cards.find(item => item.role === slot.role);
                return card ? { ...slot, x: card.x + 24, y: 162, width: 322, height: 408, style: { ...slot.style, fontSize: 18, color: '#344054', align: 'left', verticalAlign: 'top', lineHeight: 1.6 } } : slot;
            });
        }

        return { ...layout, decorations, placeholders };
    });
}

function makeTemplate(seed) {
    const [id, name, description, primary, secondary, accent, text, background, cardBg, cardBorder, isDark, tags] = seed;
    const isForest = id === 'forest-green';
    const cardPalette = isForest ? [
        primary,
        secondary,
        '#52B788',
        accent,
        '#C97A56',
        '#74A892'
    ] : [
        primary,
        secondary,
        accent,
        '#D8A23A',
        '#7A5AF8',
        '#C84A4A'
    ];
    const colors = { primary, secondary, accent, text, background, cardBg, cardBorder, cardPalette };
    const theme = {
        name,
        colors,
        fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
        chartPalette: cardPalette
    };
    const useReferenceStyle = id === 'business-blue';
    const useForestStyle = id === 'forest-green';
    const masters = buildThemeMasters(colors, isDark, useReferenceStyle, useForestStyle);
    const baseLayouts = buildThemeLayouts(colors, isDark);
    const layouts = useReferenceStyle ? applyReferenceLayoutStyles(baseLayouts, colors)
        : useForestStyle ? applyForestGreenLayoutStyles(baseLayouts, colors)
            : baseLayouts;
    const snapshotDigest = crypto.createHash('sha256').update(canonicalJson({ id, version: 1, theme, masters, layouts })).digest('hex');
    return Object.freeze({
        id,
        name,
        description,
        version: 1,
        ownerType: 'system',
        status: 'published',
        aspectRatio: '16:9',
        tags,
        theme,
        masters,
        layouts,
        snapshotDigest
    });
}

const BUILT_IN_TEMPLATES = Object.freeze(THEME_SEEDS.map(makeTemplate));

function cloneTemplate(template) {
    return JSON.parse(JSON.stringify(template));
}

function listBuiltInTemplates() {
    return BUILT_IN_TEMPLATES.map(cloneTemplate);
}

function getBuiltInTemplate(templateId) {
    const template = BUILT_IN_TEMPLATES.find(item => item.id === String(templateId || '').trim());
    return template ? cloneTemplate(template) : null;
}

module.exports = {
    STANDARD_LAYOUTS,
    getBuiltInTemplate,
    listBuiltInTemplates
};
