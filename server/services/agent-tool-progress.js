'use strict';

// 只从真实结果提取数量，不把工具原文、命令输出或凭据搬入对话事件。
function summarizeToolOutcome(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
    const value = output.structuredContent && typeof output.structuredContent === 'object' ? output.structuredContent : output;
    const rows = Array.isArray(value.rows) ? value.rows : null;
    const partial = value.__partial === true || output.__partial === true;
    if (rows) return `工具已返回 ${rows.length} 条记录${partial ? '，当前结果包含截取内容，仍需核对完整范围' : ''}。`;
    if (Array.isArray(value.files)) return `工具已返回 ${value.files.length} 项文件记录，文件是否可交付以结果文件状态为准。`;
    const count = value.recordCount ?? value.rowCount;
    if (Number.isSafeInteger(count) && count >= 0) return `工具已处理 ${count} 条记录。`;
    if (Number.isInteger(value.exitCode)) return `命令已返回，退出码为 ${value.exitCode}。`;
    return '';
}

module.exports = { summarizeToolOutcome };
