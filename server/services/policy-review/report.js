'use strict';

const { STATUSES, completeFindings, bounded, invalid } = require('./contract');
const repository = require('../../repositories/policy-reviews');
const sources = require('./sources');

function buildIr(request, result, status) {
    const findings = completeFindings(request, result), counts = Object.fromEntries(Object.keys(STATUSES).map(key => [key, findings.filter(item => item.status === key).length]));
    const paragraph = text => ({ type: 'paragraph', runs: [{ text }], style: { line_height: 1.3, space_after_pt: 5 } }), heading = text => ({ type: 'heading', level: 1, text });
    const blocks = [
        paragraph(`本报告围绕业务日期${request.asOf}，依据所选制度逐条核对提交材料。${status === 'completed' ? '已完成本次所选条目的AI初审' : '本次审查尚未全部完成，以下保留部分结果'}，共${request.clauses.length}个条目；符合${counts.meets}项，不符合${counts.violates}项，待核实${counts.needs_review}项，不适用${counts.not_applicable}项。`),
        paragraph('符合与不符合为辅助初审建议。原文片段匹配不等于业务结论已经得到独立核验；适用性、例外条件与最终处理决定由业务人员复核。'),
        paragraph(`适用范围与审查重点：${request.scope || '按提交材料与所选制度核对，未额外指定。'} 报告版本${result.version}。`),
        heading('制度依据与待审材料'),
        ...request.documents.map(item => paragraph(`${item.title} ${item.versionLabel || ''}；适用范围${item.jurisdiction || '未登记'}；有效期${String(item.effectiveFrom).slice(0, 10)}至${item.effectiveTo ? String(item.effectiveTo).slice(0, 10) : '未登记终止日'}；来源摘要${item.digest.slice(0, 16)}。`)),
        ...request.materials.map(item => paragraph(`${item.title}；材料摘要${item.digest.slice(0, 16)}；本次审查使用提交时的完整文本。`))
    ];
    findings.forEach((finding, index) => {
        const clause = request.clauses[index], source = request.documents.find(item => item.id === clause.documentId);
        blocks.push(heading(`审查项${index + 1} ${STATUSES[finding.status]}`), paragraph(`${source.title} ${clause.label}${clause.page ? ` 第${clause.page}页` : ''}`),
            paragraph(`制度原文：${finding.ruleEvidence?.quote || clause.text}`),
            ...finding.materialEvidence.map(item => paragraph(`材料原文 ${item.title} 字符${item.charStart + 1}至${item.charEnd}：${item.quote}`)),
            ...(!finding.materialEvidence.length ? [paragraph('材料依据：尚无可逐字核对的相关材料片段。')] : []),
            paragraph(`审查说明：${finding.analysis}`), paragraph(`处理建议：${finding.recommendation || '请业务人员核对后确定处理方式。'}`),
            paragraph(`${finding.evidenceNote} ${finding.origin === 'human' ? '本项说明经用户修订。' : finding.origin === 'unreviewed' ? '本项未完成模型审查。' : '本项为AI初审。'}`));
    });
    if (result.notes) blocks.push(heading('人工复核备注'), paragraph(result.notes));
    const completeBlocks = blocks.flatMap(block => {
        if (block.type !== 'paragraph' || block.runs[0].text.length <= 18000) return [block];
        const text = block.runs[0].text, parts = [];
        for (let offset = 0; offset < text.length; offset += 18000) parts.push(paragraph(text.slice(offset, offset + 18000)));
        return parts;
    });
    return { ir_version: '1', doc_type: 'report', meta: { title: request.title, security_level: 'internal' }, footer: { page_number: true, format: '第 {page} 页' }, blocks: completeBlocks };
}

async function save(user, id, body = {}) {
    const row = await repository.read(user, id);
    if (!row) return null;
    await sources.assertRequest(row.input_request, user);
    if (!Number.isSafeInteger(body.version) || !Array.isArray(body.findings) || body.findings.length !== row.input_request.clauses.length) throw invalid('请提交完整的报告版本与审查项。');
    const originals = new Map(completeFindings(row.input_request, row.result_json).map(item => [item.id, item])), seen = new Set();
    const findings = body.findings.map(item => {
        const previous = originals.get(item.id);
        if (!previous || seen.has(item.id) || !Object.hasOwn(STATUSES, item.status)) throw invalid('报告包含未知、重复或无效的审查项。');
        seen.add(item.id);
        if (item.status !== previous.status && (previous.origin === 'unreviewed' || ['meets', 'violates'].includes(item.status) && (!previous.citationVerified || !previous.ruleEvidence || !previous.materialEvidence.length))) throw invalid('缺少原文依据的条目不能改为符合或不符合，请补充材料后重新审查。');
        const analysis = bounded(item.analysis, 3000, '审查说明'), recommendation = bounded(item.recommendation || '', 2000, '处理建议', false);
        return { ...previous, status: item.status, analysis, recommendation,
            ...(item.status !== previous.status || analysis !== previous.analysis || recommendation !== previous.recommendation ? { origin: 'human', editedBy: user.id } : {}) };
    });
    return repository.edit(user, id, body.version, async current => {
        await sources.assertRequest(current.input_request, user);
        return { ...current.result_json, findings, notes: bounded(body.notes || '', 6000, '人工备注', false), version: body.version + 1, editedAt: new Date().toISOString() };
    });
}

module.exports = { buildIr, save };
