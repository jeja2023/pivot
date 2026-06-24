
const { MAX_UPLOAD_ROWS } = require('./shared');
const { createDatasetFromRows } = require('./datasets');

const MAX_DB_IMPORT_ROWS = Math.min(MAX_UPLOAD_ROWS, Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_DB_IMPORT_MAX_ROWS || '50000', 10) || 50000));

// 从已配置的 MCP 数据库连接导入：执行只读查询（或对整表的 SELECT），把返回行落成数据集。
// 安全：仅复用现有数据库 MCP 工具链（只读校验、白名单治理、脱敏、SSRF 守卫都在其中），
// 本函数不直接连库。limit 受 MAX_DB_IMPORT_ROWS 上限保护。
async function importFromDatabase({ user, mcpServerId, sql, table, schema, limit, name }) {
    // 延迟引入，避免与 mcp-client 之间形成模块加载环。
    const { getAccessibleMcpServer } = require('./mcp-client');
    const { executeDatabaseMcpTool } = require('./database-mcp');

    const serverId = Number(mcpServerId);
    if (!serverId) {
        const err = new Error('请选择一个数据库连接。');
        err.status = 400;
        throw err;
    }
    const server = getAccessibleMcpServer(serverId, user);
    if (!server || String(server.base_url || '').indexOf('pivot-db://') !== 0) {
        const err = new Error('数据库连接不存在或无权访问。');
        err.status = 404;
        throw err;
    }
    const safeLimit = Math.min(Math.max(Number(limit) || MAX_DB_IMPORT_ROWS, 1), MAX_DB_IMPORT_ROWS);
    let result;
    const trimmedSql = String(sql || '').trim();
    const trimmedTable = String(table || '').trim();
    if (trimmedSql) {
        result = await executeDatabaseMcpTool(server, 'db.run_readonly_query', { sql: trimmedSql, limit: safeLimit });
    } else if (trimmedTable) {
        // 无显式 SQL 时，对指定表做一次受限的全列 SELECT（由 db.run_readonly_query 内部治理与限行）。
        const safeIdent = `"${trimmedTable.replace(/"/g, '""')}"`;
        const qualified = schema ? `"${String(schema).replace(/"/g, '""')}".${safeIdent}` : safeIdent;
        result = await executeDatabaseMcpTool(server, 'db.run_readonly_query', { sql: `SELECT * FROM ${qualified}`, limit: safeLimit });
    } else {
        const err = new Error('请提供要导入的 SQL 查询或数据表名。');
        err.status = 400;
        throw err;
    }
    const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    const datasetName = name || trimmedTable || `${server.name || '数据库'}导入`;
    return createDatasetFromRows({ user, name: datasetName, rows, sourceType: 'database' });
}

module.exports = {
    importFromDatabase
};
