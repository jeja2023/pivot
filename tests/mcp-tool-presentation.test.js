const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getMcpToolPresentation,
    presentMcpTool
} = require('../server/services/mcp-tool-presentation');
const {
    normalizeExternalServerConfig,
    normalizeToolPresentations
} = require('../server/routes/mcp/helpers');

test('MCP 工具展示中文化不改变内部名称或完整调用标识', () => {
    const source = {
        name: 'reports.read_file_summary',
        fullName: 'mcp.0.reports.read_file_summary',
        title: 'read file summary',
        description: 'Read a file summary.'
    };
    const presented = presentMcpTool(source);
    assert.equal(presented.name, 'reports.read_file_summary');
    assert.equal(presented.fullName, 'mcp.0.reports.read_file_summary');
    assert.equal(presented.displayTitle, '读取报表摘要');
    assert.equal(presented.displayDescription, '读取报表文件的元数据、工作表和样本行。');
    assert.equal(presented.searchAliases.includes('read file summary'), true);
    assert.equal(presented.searchAliases.includes('mcp.0.reports.read_file_summary'), true);
});

test('未登记的英文 MCP 名称提供中文兜底且保留英文搜索别名', () => {
    const presented = getMcpToolPresentation({
        name: 'read_file_summary',
        fullName: 'mcp.12.read_file_summary',
        description: 'Summarize a selected file.'
    });
    assert.equal(presented.displayTitle, '读取文件摘要');
    assert.equal(presented.requiresCustomPresentation, true);
    assert.equal(presented.searchAliases.includes('read_file_summary'), true);
});

test('外部工具自定义中文名称优先于内置与英文兜底', () => {
    const presented = getMcpToolPresentation({
        name: 'query_table',
        fullName: 'mcp.9.query_table',
        displayName: '查询业务订单',
        displayDescription: '按订单条件查询业务数据。',
        title: 'query table'
    });
    assert.equal(presented.displayTitle, '查询业务订单');
    assert.equal(presented.displayDescription, '按订单条件查询业务数据。');
    assert.equal(presented.hasCustomPresentation, true);
    assert.equal(presented.searchAliases.includes('query table'), true);
});

test('编辑外部 MCP 服务时保留工具中文展示配置并限制规模', () => {
    const normalized = normalizeExternalServerConfig({
        toolPresentations: {
            'query_table': { displayName: '查询业务订单', displayDescription: '按订单条件查询。' },
            'ignored': { displayName: '' }
        },
        timeoutMs: 9000
    });
    assert.deepEqual(normalized.toolPresentations, {
        query_table: { displayName: '查询业务订单', displayDescription: '按订单条件查询。' }
    });
    assert.deepEqual(normalizeToolPresentations({
        'query_table': { displayName: '查询业务订单' },
        bad: { displayName: '   ' }
    }), {
        query_table: { displayName: '查询业务订单', displayDescription: '' }
    });
});

test('从 serverConfig 中解析工具自定义展示信息', () => {
    const presented = presentMcpTool({
        name: 'sync_orders',
        fullName: 'mcp.8.sync_orders',
        title: 'sync orders',
        description: 'Sync customer orders.',
        serverConfig: JSON.stringify({
            toolPresentations: {
                sync_orders: {
                    displayName: '同步订单数据',
                    displayDescription: '定时同步客户历史订单。'
                }
            }
        })
    });
    assert.equal(presented.displayTitle, '同步订单数据');
    assert.equal(presented.displayDescription, '定时同步客户历史订单。');
    assert.equal(presented.customDisplayName, '同步订单数据');
    assert.equal(presented.hasCustomPresentation, true);
});
