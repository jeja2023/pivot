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
    ['business-blue', '商务蓝汇报', '适用于项目、经营和工作汇报', '#1769AA', '#5B8FF9', '#61DDAA', '#1F2937', '#F7F9FC', '#FFFFFF', '#E2E8F0', false, ['商务', '汇报', '数据']],
    ['technology-dark', '科技深色方案', '适用于技术方案、产品发布和数字化主题', '#2D6CDF', '#7C3AED', '#22C55E', '#E2E8F0', '#0F172A', '#1E293B', '#334155', true, ['科技', '深色', '产品']],
    ['government-clean', '政务简洁汇报', '适用于政策、制度和正式工作汇报', '#0F4C81', '#2B7BBB', '#83B4D8', '#1E293B', '#FFFFFF', '#F8FAFC', '#E2E8F0', false, ['政务', '正式', '制度']],
    ['party-red', '党建红色宣传', '适用于党建、宣传和会议材料', '#B91C1C', '#DC2626', '#F59E0B', '#3F1D1D', '#FFF7ED', '#FFFFFF', '#FED7AA', false, ['党建', '宣传', '会议']],
    ['training-green', '教学培训', '适用于课程、培训和知识讲解', '#16803C', '#34A853', '#F9AB00', '#173A2A', '#F4FBF6', '#FFFFFF', '#D1FAE5', false, ['培训', '教学', '知识']],
    ['data-insight', '数据分析洞察', '适用于指标、趋势和经营分析', '#2563EB', '#14B8A6', '#F97316', '#172033', '#F8FAFC', '#FFFFFF', '#E2E8F0', false, ['数据', '经营', '分析']],
    ['minimal-white', '极简白正式汇报', '适用于高密度信息和正式沟通', '#111827', '#6B7280', '#2563EB', '#111827', '#FFFFFF', '#F9FAFB', '#E5E7EB', false, ['极简', '正式', '白色']],
    ['public-welfare', '绿色公益项目', '适用于环保、公益和社会项目', '#15803D', '#65A30D', '#0EA5E9', '#1F3B2A', '#F7FEE7', '#FFFFFF', '#DCFCE7', false, ['公益', '环保', '项目']]
]);

function buildThemeMasters(colors, _isDark) {
    const { cardBorder, background } = colors;
    return [
        {
            id: 'master_content',
            name: '标准内容母版',
            background: { fill: background },
            decorations: [
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
                }
            ]
        },
        {
            id: 'master_cover',
            name: '标准封面母版',
            background: { fill: background },
            decorations: []
        }
    ];
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

function makeTemplate(seed) {
    const [id, name, description, primary, secondary, accent, text, background, cardBg, cardBorder, isDark, tags] = seed;
    const cardPalette = [
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
        chartPalette: [primary, secondary, accent, '#F59E0B', '#8B5CF6', '#EC4899']
    };
    const masters = buildThemeMasters(colors, isDark);
    const layouts = buildThemeLayouts(colors, isDark);
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
