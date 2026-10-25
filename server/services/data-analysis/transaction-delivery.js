'use strict';
const repository = require('../../repositories/analysis-transaction-outputs');
const { invalid } = require('./transaction-config');
async function create(user, analysisId, format) {
    if (!['docx','pdf','mindmap'].includes(format)) throw invalid('请选择 Word、PDF 或思维导图。');
    const job = await require('./transactions').get(user, analysisId); if (job.status !== 'succeeded') throw invalid('请先完成交易分析。');
    const output = await repository.create(user.id, analysisId, format); if (!output) throw invalid('分析已失效，请重新运行。', 409);
    setImmediate(() => { void require('./transactions').drain(); }); return output;
}
async function list(user, analysisId) { await require('./transactions').get(user, analysisId); return repository.list(analysisId); }
async function execute(output) {
    const user = await require('./shared').resolveAnalysisUser(output.user_id);
    const job = await require('./transactions').get(user, output.analysis_id);
    const report = require('./transaction-report'); let artifactId = output.artifact_id;
    if (!artifactId) {
        if (output.format === 'mindmap') artifactId = (await require('../mindmaps/documents').save(user, { document: report.tree(job), requestKey: `finance-map:${job.id}`, note: `资金分析 ${job.id} 生成，保留期随分析任务。` })).id;
        else artifactId = (await require('../agent-artifacts').createStandaloneArtifact(user, { type: 'document', title: '资金交易分析报告', content: JSON.stringify(report.ir(job)), note: `资金分析 ${job.id} 生成，保留期随分析任务。` })).id;
        if (!await repository.attach(output, artifactId)) { await require('../../repositories/analysis-transaction-retention').discardArtifact(artifactId); throw invalid('交付任务已取消或过期。', 409); }
    }
    let renditionId;
    if (output.format !== 'mindmap') {
        const rendered = await require('../agent-artifact-renditions').createRendition({ user, artifactId, ir: report.ir(job), format: output.format, toolCallId: `finance:${output.id}` }); renditionId = rendered.rendition.id;
    }
    try { await require('./transactions').get(user, job.id); if (!await repository.finish(output, renditionId)) throw invalid('交付任务已取消或过期。', 409); }
    catch (error) { await require('../../repositories/analysis-transaction-retention').discardArtifact(artifactId); throw error; }
}
async function drain() {
    for (let index = 0; index < 5; index++) {
        const output = await repository.claim(); if (!output) break;
        try { await execute(output); }
        catch (error) { await repository.finish(output, null, error.expose ? error.message : '报告生成失败，请重试或检查渲染环境。'); }
    }
}
module.exports = { create, list, drain };
