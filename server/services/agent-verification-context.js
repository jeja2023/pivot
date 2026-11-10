'use strict';
const { projectMcpOutput, truncateJsonStrings } = require('./agent-tool-output-context');

function inputPreview(value) {
    const preview = truncateJsonStrings(require('./agent-traces').redactTraceValue(value), 500);
    return JSON.stringify(preview).length > 4000
        ? { omitted: true, message: '参数过大，未完整展示；不得据此推断执行成功。' } : preview;
}

function verificationObservations(observations, { fullOutput = false } = {}) {
    return observations.map(item => {
        const tool = item.tool || item.toolName || item.name;
        let output = Object.hasOwn(item, 'output') ? item.output : tool
            ? { executed: false, message: '没有工具输出，不能据此判定执行完成。' } : item;
        if (tool === 'tools.describe' || tool === 'tools.search' || output?.executed === false && output?.type === 'tool_contract_required') output = { executed: false, kind: tool,
            message: '只发现或读取了工具契约，不是业务执行或交付证据。' };
        else if (output?.type === 'tools_batch_read' && Array.isArray(output.results)) output = { ...output,
            results: output.results.map(result => ({ toolName: result.toolName, output: projectMcpOutput(result.output) })) };
        else output = projectMcpOutput(output);
        if (['agent_wait', 'agent_join'].includes(output?.type)) {
            output = { ...output };
            for (const key of ['children', 'results', 'failures']) if (Array.isArray(output[key])) {
                output[key] = output[key].map(({ metadata: _metadata, ...child }) => child);
            }
        }
        return { tool, ...(item.evidenceId ? { evidenceId: item.evidenceId, sourceRunId: item.sourceRunId, operationKey: item.operationKey, observedAt: item.observedAt, status: item.status } : {}), ...(!['tools.search', 'tools.describe'].includes(tool) && item.input != null ? { inputPreview: inputPreview(item.input) } : {}),
            ...(item.error ? { error: String(item.error).slice(0, 500) } : {}), output: fullOutput ? output : truncateJsonStrings(output, 500) };
    });
}

// 规划时的摘要不能充当完整交付证据；读取原文仍检查当前账号和对象完整性。
async function resolveVerificationObservations(observations, user, deps = {}) {
    const cas = require('./agent-artifact-cas');
    let tenant;
    let bytes = 0;
    const resolved = [];
    for (const item of observations) {
        let output = item.output;
        if (require('./agent-working-memory-artifacts').isWorkingMemoryOutputPartial(output)) {
            if (!output.rawOutputRef) throw Object.assign(new Error('核验证据缺少完整原文引用。'), { code: 'VERIFICATION_EVIDENCE_INCOMPLETE' });
            tenant ||= await (deps.tenant || require('./agent-tenant-context').assertTenantContext)(user);
            const params = { ref: output.rawOutputRef, userId: user.id, tenantId: tenant.tenantId };
            const object = await (deps.stat || cas.statObject)(params);
            if (!object || object.owner_user_id !== Number(user.id) || object.kind !== 'workmem_output' || object.content_digest !== output.rawOutputDigest) throw Object.assign(new Error('核验原文引用已失效或无权访问。'), { code: 'VERIFICATION_EVIDENCE_INCOMPLETE' });
            bytes += Number(object.byte_size);
            if (!Number.isFinite(bytes) || bytes > 32 * 1024 * 1024) throw Object.assign(new Error('核验原文超过本次读取容量。'), { code: 'VERIFICATION_CONTEXT_LIMIT' });
            const { buffer } = await (deps.read || cas.readBuffer)(params);
            output = JSON.parse(buffer.toString('utf8'));

        }
        resolved.push({ ...item, output });
    }
    return verificationObservations(resolved, { fullOutput: true });
}

module.exports = { verificationObservations, resolveVerificationObservations };
