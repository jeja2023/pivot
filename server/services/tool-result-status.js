'use strict';

function assertToolResultSuccess(output) {
    if (output?.isError !== true) return;
    const detail = (Array.isArray(output.content) ? output.content : [])
        .filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n').slice(0, 2000);
    const error = new Error(detail ? `工具执行失败：${detail}` : '工具执行失败，服务未返回错误详情。');
    error.code = 'MCP_TOOL_EXECUTION_ERROR';
    error.category = 'execution';
    error.status = 422;
    error.retryable = false;
    throw error;
}

module.exports = { assertToolResultSuccess };
