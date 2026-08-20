const test = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../server/services/database-mcp/sql-governance');
const { listDataProcessingTools, executeDataProcessingTool } = require('../server/services/builtin-mcp-data');
const { listDocumentTools } = require('../server/services/builtin-mcp-documents');
const { listVisualizationTools } = require('../server/services/builtin-mcp-visualization');

test('数据库表白名单不允许跨 schema 基础名称绕过', () => {
    assert.throws(
        () => governance.assertSqlGovernance('SELECT id FROM private.users', { table_allowlist: ['public.users'] }),
        error => error.status === 403
    );
    assert.equal(governance.isTableAllowed({ schema: 'public', table_allowlist: ['users'] }, 'public.users'), true);
    assert.equal(governance.isTableAllowed({ schema: 'public', table_allowlist: ['users'] }, 'private.users'), false);
    assert.equal(governance.isTableAllowed({ database_type: 'postgres', table_allowlist: ['users'] }, 'public.users'), true);
    assert.equal(governance.isTableAllowed({ database_type: 'postgres', table_allowlist: ['users'] }, 'private.users'), false);
});

test('数据库字段白名单按 JOIN 表绑定，不允许跨表借用字段权限', () => {
    assert.throws(
        () => governance.assertSqlGovernance(
            'SELECT a.secret FROM public.a a JOIN public.b b ON a.id = b.id',
            { table_allowlist: ['public.a', 'public.b'], field_allowlist: { 'public.a': ['id'], 'public.b': ['secret'] } }
        ),
        error => error.status === 403
    );
});

test('数据库字段白名单覆盖 schema-qualified 和聚合表达式字段', () => {
    const cfg = {
        table_allowlist: ['public.orders'],
        field_allowlist: { 'public.orders': ['id', 'amount'] }
    };
    assert.doesNotThrow(() => governance.assertSqlGovernance('SELECT public.orders.id, SUM(amount) AS total FROM public.orders', cfg));
    assert.throws(
        () => governance.assertSqlGovernance('SELECT SUM(secret) AS total FROM public.orders', cfg),
        error => error.status === 403
    );
    assert.doesNotThrow(() => governance.assertSqlGovernance('SELECT COUNT(*) AS total FROM public.orders', cfg));
    assert.doesNotThrow(() => governance.assertFieldAllowed({ schema: 'public', field_allowlist: { orders: ['id'] } }, 'public.orders', 'id'));
    assert.throws(
        () => governance.assertFieldAllowed({ schema: 'private', field_allowlist: { orders: ['id'] } }, 'public.orders', 'id'),
        error => error.status === 403
    );
});

test('SQL Server CTE 查询会注入 TOP 行数上限', () => {
    assert.equal(
        governance.applySqlLimit('WITH x AS (SELECT 1 AS id) SELECT id FROM x', 10, 'sqlserver'),
        'WITH x AS (SELECT 1 AS id) SELECT TOP (10) id FROM x'
    );
});

test('工具 Schema 与执行参数保持一致，并返回截断元数据', () => {
    const viz = listVisualizationTools().find(tool => tool.name === 'viz.build_chart');
    assert.deepEqual(viz.inputSchema.required, ['rows', 'xAxis']);
    const data = listDataProcessingTools().find(tool => tool.name === 'data.filter_rows');
    assert.equal(data.inputSchema.properties.filters.type, 'object');
    const doc = listDocumentTools().find(tool => tool.name === 'doc.chunk_text');
    assert.ok(doc.inputSchema.properties.maxChars);
    const result = executeDataProcessingTool(null, 'data.group_summary', {
        rows: [{ category: 'a', value: 1 }, { category: 'b', value: 2 }],
        groupBy: 'category', valueField: 'value', aggregation: 'sum', outputLimit: 1
    });
    assert.equal(result.rowCount, 1);
    assert.equal(result.limitApplied, true);
});
