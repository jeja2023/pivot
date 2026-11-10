'use strict';

function response(messages) {
    const request = JSON.parse(messages.find(message => message.role === 'user').content);
    const material = request.materials[0];
    return { findings: request.batchClauseIds.map(id => {
        const clause = request.policyContext.find(item => item.id === id), amount = clause.text.includes('5000'), approval = clause.text.includes('书面批准');
        return { clauseId: id, status: amount ? 'violates' : approval ? 'meets' : 'needs_review', ruleQuote: clause.text,
            materialEvidence: amount || approval ? [{ materialId: material.id, quote: amount ? '本次报销金额为6200元。' : '已取得部门负责人书面批准。' }] : [],
            analysis: amount ? '申请金额超过制度列明的单笔限额，需核对例外审批。' : approval ? '材料载明已取得书面批准，需要核对批准文件。' : '材料缺少原始发票，需补充后核实。',
            recommendation: amount ? '请补充例外审批依据。' : approval ? '请核对书面批准文件。' : '请补充原始发票。' };
    }) };
}

module.exports = { response };
