'use strict';

const repository = require('../../repositories/policy-reviews');
const sources = require('./sources');
const { invalid, digest } = require('./contract');
const { buildIr } = require('./report');

async function exportReport(user, id, version, context = {}) {
    if (!Number.isSafeInteger(version) || version < 1) throw invalid('请先保存并选择有效的报告版本。');
    const row = await repository.read(user, id);
    if (!row) return null;
    context.signal?.throwIfAborted();
    if (row.status === 'working') throw invalid('审查仍在执行，请等待结束或停止后导出部分报告。', 409);
    await sources.assertRequest(row.input_request, user);
    const saved = await repository.edit(user, id, version, async (current, client) => {
        await sources.assertRequest(current.input_request, user);
        const result = current.result_json;
        if (!result.exports?.[version]) {
            const ir = buildIr(current.input_request, result, current.status);
            const binding = { kind: 'policy_review_report', taskId: id, sourceDigest: current.input_request.sourceDigest, reportVersion: version, ir };
            const artifact = await require('../agent-artifacts').createStandaloneArtifact(user, { type: 'policy_review_report', title: `${current.input_request.title} 第${version}版`, content: JSON.stringify(binding), note: '制度材料审查可编辑报告' }, { executor: client });
            await repository.attachArtifact(client, artifact.id, current.input_request.parentRunId, user.id);
            return { ...result, exports: { ...result.exports, [version]: artifact.id } };
        }
        return result;
    });
    const artifactId = Number(saved.result_json.exports[version]);
    const artifact = await require('../agent-artifacts').getAgentArtifactForUser(artifactId, user);
    if (!artifact) throw invalid('报告产物不可用。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    const binding = JSON.parse(artifact.content);
    const { rendition, reused } = await require('../agent-artifact-renditions').createRendition({ user, artifactId, ir: binding.ir, format: 'docx',
        runId: row.input_request.parentRunId || `standalone-artifact:${artifactId}`, toolCallId: context.stepId || context.toolCallId || `policy-review:${digest(id).slice(0, 24)}:v${version}` });
    context.signal?.throwIfAborted();
    await sources.assertRequest(row.input_request, user);
    return { artifactId, renditionId: Number(rendition.id), format: 'docx', version, reused, contentDigest: rendition.content_digest, byteSize: Number(rendition.byte_size),
        text: '已生成可编辑Word审查报告，已挂载结果文件；初审建议与原文依据需业务人员复核。' };
}

module.exports = { exportReport };
