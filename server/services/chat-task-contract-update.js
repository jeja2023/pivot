'use strict';

const { capabilitiesCoverTool } = require('./agent-capability-registry');

const BUSINESS_FIELDS = ['timeRange', 'region', 'audience', 'format'];
const PROTECTED_CONSTRAINT = /不要|不得|禁止|不许|不能|不允许|只读|权限|授权|审批|联网|知识库|写入|修改|删除|发送|部署|发布|\b(?:not|never|without|read.only|permission|approval|delete|write|send)\b/iu;
const FIELD_PATTERNS = {
    timeRange: /(?:本|上|下|这|当)(?:周|月|季度|年度|年)|昨天|今天|时间|日期|\d{4}[年/-]|\b(?:week|month|quarter|year|date|period)\b/iu,
    region: /地区|区域|分公司|华[东南北中]|西[南北]|\b(?:region|location|branch)\b/iu,
    audience: /人员|员工|实习生|试用期|人群|客户类别|\b(?:audience|interns?|employees?|customers?)\b/iu,
    format: /格式|摘要|明细|表格|报告形式|\b(?:format|summary|detail|csv|pdf|docx|pptx)\b/iu
};

function businessField(constraint) {
    if (PROTECTED_CONSTRAINT.test(constraint)) return null;
    const matches = BUSINESS_FIELDS.filter(field => FIELD_PATTERNS[field].test(constraint));
    return matches.length === 1 ? matches[0] : null;
}

function normalizeBusinessScope(value = {}) {
    return Object.fromEntries(BUSINESS_FIELDS.filter(field => typeof value?.[field] === 'string' && value[field].trim()).map(field => [field, value[field].trim().slice(0, 500)]));
}

function replaceableBusinessField(constraint) {
    const field = businessField(constraint);
    if (!field) return null;
    const canonical = /^(?:统计时间|统计地区|适用对象|输出格式)[：:]/u.test(constraint);
    const simple = {
        timeRange: /^(?:只|仅)?(?:统计|查询|处理|核对|分析)?(?:本|上|下|这|当)(?:周|月|季度|年度|年)(?:的)?(?:订单|数据|记录|报告)?(?:口径|范围)?$/u,
        region: /^(?:只|仅)?(?:统计|查询|处理|核对|分析)?(?:华[东南北中]|西[南北])(?:地区|区域|分公司)?$/u,
        audience: /^(?:只|仅)?(?:统计|查询|适用于?|面向)?(?:正式员工|实习生|试用期员工|客户)$/u,
        format: /^(?:只要|只给|输出|使用)?(?:摘要|明细|表格|PDF|PPTX?|Word|Excel|CSV)(?:格式)?$/iu
    };
    return canonical || simple[field].test(constraint) ? field : null;
}

function mergeTaskContract({ prior = {}, constraints = [], capabilities = [], removedCapabilities = [], businessScope = {}, inheritCapabilities = true } = {}) {
    const previous = Array.isArray(prior.constraints) ? prior.constraints : [];
    const updates = new Set([...constraints.map(businessField).filter(Boolean), ...Object.keys(businessScope)]);
    // 只有明确的单一业务维度可替换；安全限制和无法拆分的旧约束继续保留。
    const retained = previous.filter(constraint => !updates.has(replaceableBusinessField(constraint)));
    const mergedScope = { ...Object.fromEntries(Object.entries(normalizeBusinessScope(prior.businessScope)).filter(([field]) => !updates.has(field))), ...normalizeBusinessScope(businessScope) };
    const labels = { timeRange: '统计时间', region: '统计地区', audience: '适用对象', format: '输出格式' };
    const scopeConstraints = Object.entries(businessScope).filter(([, value]) => value).map(([field, value]) => `${labels[field]}：${value}`);
    const inherited = inheritCapabilities && Array.isArray(prior.requiredCapabilities) ? prior.requiredCapabilities : [];
    return { constraints: [...new Set([...retained, ...constraints, ...scopeConstraints])], businessScope: mergedScope,
        // 原任务仍在续接时，不能仅凭模型的附属字段丢掉查询能力；明确的来源
        // 撤销继续由本轮与原任务的硬范围约束过滤，空能力的已撤销任务也不会恢复。
        requiredCapabilities: [...new Set([...inherited, ...capabilities])].filter(capability => (inherited.includes(capability) && /^data\./.test(capability)) || !capabilitiesCoverTool(removedCapabilities, [capability])) };
}

module.exports = { BUSINESS_FIELDS, mergeTaskContract, normalizeBusinessScope };
