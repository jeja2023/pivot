'use strict';
const { compareDocuments, comparisonIr } = require('./document-comparison');

function offlineOfficeDefinitions() {
    return [
        { name: 'finance.transactionSummary', title: '资金交易汇总', description: '按用户明确确认的字段映射与收支口径分析已授权数据集。使用精确定点金额，按币种分别汇总，输出脱敏对手方与来源行规则证据。必须先取得数据集与映射，不得猜测借贷方向；结果不认定交易性质。', capabilities: ['data.dataset.read'], input_schema: { type: 'object', properties: { datasetId: { type: 'string' }, analysisId: { type: 'string' }, mapping: { type: 'object' }, amountMode: { type: 'string', enum: ['signed', 'direction'] }, incomeValues: { type: 'array', items: { type: 'string' } }, expenseValues: { type: 'array', items: { type: 'string' } }, defaultCurrency: { type: 'string' }, timezoneOffsetMinutes: { type: 'integer' }, rules: { type: 'object' } }, additionalProperties: false } },
        { name: 'document.compare', title: '精细文档比较与修订', description: '比较两个文本的字符、段落移动，生成 DOCX 修订稿。先用已授权来源读取文本，支持最多各 30000 字符。', capabilities: ['document.render'],
            input_schema: { type: 'object', properties: { before: { type: 'string', maxLength: 30000 }, after: { type: 'string', maxLength: 30000 } }, required: ['before', 'after'], additionalProperties: false } },
        { name: 'viz.mindmap', title: '创建可编辑思维导图', description: '从带稳定 id、text、children 的节点树创建可编辑脑图并导出 SVG，最多5000节点、根深度0到12。', capabilities: ['viz.render'],
            input_schema: { type: 'object', properties: { tree: { type: 'object' } }, required: ['tree'], additionalProperties: false } }
    ];
}

async function executeOfflineOffice(name, input, user, context) {
    if (name === 'finance.transactionSummary') {
        const service = require('./data-analysis/transactions');
        if (input.analysisId) { const job = await service.get(user, input.analysisId); return { analysisId: job.id, status: job.status, result: job.result, text: job.result ? JSON.stringify(job.result) : '资金交易分析正在处理，请稍后使用分析编号读取结果。' }; }
        if (!input.datasetId || !input.mapping) throw require('./data-analysis/transaction-config').invalid('请先确认数据集及交易字段映射。');
        const job = await service.create(user, input.datasetId, { ...input, requestKey: `finance:${context.toolCallId || context.stepId || require('crypto').randomUUID()}` });
        return { analysisId: job.id, status: job.status, text: '交易分析已进入任务队列，请使用 analysisId 读取已校验的汇总与证据。' };
    }
    if (name === 'viz.mindmap') return await require('./mindmap').saveMindmap(user, input, context);
    const comparison = compareDocuments(input.before, input.after);
    const result = await require('./agent-tools-artifacts').executeArtifactTool('artifact.render', { ir: comparisonIr(comparison), format: 'docx' }, user, context);
    return { ...result, comparison };
}
module.exports = { offlineOfficeDefinitions, executeOfflineOffice };
