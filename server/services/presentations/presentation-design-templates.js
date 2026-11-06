'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../canonical-json');
const LEGACY_THEME_SEEDS = Object.freeze([
    ['business-blue', '商务蓝汇报', '适用于项目阶段汇报、方案评审与经营复盘', '#1F5EA8', '#17A8C7', '#2E8B57', '#344054', '#F5F8FC', '#FFFFFF', '#D8E2EE', false, ['项目', '阶段汇报', '复盘']],
    ['forest-green', '森林绿简报', '适用于环保、健康与自然主题的内容分享与产品介绍', '#1E7A4C', '#3FA97C', '#D8A23A', '#2B3A31', '#F6FAF7', '#FFFFFF', '#D5E4DA', false, ['环保', '健康', '产品介绍']]
]);

const DESIGN_LAYOUTS = Object.freeze([
    ['cover', '封面', '封面'], ['agenda', '议程导航', '内容'], ['section', '章节过渡', '章节'],
    ['title-content', '观点与说明', '内容'], ['executive-summary', '结论与证据', '内容'],
    ['two-column', '双栏解读', '内容'], ['comparison', '方案对比', '内容'], ['three-card', '三个重点', '内容'],
    ['key-metrics', '关键指标', '数据'], ['chart', '图表与结论', '数据'], ['table', '表格与说明', '数据'],
    ['timeline', '时间线', '内容'], ['process', '步骤讲解', '内容'], ['roadmap', '阶段路线图', '内容'],
    ['risk-actions', '风险与措施', '内容'], ['image-focus', '图文解读', '内容'], ['quote', '重点引用', '内容'], ['summary', '总结与行动', '总结']
]);

function textSlot(role, x, y, width, height, size = 28, extra = {}) {
    return { id: `slot_${role}`, role, kind: 'text', x, y, width, height, rotation: 0,
        required: role === 'title', constraints: { maxLines: role === 'title' ? 2 : 10, overflow: 'split' },
        style: { fontFamily: 'Noto Sans SC', fontSize: size, fontWeight: role === 'title' || /value/.test(role) ? 700 : 400,
            color: '#243746', align: 'left', verticalAlign: 'top', lineHeight: 1.4, padding: 0, ...extra } };
}

function rule(id, x, y, width, color, height = 1) {
    return { id, type: 'shape', shapeType: 'rect', x, y, width, height, zIndex: 1, locked: true,
        style: { fill: color, stroke: color, strokeWidth: 0, opacity: 1 } };
}

function layoutSlots(kind, style) {
    const title = textSlot('title', 80, 54, 1120, 105, 42, { color: style.ink });
    const slot = (role, x, y, width, height, size = 28, extra = {}) => textSlot(role, x, y, width, height, size, { color: style.ink, ...extra });
    if (kind === 'cover') return style.variant === 'training'
        ? [slot('title', 80, 126, 590, 228, 54), slot('subtitle', 730, 190, 460, 260, 30)]
        : style.variant === 'formal' ? [slot('title', 110, 180, 1060, 190, 54, { align: 'center' }), slot('subtitle', 210, 412, 860, 130, 28, { align: 'center' })]
            : [slot('title', 88, 162, 1030, 212, 58), slot('subtitle', 94, 428, 1000, 124, 28)];
    if (kind === 'section') return [slot('title', 90, 190, 1090, 210, 56), slot('body', 94, 438, 1040, 128, 28)];
    if (kind === 'quote') return [slot('quote', 132, 178, 1016, 300, 42), slot('attribution', 136, 526, 1000, 65, 26, { color: style.muted })];
    if (['two-column', 'comparison', 'risk-actions'].includes(kind)) return [title,
        slot('left', 88, 194, 510, 410), slot('right', 680, 194, 510, 410)];
    if (kind === 'executive-summary') return style.variant === 'training'
        ? [slot('title', 80, 145, 500, 240, 48), slot('body', 702, 182, 480, 174, 28), slot('evidence', 702, 418, 480, 180, 28)]
        : [title, slot('body', 88, 206, 540, 380, 30), slot('evidence', 718, 218, 450, 360, 28)];
    if (kind === 'three-card' || kind === 'roadmap') return [title, ...[0, 1, 2].map(index => slot(`card${index + 1}`, 88 + index * 382, 238, 338, 334, 28))];
    if (kind === 'key-metrics') return [title, ...[0, 1, 2].flatMap(index => [slot(`value${index + 1}`, 88 + index * 382, 238, 330, 96, 64, { color: style.primary }),
        slot(`label${index + 1}`, 88 + index * 382, 360, 330, 174, 27)])];
    if (kind === 'timeline') return [title, ...[0, 1, 2, 3].map(index => slot(`step${index + 1}`, 88 + index * 286, 242, 244, 326, 26))];
    if (kind === 'process' || kind === 'agenda') return style.variant === 'training'
        ? [slot('title', 80, 155, 440, 255, 46), ...[0, 1, 2, 3].map(index => slot(`step${index + 1}`, 642, 162 + index * 110, 540, 92, 28))]
        : [title, ...[0, 1, 2, 3].map(index => slot(`step${index + 1}`, 148, 193 + index * 105, 1010, 90, 28))];
    if (kind === 'chart' || kind === 'table' || kind === 'image-focus') {
        const role = kind === 'image-focus' ? 'image' : kind;
        return [title, { id: `slot_${role}`, role, kind: role, x: 88, y: 190, width: 730, height: 404, rotation: 0, required: true },
            slot('insight', 870, 206, 320, 370, 28)];
    }
    if (kind === 'summary') return [title, slot('summary', 88, 190, 1100, 228, 30), slot('nextSteps', 88, 470, 1100, 130, 30, { color: style.primary, fontWeight: 700 })];
    return [title, slot('body', 88, 202, 1100, 395, 30)];
}

function makeDesignTemplate(style) {
    const theme = { name: style.name, fonts: { heading: 'Noto Sans SC', body: 'Noto Sans SC' },
        colors: { primary: style.primary, secondary: style.primary, accent: style.primary, text: style.ink, background: style.paper,
            cardBg: style.paper, cardBorder: style.line }, chartPalette: [style.primary, '#7597AB', '#90B8A2', '#C59D60'] };
    const masters = [{ id: 'design_master', name: `${style.name}母版`, background: { fill: style.paper },
        decorations: [rule('footer_rule', 80, 658, 1120, style.line)] }];
    const layouts = DESIGN_LAYOUTS.map(([kind, name, category]) => {
        const decorations = [];
        if (kind === 'cover') decorations.push(style.variant === 'training' ? rule('cover_divider', 674, 130, 3, style.line, 420)
            : rule('cover_accent', style.variant === 'formal' ? 510 : 90, style.variant === 'formal' ? 140 : 124, style.variant === 'formal' ? 260 : 70, style.primary, 5));
        else if (style.variant === 'formal') decorations.push(rule('heading_rule', 80, 166, 1120, style.primary, 2));
        else decorations.push(rule('heading_accent', 80, 168, style.variant === 'training' ? 112 : 56, style.primary, 4));
        if (['two-column', 'comparison', 'risk-actions', 'executive-summary'].includes(kind)) decorations.push(rule('column_divider', 638, 204, 1, style.line, 378));
        if (style.variant === 'training' && ['process', 'agenda'].includes(kind)) decorations.push(rule('training_column_rule', 582, 162, 1, style.line, 420));
        if (['timeline', 'roadmap', 'three-card', 'key-metrics'].includes(kind)) {
            const count = kind === 'timeline' ? 4 : 3;
            for (let index = 0; index < count; index++) decorations.push(rule(`step_rule_${index}`, 88 + index * (kind === 'timeline' ? 286 : 382), 206, kind === 'timeline' ? 244 : 338, style.line, 2));
        }
        return { id: `design-${kind}`, legacyLayoutId: kind, name, category, masterId: 'design_master', slots: layoutSlots(kind, style).map(slot => slot.role),
            placeholders: layoutSlots(kind, style), decorations, defaultTransition: { type: 'none', durationMs: 0 } };
    });
    const definition = { id: style.id, name: style.name, description: style.description, version: 1, ownerType: 'system', status: 'published',
        aspectRatio: '16:9', tags: style.tags, theme, masters, layouts, schemaVersion: '2.0' };
    return { ...definition, snapshotDigest: crypto.createHash('sha256').update(canonicalJson(definition)).digest('hex') };
}

function listDesignTemplates() {
    return [
        { id: 'executive-clean', name: '咨询式简报', variant: 'executive', primary: '#195671', ink: '#203744', muted: '#526977', paper: '#FFFFFF', line: '#D7E2E8', description: '结论与证据分明，适合经营复盘、项目决策和管理汇报', tags: ['精品', '决策', '经营复盘'] },
        { id: 'institutional-report', name: '政企正式', variant: 'formal', primary: '#944D3C', ink: '#34362F', muted: '#646659', paper: '#FCFAF5', line: '#DAD6CA', description: '稳定的层级与阅读顺序，适合工作汇报、制度宣讲和会议材料', tags: ['精品', '工作汇报', '制度宣讲'] },
        { id: 'learning-studio', name: '培训讲解', variant: 'training', primary: '#286B5D', ink: '#23433B', muted: '#516A62', paper: '#F3F7F2', line: '#CBDBD1', description: '步骤与案例驱动，适合操作培训、课程和流程说明', tags: ['精品', '培训', '流程'] }
    ].map(makeDesignTemplate);
}

module.exports = { LEGACY_THEME_SEEDS, listDesignTemplates };
