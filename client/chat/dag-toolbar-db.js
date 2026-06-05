/* Agent DAG 数据库工具栏辅助函数（拆自 dag-toolbar.js） */

function mcpServerIdFromTool(tool) {
        if (tool?.serverId !== undefined && tool?.serverId !== null) return String(tool.serverId || '').trim();
        const match = String(toolValue(tool) || '').match(/^mcp\.(\d+)\./);
        return match ? match[1] : '';
    }

function databaseConnectionsFromTool(tool) {
        const connections = Array.isArray(tool?.databaseConnections) ? tool.databaseConnections : [];
        if (connections.length) {
            return connections.map(item => ({
                serverId: String(item.serverId || '').trim(),
                connectionId: String(item.connectionId || item.serverId || '').trim(),
                serverName: item.serverName || `数据库 ${item.serverId || ''}`,
                databaseType: item.databaseType || '',
                fullName: item.fullName || ''
            })).filter(item => item.serverId || item.connectionId);
        }
        const serverId = mcpServerIdFromTool(tool);
        const shortName = toolShortName(tool);
        return serverId && shortName.startsWith('db.')
            ? [{
                serverId,
                connectionId: serverId,
                serverName: tool?.serverName || `数据库 ${serverId}`,
                databaseType: tool?.databaseType || '',
                fullName: toolValue(tool)
            }]
            : [];
    }

function tableNameFromRow(row) {
        return String(row?.table_name || row?.TABLE_NAME || row?.name || row?.Name || '').trim();
    }

function columnNameFromRow(row) {
        return String(row?.column_name || row?.COLUMN_NAME || row?.name || row?.Field || '').trim();
    }

function safeAlias(value, fallback = 'value') {
        const alias = String(value || '').trim().replace(/[^\w]/g, '_').replace(/^_+/, '') || fallback;
        return /^[A-Za-z_]/.test(alias) ? alias.slice(0, 64) : `${fallback}_${alias}`.slice(0, 64);
    }

function quoteWizardSqlIdentifier(value) {
        return String(value || '').split('.').map(part => {
            const clean = part.trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) return clean;
            return `\`${clean.replace(/`/g, '``')}\``;
        }).join('.');
    }

function buildWizardGroupCountSql({ table, groupBy, groupAlias, countAlias, limit }) {
        const groupIdentifier = quoteWizardSqlIdentifier(groupBy);
        const tableIdentifier = quoteWizardSqlIdentifier(table);
        return [
            `SELECT ${groupIdentifier} AS ${quoteWizardSqlIdentifier(groupAlias)}, COUNT(*) AS ${quoteWizardSqlIdentifier(countAlias)}`,
            `FROM ${tableIdentifier}`,
            `GROUP BY ${groupIdentifier}`,
            `ORDER BY ${quoteWizardSqlIdentifier(countAlias)} DESC, ${quoteWizardSqlIdentifier(groupAlias)} ASC`,
            `LIMIT ${Math.max(1, Math.min(Number(limit) || 50, 1000))}`
        ].join('\n');
    }
