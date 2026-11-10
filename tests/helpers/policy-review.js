'use strict';

const { queryOne, execute } = require('../../server/db/client');
const crypto = require('node:crypto');

const rules = ['单笔报销金额不得超过5000元。', '报销前必须取得部门负责人书面批准。', '申请应附原始发票。'];
const materialText = '本次报销金额为6200元。已取得部门负责人书面批准。';

async function fixture(count = 3) {
    const user = await queryOne("SELECT id,username,unit,role,status FROM users WHERE username='admin'");
    const doc = await queryOne("INSERT INTO regulation_documents(title,jurisdiction,metadata_review_status) VALUES (?,'测试业务部门','approved') RETURNING id", [`报销制度验收${crypto.randomUUID().slice(0, 8)}`]);
    const version = await queryOne("INSERT INTO regulation_versions(document_id,version_label,source_name,source_path,effect_status,review_status,effective_from,article_count) VALUES (?,'已复核版本','测试制度.txt','','effective','approved','2026-01-01',?) RETURNING id", [doc.id, count]);
    for (let index = 0; index < count; index++) await execute('INSERT INTO regulation_articles(document_id,version_id,article_label,content,sort_order) VALUES (?,?,?,?,?)', [doc.id, version.id, `第${index + 1}条`, rules[index % 3], index + 1]);
    await execute('UPDATE regulation_documents SET current_version_id=?,version_count=1,article_count=? WHERE id=?', [version.id, count, doc.id]);
    const model = await queryOne("INSERT INTO models(user_id,name,url,model_name,status,context_window_tokens) VALUES (?,'审查测试模型','http://127.0.0.1:65530/v1','policy-review-test','active',131072) RETURNING id", [user.id]);
    return { user, documentId: Number(doc.id), versionId: Number(version.id), modelId: String(model.id) };
}

function input(data, extra = {}) {
    return { title: '报销材料制度审查报告', asOf: '2026-11-09', scope: '测试业务部门报销材料', documentIds: [data.documentId],
        materials: [{ title: '报销申请', text: materialText }], modelId: data.modelId, requestKey: crypto.randomUUID(), ...extra };
}

function modelResponse(request, batch) {
    return { findings: batch.map(clause => {
        const index = rules.indexOf(clause.text);
        return { clauseId: clause.id, status: ['violates', 'meets', 'needs_review'][index], ruleQuote: clause.text,
            materialEvidence: index === 2 ? [] : [{ materialId: request.materials[0].id, quote: index === 0 ? '本次报销金额为6200元。' : '已取得部门负责人书面批准。' }],
            analysis: ['申请金额超过制度列明的单笔限额，需要进一步核对例外审批。', '材料载明已取得部门负责人书面批准，仍需核对批准文件。', '材料未提供发票，需补充后核实。'][index],
            recommendation: ['补充例外审批依据，或调整申请。', '核对书面批准文件。', '请补充原始发票。'][index] };
    }) };
}

module.exports = { fixture, input, modelResponse, rules, materialText };
