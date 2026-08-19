const { normalizePolicyIdentifier, baseIdentifier } = require('./connection-policy');

function clampLimit(value, fallback = 100, max = 1000) {
    const limit = parseInt(value || fallback, 10);
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.min(limit, max));
}

function assertReadonlySql(sql) {
    const text = String(sql || '').trim();
    if (!text) throw new Error('SQL 语句不能为空。');
    const withoutTrailingSemicolon = text.replace(/;\s*$/, '');
    if (withoutTrailingSemicolon.includes(';')) throw new Error('仅允许执行单条 SQL 语句。');
    if (!/^(select|with|show|describe|desc|explain)\b/i.test(withoutTrailingSemicolon)) {
        throw new Error('仅允许执行只读 SQL 查询语句。');
    }
    if (/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|replace|vacuum|attach|detach|copy|call|execute)\b/i.test(withoutTrailingSemicolon)) {
        throw new Error('SQL 包含被禁止的写入或管理操作关键字。');
    }
    return withoutTrailingSemicolon;
}

// 标识符合法性校验：阻断控制字符（换行、回车、制表、null 字节等）进入 SQL，
// 作为引号转义之外的防御纵深，降低标识符拼接被滥用的风险。
function assertSafeIdentifier(value) {
    if (/[\u0000-\u001F\u007F]/.test(value)) {
        const err = new Error('数据表或字段名包含非法字符。');
        err.status = 400;
        throw err;
    }
    if (value.length > 256) {
        const err = new Error('数据表或字段名超出长度限制。');
        err.status = 400;
        throw err;
    }
    return value;
}

function quoteIdentifier(identifier, quote = '"') {
    const value = String(identifier || '').trim();
    if (!value) throw new Error('标识符不能为空。');
    assertSafeIdentifier(value);
    return `${quote}${value.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`;
}

function quoteSqlIdentifierPart(identifier, dialect) {
    const value = String(identifier || '').trim();
    if (!value) throw new Error('标识符不能为空。');
    assertSafeIdentifier(value);
    if (dialect === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
    if (dialect === 'sqlserver') return `[${value.replace(/]/g, ']]')}]`;
    return quoteIdentifier(value, '"');
}

function quoteSqlIdentifier(identifier, dialect) {
    return String(identifier || '')
        .split('.')
        .map(part => quoteSqlIdentifierPart(part, dialect))
        .join('.');
}

function buildQualifiedTableName({ schema = '', table = '', dialect = 'postgres' }) {
    const cleanTable = String(table || '').trim();
    const cleanSchema = String(schema || '').trim();
    if (!cleanTable) throw new Error('数据表名称不能为空。');
    if (!cleanSchema || dialect === 'sqlite') return quoteSqlIdentifier(cleanTable, dialect);
    return `${quoteSqlIdentifier(cleanSchema, dialect)}.${quoteSqlIdentifier(cleanTable, dialect)}`;
}

function normalizeSqlAlias(value, fallback) {
    const alias = String(value || fallback || '').trim();
    if (!alias) throw new Error('别名不能为空。');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)) {
        const err = new Error('别名必须以字母或下划线开头，且仅包含字母、数字和下划线。');
        err.status = 400;
        throw err;
    }
    return alias;
}

function defaultSqlAlias(value, fallback) {
    const alias = String(value || '').trim().replace(/[^\w]/g, '_').replace(/^_+/, '').slice(0, 64);
    return /^[A-Za-z_]/.test(alias) ? alias : fallback;
}

function buildGroupCountSql(input = {}, dialect = 'postgres', fallbackSchema = '') {
    const table = String(input.table || '').trim();
    const groupBy = String(input.groupBy || input.group_by || '').trim();
    if (!table) throw new Error('数据表名称不能为空。');
    if (!groupBy) throw new Error('分组字段 groupBy 不能为空。');
    const limit = clampLimit(input.limit, 100);
    const schema = String(input.schema || fallbackSchema || '').trim();
    const countAlias = normalizeSqlAlias(input.countAlias || input.count_alias, 'count');
    const groupAlias = normalizeSqlAlias(input.groupAlias || input.group_alias, defaultSqlAlias(groupBy, 'group_value'));
    const order = String(input.sortOrder || input.sort_order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const tableName = buildQualifiedTableName({ schema, table, dialect });
    const groupIdentifier = quoteSqlIdentifier(groupBy, dialect);
    const groupAliasIdentifier = quoteSqlIdentifier(groupAlias, dialect);
    const countAliasIdentifier = quoteSqlIdentifier(countAlias, dialect);
    const selectPrefix = dialect === 'sqlserver' ? `SELECT TOP (${limit})` : 'SELECT';
    const limitClause = dialect === 'sqlserver' ? '' : `\nLIMIT ${limit}`;
    const sql = [
        `${selectPrefix} ${groupIdentifier} AS ${groupAliasIdentifier}, COUNT(*) AS ${countAliasIdentifier}`,
        `FROM ${tableName}`,
        `GROUP BY ${groupIdentifier}`,
        `ORDER BY ${countAliasIdentifier} ${order}, ${groupAliasIdentifier} ASC${limitClause}`
    ].join('\n');
    return { sql, limit, groupAlias, countAlias, table, groupBy, schema };
}

function applySqlLimit(sql, limit, dialect) {
    if (
        /\blimit\s+\d+\b/i.test(sql)
        || /^\s*select\s+top\s*(?:\(\s*\d+\s*\)|\d+\b)/i.test(sql)
        || /^\s*(show|describe|desc|explain)\b/i.test(sql)
    ) return sql;
    if (dialect === 'sqlserver') {
        return sql.replace(/^\s*select\s+/i, `SELECT TOP (${limit}) `);
    }
    return `${sql}\nLIMIT ${limit}`;
}

function hasTableAllowlist(cfg = {}) {
    return Array.isArray(cfg.table_allowlist) && cfg.table_allowlist.length > 0;
}

function hasFieldAllowlist(cfg = {}) {
    return cfg.field_allowlist && typeof cfg.field_allowlist === 'object' && Object.keys(cfg.field_allowlist).length > 0;
}

function isTableAllowed(cfg = {}, table = '') {
    if (!hasTableAllowlist(cfg)) return true;
    const target = normalizePolicyIdentifier(table);
    const targetBase = baseIdentifier(table);
    return cfg.table_allowlist.some(item => item === target || baseIdentifier(item) === targetBase);
}

function assertTableAllowed(cfg = {}, table = '') {
    if (!String(table || '').trim()) return;
    if (!isTableAllowed(cfg, table)) {
        const err = new Error(`数据表 ${table} 不在允许访问的表白名单内。`);
        err.status = 403;
        throw err;
    }
}

function allowedFieldsForTable(cfg = {}, table = '') {
    if (!hasFieldAllowlist(cfg)) return [];
    const fields = cfg.field_allowlist || {};
    const key = normalizePolicyIdentifier(table);
    const base = baseIdentifier(table);
    return Array.from(new Set([
        ...(fields['*'] || []),
        ...(fields[key] || []),
        ...(fields[base] || [])
    ].map(normalizePolicyIdentifier).filter(Boolean)));
}

function assertFieldAllowed(cfg = {}, table = '', field = '') {
    if (!hasFieldAllowlist(cfg)) return;
    const allowed = allowedFieldsForTable(cfg, table);
    const target = normalizePolicyIdentifier(field);
    if (!allowed.includes(target) && !allowed.includes(baseIdentifier(field))) {
        const err = new Error(`字段 ${field} 不在 ${table || '当前表'} 的字段白名单内。`);
        err.status = 403;
        throw err;
    }
}

function getTableNameFromRow(row = {}) {
    return row.table_name || row.name || row.TABLE_NAME || row.table || '';
}

function getColumnNameFromRow(row = {}) {
    return row.column_name || row.name || row.COLUMN_NAME || '';
}

function filterTableRows(rows = [], cfg = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!hasTableAllowlist(cfg)) return list;
    return list.filter(row => isTableAllowed(cfg, getTableNameFromRow(row)));
}

function summarizeTableRows(rows = []) {
    const grouped = new Map();
    rows.forEach(row => {
        const type = String(row.table_type || row.type || row.TABLE_TYPE || 'table');
        grouped.set(type, (grouped.get(type) || 0) + 1);
    });
    const resultRows = Array.from(grouped.entries()).map(([type, total]) => ({ type, total }));
    return { total: rows.length, rows: resultRows };
}

function filterDescribeRows(rows = [], cfg = {}, table = '') {
    const list = Array.isArray(rows) ? rows : [];
    if (!hasFieldAllowlist(cfg)) return list;
    const allowed = allowedFieldsForTable(cfg, table);
    return list.filter(row => {
        const column = normalizePolicyIdentifier(getColumnNameFromRow(row));
        return allowed.includes(column) || allowed.includes(baseIdentifier(column));
    });
}

function isSensitiveField(cfg = {}, key = '') {
    const fields = Array.isArray(cfg.sensitive_fields) ? cfg.sensitive_fields : [];
    if (!fields.length) return false;
    const target = normalizePolicyIdentifier(key);
    const targetBase = baseIdentifier(key);
    return fields.some(field => field === target || baseIdentifier(field) === targetBase);
}

function maskSensitiveRows(rows, cfg = {}) {
    if (!Array.isArray(rows) || !(cfg.sensitive_fields || []).length) return rows;
    return rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const masked = {};
        Object.entries(row).forEach(([key, value]) => {
            masked[key] = isSensitiveField(cfg, key) ? '[已脱敏]' : value;
        });
        return masked;
    });
}

function splitTopLevelCsv(text = '') {
    const parts = [];
    let current = '';
    let depth = 0;
    let quote = '';
    String(text || '').split('').forEach(ch => {
        if (quote) {
            current += ch;
            if (ch === quote) quote = '';
            return;
        }
        if (['"', "'", '`'].includes(ch)) {
            quote = ch;
            current += ch;
            return;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            return;
        }
        current += ch;
    });
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function extractSqlTables(sql = '') {
    const tables = [];
    const text = String(sql || '').replace(/["'`]/g, '');
    const pattern = /\b(?:from|join|describe|desc)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/ig;
    let match;
    while ((match = pattern.exec(text))) {
        const value = normalizePolicyIdentifier(match[1]);
        if (value && !tables.includes(value)) tables.push(value);
    }
    return tables;
}

function extractSelectFields(sql = '') {
    const text = String(sql || '').trim();
    const match = text.match(/^\s*select\s+(.+?)\s+from\s+/is);
    if (!match) return [];
    return splitTopLevelCsv(match[1]).map(item => {
        const withoutAlias = item
            .replace(/\s+as\s+[A-Za-z_][\w$]*$/i, '')
            .replace(/\s+[A-Za-z_][\w$]*$/i, '')
            .trim();
        if (withoutAlias === '*') return '*';
        const identifierMatch = withoutAlias.match(/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/);
        return identifierMatch ? baseIdentifier(identifierMatch[0]) : '';
    }).filter(Boolean);
}

function assertSqlGovernance(sql = '', cfg = {}) {
    const tables = extractSqlTables(sql);
    if (hasTableAllowlist(cfg) && /^\s*select\b/i.test(sql) && tables.length === 0) {
        const err = new Error('表白名单已启用，复杂 SQL 需要改写为能明确识别 FROM/JOIN 表名的查询。');
        err.status = 403;
        throw err;
    }
    tables.forEach(table => assertTableAllowed(cfg, table));
    if (hasFieldAllowlist(cfg)) {
        const fields = extractSelectFields(sql);
        if (fields.includes('*')) {
            const err = new Error('字段白名单已启用，请使用明确字段名，不能 SELECT *。');
            err.status = 403;
            throw err;
        }
        if (/^\s*select\b/i.test(sql) && fields.length === 0) {
            const err = new Error('字段白名单已启用，复杂 SQL 需要改写为明确列名的 SELECT。');
            err.status = 403;
            throw err;
        }
        fields.forEach(field => {
            if (!/^\d+$/.test(field)) {
                const allowed = tables.length
                    ? tables.some(table => {
                        try {
                            assertFieldAllowed(cfg, table, field);
                            return true;
                        } catch (e) {
                            return false;
                        }
                    })
                    : allowedFieldsForTable(cfg, '*').includes(normalizePolicyIdentifier(field));
                if (!allowed) {
                    const err = new Error(`字段 ${field} 不在字段白名单内。`);
                    err.status = 403;
                    throw err;
                }
            }
        });
    }
    return { tables };
}

function buildDatabaseCost(cfg = {}, details = {}) {
    const governance = {
        tableAllowlistActive: hasTableAllowlist(cfg),
        fieldAllowlistActive: hasFieldAllowlist(cfg),
        sensitiveMaskingActive: Array.isArray(cfg.sensitive_fields) && cfg.sensitive_fields.length > 0,
        rowPolicyHint: cfg.row_policy_hint || '',
        queryTimeoutMs: cfg.query_timeout_ms || 20000
    };
    if (cfg.sql_cost_estimate === false) return { governance };
    return {
        governance,
        cost: {
            operation: details.operation || 'query',
            databaseType: cfg.database_type,
            tables: details.tables || [],
            fields: details.fields || [],
            limit: details.limit || cfg.max_rows || 100,
            boundedByLimit: true,
            estimate: '轻量估算：实际扫描成本取决于数据库执行计划、索引和过滤条件。'
        }
    };
}

module.exports = {
    clampLimit,
    assertReadonlySql,
    assertSafeIdentifier,
    quoteIdentifier,
    quoteSqlIdentifierPart,
    quoteSqlIdentifier,
    buildQualifiedTableName,
    normalizeSqlAlias,
    defaultSqlAlias,
    buildGroupCountSql,
    applySqlLimit,
    hasTableAllowlist,
    hasFieldAllowlist,
    isTableAllowed,
    assertTableAllowed,
    allowedFieldsForTable,
    assertFieldAllowed,
    getTableNameFromRow,
    getColumnNameFromRow,
    filterTableRows,
    summarizeTableRows,
    filterDescribeRows,
    isSensitiveField,
    maskSensitiveRows,
    splitTopLevelCsv,
    extractSqlTables,
    extractSelectFields,
    assertSqlGovernance,
    buildDatabaseCost
};
