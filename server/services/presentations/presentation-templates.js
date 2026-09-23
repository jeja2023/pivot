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
    ['business-blue', '商务蓝汇报', '适用于项目、经营和工作汇报', '#1769AA', '#5B8FF9', '#61DDAA', '#1F2937', '#F7F9FC', ['商务', '汇报', '数据']],
    ['technology-dark', '科技深色方案', '适用于技术方案、产品发布和数字化主题', '#2D6CDF', '#7C3AED', '#22C55E', '#E2E8F0', '#0F172A', ['科技', '深色', '产品']],
    ['government-clean', '政务简洁汇报', '适用于政策、制度和正式工作汇报', '#0F4C81', '#2B7BBB', '#83B4D8', '#1E293B', '#FFFFFF', ['政务', '正式', '制度']],
    ['party-red', '党建红色宣传', '适用于党建、宣传和会议材料', '#B91C1C', '#DC2626', '#F59E0B', '#3F1D1D', '#FFF7ED', ['党建', '宣传', '会议']],
    ['training-green', '教学培训', '适用于课程、培训和知识讲解', '#16803C', '#34A853', '#F9AB00', '#173A2A', '#F4FBF6', ['培训', '教学', '知识']],
    ['data-insight', '数据分析洞察', '适用于指标、趋势和经营分析', '#2563EB', '#14B8A6', '#F97316', '#172033', '#F8FAFC', ['数据', '经营', '分析']],
    ['minimal-white', '极简白正式汇报', '适用于高密度信息和正式沟通', '#111827', '#6B7280', '#2563EB', '#111827', '#FFFFFF', ['极简', '正式', '白色']],
    ['public-welfare', '绿色公益项目', '适用于环保、公益和社会项目', '#15803D', '#65A30D', '#0EA5E9', '#1F3B2A', '#F7FEE7', ['公益', '环保', '项目']]
]);

function makeTemplate(seed) {
    const [id, name, description, primary, secondary, accent, text, background, tags] = seed;
    const theme = {
        name,
        colors: { primary, secondary, accent, text, background },
        fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
        chartPalette: [primary, secondary, accent, '#F59E0B', '#8B5CF6', '#EC4899']
    };
    const snapshotDigest = crypto.createHash('sha256').update(canonicalJson({ id, version: 1, theme, layouts: STANDARD_LAYOUTS })).digest('hex');
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
        layouts: STANDARD_LAYOUTS,
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
