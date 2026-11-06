'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../canonical-json');

const TYPES = ['cover', 'agenda', 'section', 'title-content', 'executive-summary', 'two-column', 'comparison', 'three-card', 'key-metrics', 'chart', 'table', 'timeline', 'process', 'roadmap', 'risk-actions', 'image-focus', 'quote', 'summary'];
const NAMES = ['封面', '编号议程', '章节过渡', '观点说明', '问题与安排', '双栏解读', '当前与目标', '三个重点', '关键指标', '图表与结论', '表格与说明', '时间线', '执行步骤', '阶段路线', '风险与措施', '图文解读', '重点引用', '总结与责任'];

function slot(role, x, y, width, height, size, color, weight = 400) {
    return { id: `slot_${role}`, role, kind: 'text', x, y, width, height, rotation: 0, required: role === 'title',
        constraints: { maxLines: role === 'title' ? 2 : 8, overflow: 'split' },
        style: { fontFamily: 'Noto Sans SC', fontSize: size, fontWeight: weight, color, lineHeight: 1.32, padding: 0, align: 'left', verticalAlign: 'top' } };
}
function shape(id, x, y, width, height, fill, opacity = 1) {
    return { id, type: 'shape', shapeType: 'rect', x, y, width, height, zIndex: 0, locked: true,
        style: { fill, stroke: fill, strokeWidth: 0, opacity } };
}
function label(id, text, x, y, width, color, size = 20) {
    return { id, type: 'text', x, y, width, height: size * 1.7, zIndex: 2, locked: true, content: { text },
        style: { fontFamily: 'Noto Sans SC', fontSize: size, fontWeight: 500, color, lineHeight: 1.15, padding: 0 } };
}

function layoutDefinition(kind, palette) {
    const { ink, muted, primary, rule, paper, tint } = palette;
    const title = slot('title', 80, 68, 1110, 112, 44, ink, 700);
    const body = (role, x, y, width, height, size = 28, weight = 400) => slot(role, x, y, width, height, size, ink, weight);
    let slots = [title], decorations = [];
    const hero = kind === 'cover' || kind === 'section';
    if (!hero) decorations.push(shape('top_marker', 80, 40, 40, 4, primary));
    if (kind === 'cover') {
        const formal = palette.id === 'institutional-report';
        slots = [slot('title', 84, formal ? 170 : palette.id === 'executive-clean' ? 190 : 160, formal ? 1090 : palette.id === 'executive-clean' ? 1060 : 1000, 232, 62, '#FAFBF6', 700),
            slot('subtitle', 88, 446, 950, 136, 27, '#DFEBE5')];
        decorations = [shape('cover_spine', 0, 0, 20, 720, palette.accent), shape('cover_rule', 88, 114, 96, 4, palette.accent),
            shape('cover_inset', 1120, 0, 160, 720, '#FFFFFF', 0.035)];
    } else if (kind === 'section') {
        slots = [slot('title', 88, 190, 1095, 174, 60, '#FAFBF6', 700), slot('body', 92, 418, 940, 146, 30, '#DFEBE5')];
        decorations = [shape('section_rule', 88, 144, 80, 4, palette.accent), label('section_label', '章节', 88, 80, 150, '#DFEBE5', 20)];
    } else if (kind === 'agenda') {
        slots.push(...Array.from({ length: 8 }, (_, i) => body(`step${i + 1}`, 190, 220 + i * 48, 950, 44, 26, 500)));
    } else if (['executive-summary', 'risk-actions', 'comparison', 'two-column'].includes(kind)) {
        const left = kind === 'executive-summary' ? 'body' : 'left', right = kind === 'executive-summary' ? 'evidence' : 'right';
        slots.push(body(left, 112, 282, 472, 300, 28), body(right, 706, 282, 454, 300, 28));
        decorations.push(shape('left_ground', 80, 266, 1120, 146, tint), shape('right_ground', 80, 438, 1120, 146, '#FFFFFF'),
            label('left_label', kind === 'comparison' ? '当前状态' : kind === 'executive-summary' ? '现状与依据' : kind === 'risk-actions' ? '主要风险' : '要点一', 112, 238, 440, muted),
            label('right_label', kind === 'comparison' ? '目标安排' : kind === 'executive-summary' || kind === 'risk-actions' ? '对应的处理安排' : '要点二', 706, 238, 440, primary),
            shape('pair_bridge', 638, 282, 1, 98, rule), shape('pair_bridge_second', 638, 458, 1, 98, rule));
    } else if (kind === 'chart' || kind === 'table' || kind === 'image-focus') {
        const role = kind === 'image-focus' ? 'image' : kind;
        slots.push({ id: `slot_${role}`, role, kind: role, x: 88, y: 232, width: 720, height: 366, required: true }, body('insight', 872, 282, 318, 282, 27));
        decorations.push(label('insight_label', '说明与依据', 872, 224, 300, primary, 20), shape('chart_column_rule', 838, 232, 1, 370, rule));
    } else if (kind === 'process' || kind === 'timeline') {
        slots.push(...Array.from({ length: 4 }, (_, i) => body(`step${i + 1}`, 100 + i * 284, 330, 236, 228, 28)));
    } else if (kind === 'three-card' || kind === 'roadmap') {
        slots.push(...Array.from({ length: 3 }, (_, i) => body(`card${i + 1}`, 108 + i * 380, 312, 300, 240, 28)));
    } else if (kind === 'key-metrics') {
        slots.push(...Array.from({ length: 3 }, (_, i) => [slot(`value${i + 1}`, 96 + i * 380, 264, 330, 110, 64, primary, 700), body(`label${i + 1}`, 100 + i * 380, 414, 310, 140, 28)]).flat());
    } else if (kind === 'summary') {
        slots = [slot('title', 88, 90, 1090, 124, 46, '#FAFBF6', 700), slot('summary', 122, 304, 1010, 108, 32, '#FAFBF6', 500), slot('nextSteps', 122, 476, 1010, 108, 32, '#FAFBF6', 500)];
        decorations.push(shape('summary_spine', 88, 294, 4, 300, palette.accent), label('summary_label', '执行责任', 90, 240, 400, '#BED6CB', 20), shape('summary_separator', 122, 445, 1010, 1, '#527267'));
    } else if (kind === 'quote') {
        slots = [body('quote', 142, 208, 1000, 290, 46, 600), slot('attribution', 150, 536, 980, 64, 24, muted)];
        decorations.push(shape('quote_spine', 86, 224, 5, 286, primary));
    } else {
        slots.push(body('body', 134, 238, 1000, 356, 30));
    }
    return { id: `design-${kind}`, legacyLayoutId: kind, name: NAMES[TYPES.indexOf(kind)], category: hero ? '封面与章节' : '内容',
        masterId: hero || kind === 'summary' ? 'editorial_dark' : 'editorial_light', placeholders: slots, slots: slots.map(item => item.role), decorations,
        defaultTransition: { type: 'none', durationMs: 0 }, editorial: { kind, paper, rule, primary, muted, ink } };
}

function listEditorialTemplates() {
    return [
        { id: 'learning-studio', name: '培训讲解', primary: '#1E5948', ink: '#173D32', muted: '#68776D', paper: '#F4F5F0', tint: '#E7ECE4', rule: '#D0DACF', accent: '#C3CF83', hero: '#173D32', description: '完整标题、编号议程与问题行动对照，适合课程、培训和工作说明' },
        { id: 'executive-clean', name: '咨询式简报', primary: '#235C76', ink: '#193442', muted: '#637783', paper: '#F6F7F7', tint: '#E9EFF1', rule: '#D3E0E5', accent: '#C7DCE3', hero: '#193442', description: '结论与证据成组呈现，以清晰数据与结构支撑管理汇报' },
        { id: 'institutional-report', name: '政企正式', primary: '#944E3C', ink: '#35382F', muted: '#767365', paper: '#FAF8F2', tint: '#F0ECE2', rule: '#DCD5C8', accent: '#D3B989', hero: '#393B32', description: '稳重标题、紧凑分组与责任安排，适合正式会议和制度宣讲' }
    ].sort((left, right) => ['executive-clean', 'institutional-report', 'learning-studio'].indexOf(left.id) - ['executive-clean', 'institutional-report', 'learning-studio'].indexOf(right.id)).map(palette => {
        const theme = { name: palette.name, fonts: { heading: 'Noto Sans SC', body: 'Noto Sans SC' }, colors: { primary: palette.primary, secondary: palette.primary, accent: palette.accent, text: palette.ink, background: palette.paper }, chartPalette: [palette.primary, '#9DB3A6', '#C3CF83', '#BBC8C0'] };
        const masters = [{ id: 'editorial_light', name: '浅色内容母版', background: { fill: palette.paper }, decorations: [] },
            { id: 'editorial_dark', name: '深色重点母版', background: { fill: palette.hero }, decorations: [] }];
        const value = { id: palette.id, name: palette.name, description: palette.description, version: 2, schemaVersion: '2.0', ownerType: 'system', status: 'published', aspectRatio: '16:9', tags: ['精修', '中文', '可编辑'], theme, masters, layouts: TYPES.map(kind => layoutDefinition(kind, palette)) };
        return { ...value, snapshotDigest: crypto.createHash('sha256').update(canonicalJson(value)).digest('hex') };
    });
}

module.exports = { listEditorialTemplates, shape, label };
