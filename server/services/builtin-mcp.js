/* 内置 MCP 能力 - 外观聚合 Built-in MCP Facade
 *
 * 本文件原为 1400+ 行的单体模块，现按领域拆分为：
 *   - builtin-mcp-common.js         公共层（配置归一化、通用数据处理）
 *   - builtin-mcp-reports.js        报表与数据文件
 *   - builtin-mcp-visualization.js  可视化图表与报告编排
 *   - builtin-mcp-documents.js      文档解析
 *   - builtin-mcp-data.js           数据处理
 *   - builtin-mcp-format.js         格式转换
 *   - builtin-mcp-im.js             局域网消息通知
 *
 * 本外观仅负责：按服务类型分发 list/execute，并 re-export 原有公共 API，
 * 对外接口与行为保持完全不变，调用方无需改动。
 */
const {
    BUILTIN_MCP_PREFIXES,
    normalizeBuiltinPayload,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    getBuiltinConfigForServer,
    buildTableBlock
} = require('./builtin-mcp-common');
const { listReportTools, executeReportTool } = require('./builtin-mcp-reports');
const {
    buildChartSpec,
    listVisualizationTools,
    executeVisualizationTool,
    listReportComposerTools,
    executeReportComposerTool
} = require('./builtin-mcp-visualization');
const { listDocumentTools, executeDocumentTool } = require('./builtin-mcp-documents');
const { listDataProcessingTools, executeDataProcessingTool } = require('./builtin-mcp-data');
const { listFormatConversionTools, executeFormatConversionTool } = require('./builtin-mcp-format');
const { listImTools, executeImTool } = require('./builtin-mcp-im');

function listBuiltinMcpTools(server) {
    const type = getBuiltinServiceTypeFromUrl(server.base_url);
    if (type === 'reports') return listReportTools();
    if (type === 'visualization') return listVisualizationTools();
    if (type === 'report') return listReportComposerTools();
    if (type === 'documents') return listDocumentTools();
    if (type === 'data') return listDataProcessingTools();
    if (type === 'format') return listFormatConversionTools();
    if (type === 'im') return listImTools();
    throw new Error('Unsupported built-in MCP server.');
}

async function executeBuiltinMcpTool(server, name, input = {}, user = null) {
    const type = getBuiltinServiceTypeFromUrl(server.base_url);
    if (type === 'reports') return executeReportTool(server, name, input);
    if (type === 'visualization') return executeVisualizationTool(server, name, input);
    if (type === 'report') return executeReportComposerTool(server, name, input);
    if (type === 'documents') return executeDocumentTool(server, name, input);
    if (type === 'data') return executeDataProcessingTool(server, name, input);
    if (type === 'format') return executeFormatConversionTool(server, name, input);
    if (type === 'im') return executeImTool(server, name, input, user);
    throw new Error('Unsupported built-in MCP server.');
}

module.exports = {
    BUILTIN_MCP_PREFIXES,
    buildChartSpec,
    buildTableBlock,
    executeBuiltinMcpTool,
    getBuiltinConfigForServer,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools,
    normalizeBuiltinPayload
};
