'use strict';
const { projectMcpOutput, truncateJsonStrings } = require('./agent-tool-output-context');

function inputPreview(value) {
    const preview = truncateJsonStrings(require('./agent-traces').redactTraceValue(value), 500);
    return JSON.stringify(preview).length > 4000
        ? { omitted: true, message: '参数过大，未完整展示；不得据此推断执行成功。' } : preview;
}

function verificationObservations(observations) {
    return observations.slice(-24).map(item => {
        const tool = item.tool || item.toolName || item.name;
        let output = item.output || item;
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
        return { tool, ...(!['tools.search', 'tools.describe'].includes(tool) && item.input != null ? { inputPreview: inputPreview(item.input) } : {}),
            ...(item.error ? { error: String(item.error).slice(0, 500) } : {}), output: truncateJsonStrings(output, 500) };
    });
}

module.exports = { verificationObservations };
