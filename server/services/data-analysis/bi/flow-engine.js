'use strict';

const { sqlIdentifier: sqlIdent, sqlLiteral, decimalProjection } = require('./sql-expressions');
const { validateFlowExpression, validateFlowCustomSql, invalidFlow } = require('./flow-functions');

function numberProjection(expression) {
    return decimalProjection(expression, { precision: 38, scale: 8, allowThousands: true, allowCurrency: true, allowPercent: true });
}

function averageProjection(value) {
    // 使用八位定点整数求商并按半值远离零舍入，避免金额均值先进入浮点数丢失尾数。
    const numerator = `CAST(replace(CAST(SUM(${value}) AS VARCHAR),'.','') AS HUGEINT)`;
    const count = `NULLIF(COUNT(${value}),0)`;
    const rounded = `(abs(${numerator}) // ${count} + CASE WHEN (abs(${numerator}) % ${count}) * 2 >= ${count} THEN 1 ELSE 0 END)`;
    return `CAST((CASE WHEN ${numerator}<0 THEN '-' ELSE '' END) || CAST(${rounded} // 100000000 AS VARCHAR) || '.' || lpad(CAST(${rounded} % 100000000 AS VARCHAR),8,'0') AS DECIMAL(38,8))`;
}

function buildFilterClause(condition, availableColumns) {
    const field = condition.field;
    if (!field) return null;
    if (!availableColumns.has(field)) invalidFlow(`筛选条件引用的字段「${field}」在上游输出中不存在。`);
    const colExpr = sqlIdent(field);
    const textExpr = `CAST(${colExpr} AS VARCHAR)`;
    const op = condition.operator;
    if (op === 'is_null') return `(${colExpr} IS NULL OR TRIM(${textExpr}) = '')`;
    if (op === 'is_not_null') return `(${colExpr} IS NOT NULL AND TRIM(${textExpr}) <> '')`;
    const rawVal = String(condition.value ?? '');
    if (op === 'contains') return `contains(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'starts_with') return `starts_with(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'ends_with') return `ends_with(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'in') {
        const items = rawVal.split(/[\n,，]/).map(item => item.trim()).filter(Boolean).slice(0, 200);
        if (!items.length) invalidFlow(`字段「${field}」的属于列表条件需要至少填写一个值。`);
        if (condition.valueType === 'number') {
            if (items.some(item => !/^[+-]?\d+(?:\.\d+)?$/.test(item))) invalidFlow('数值列表只能填写十进制数值，请检查筛选条件。');
            return `(${numberProjection(colExpr).sql} IN (${items.map(item => numberProjection(sqlLiteral(item)).sql).join(',')}))`;
        }
        return `(${textExpr} IN (${items.map(sqlLiteral).join(', ')}))`;
    }
    const numeric = /^[+-]?\d+(?:\.\d+)?$/.test(rawVal.trim());
    if (condition.valueType === 'number' && !numeric) invalidFlow(`字段「${field}」的数值条件无效，请填写十进制数值。`);
    const useNumeric = condition.valueType === 'number' || condition.valueType !== 'text' && numeric;
    const numExpr = numberProjection(colExpr).sql;
    const valueExpr = numberProjection(sqlLiteral(rawVal.trim())).sql;
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && useNumeric) {
        const symbol = ({ gt: '>', gte: '>=', lt: '<', lte: '<=' })[op];
        return `(${numExpr} ${symbol} ${valueExpr})`;
    }
    const symbol = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' })[op] || '=';
    if (['eq', 'neq'].includes(op) && useNumeric) {
        const equal = condition.valueType === 'number'
            ? `${numExpr} = ${valueExpr}`
            : `(${textExpr} = ${sqlLiteral(rawVal.trim())} OR COALESCE(${numExpr} = ${valueExpr}, FALSE))`;
        return op === 'neq' ? `(NOT (${equal}))` : `(${equal})`;
    }
    return `(${textExpr} ${symbol} ${sqlLiteral(rawVal)})`;
}

function formatDuckError(nodeName, error) {
    if (error?.code === 'ANALYSIS_MODEL_FLOW_INVALID') throw error;
    const raw = String(error?.message || '算子执行失败');
    let friendly = '计算未完成，请检查字段配置、数据规模或联系维护者。';
    if (/overflow|out of range/i.test(raw)) {
        friendly = '数值超出可表示的十进制范围，请调整精度或缩小统计范围。';
    }
    if (/Binder Error|No function matches|argument types/i.test(raw)) {
        friendly = '表达式或关联字段类型不匹配，数值运算建议使用 TRY_CAST("字段名" AS DOUBLE) 转换后再计算。';
    } else if (/Referenced column|not found|Catalog Error/i.test(raw)) {
        friendly = '引用的字段或上游表名不存在，请核对字段名并用双引号包裹（自定义 SQL 请查询 input_1、input_2）。';
    } else if (/Parser Error|syntax error/i.test(raw)) {
        friendly = '表达式或自定义 SQL 存在语法错误，请检查括号、引号和函数参数格式。';
    }
    return invalidFlow(`节点「${nodeName}」执行失败：${friendly}`);
}

async function describeTableColumns(connection, viewOrTableName) {
    const rows = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${sqlIdent(viewOrTableName)}`)).getRowObjectsJson();
    return rows.map(row => ({
        name: String(row.column_name),
        type: String(row.column_type || 'VARCHAR')
    }));
}

async function countRows(connection, viewOrTableName) {
    const rows = (await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${sqlIdent(viewOrTableName)}`)).getRowObjectsJson();
    const count = Number(rows[0]?.n || 0);
    if (!Number.isSafeInteger(count) || count < 0) invalidFlow('节点行数超过可精确表示的范围，请先缩小 SQL 或关联范围。');
    return count;
}

async function compileAndMaterializePlan(connection, plan, datasetTableMap) {
    const stepTables = new Map();
    const stepSchemas = new Map();

    for (let index = 0; index < plan.ordered.length; index += 1) {
        const node = plan.ordered[index];
        const stepName = `__flow_step_${index}`;
        const upIds = plan.incoming.get(node.id) || [];
        const upTables = upIds.map(upId => stepTables.get(upId));

        try {
            if (node.isDefinitionNode || node.kind === 'source') {
                const datasetId = node.datasetId || node.config?.datasetId;
                const rawTable = datasetTableMap.get(datasetId);
                if (!rawTable) invalidFlow(`节点「${node.name}」尚未选择有效的来源数据集。`);
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT * FROM ${sqlIdent(rawTable)}`
                );
            } else if (node.kind === 'filter') {
                if (upTables.length !== 1) invalidFlow(`筛选节点「${node.name}」需要连接 1 个上游输入节点。`);
                const cols = new Set((stepSchemas.get(upIds[0]) || []).map(col => col.name));
                const clauses = (node.config.conditions || [])
                    .map(cond => buildFilterClause(cond, cols))
                    .filter(Boolean);
                const joiner = node.config.match === 'any' ? ' OR ' : ' AND ';
                const whereSql = clauses.length ? `WHERE ${clauses.join(joiner)}` : '';
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT * FROM ${sqlIdent(upTables[0])} ${whereSql}`
                );
            } else if (node.kind === 'formula') {
                if (upTables.length !== 1) invalidFlow(`字段计算节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const validFields = (node.config.fields || []).filter(f => f.name && f.expression);
                if (!validFields.length) invalidFlow(`字段计算节点「${node.name}」请至少配置一个计算字段与函数表达式。`);
                const replacedNames = new Set(validFields.map(f => f.name));
                const keptSelects = node.config.keepAll !== false
                    ? upstreamCols.filter(col => !replacedNames.has(col.name)).map(col => sqlIdent(col.name))
                    : [];
                const computedSelects = validFields.map(f => {
                    const expr = validateFlowExpression(f.expression, colSet);
                    return `(${expr}) AS ${sqlIdent(f.name)}`;
                });
                const selectSql = [...keptSelects, ...computedSelects].join(', ');
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${selectSql} FROM ${sqlIdent(upTables[0])}`
                );
            } else if (node.kind === 'join') {
                if (upTables.length !== 2) invalidFlow(`多表关联节点「${node.name}」需要连接 2 个上游输入节点（左表与右表）。`);
                const leftCols = stepSchemas.get(upIds[0]) || [];
                const rightCols = stepSchemas.get(upIds[1]) || [];
                const leftSet = new Set(leftCols.map(col => col.name));
                const rightSet = new Set(rightCols.map(col => col.name));
                const validPairs = (node.config.keyPairs || []).filter(p => p.leftField && p.rightField);
                if (!validPairs.length) invalidFlow(`多表关联节点「${node.name}」请至少配置一对关联字段。`);
                for (const pair of validPairs) {
                    if (!leftSet.has(pair.leftField)) invalidFlow(`左表中不存在关联字段「${pair.leftField}」。`);
                    if (!rightSet.has(pair.rightField)) invalidFlow(`右表中不存在关联字段「${pair.rightField}」。`);
                }
                const rightNodeName = plan.ordered.find(item => item.id === upIds[1])?.name || '右表';
                const leftSelect = leftCols.map(col => `l.${sqlIdent(col.name)} AS ${sqlIdent(col.name)}`);
                const rightSelect = rightCols.map(col => {
                    const outName = leftSet.has(col.name) ? `${rightNodeName}_${col.name}` : col.name;
                    return `r.${sqlIdent(col.name)} AS ${sqlIdent(outName)}`;
                });
                const onSql = validPairs
                    .map(p => `CAST(l.${sqlIdent(p.leftField)} AS VARCHAR) = CAST(r.${sqlIdent(p.rightField)} AS VARCHAR)`)
                    .join(' AND ');
                const joinKeyword = ({ left: 'LEFT JOIN', inner: 'INNER JOIN', right: 'RIGHT JOIN', full: 'FULL OUTER JOIN' })[node.config.joinType] || 'LEFT JOIN';
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${[...leftSelect, ...rightSelect].join(', ')} FROM ${sqlIdent(upTables[0])} l ${joinKeyword} ${sqlIdent(upTables[1])} r ON ${onSql}`
                );
            } else if (node.kind === 'aggregate') {
                if (upTables.length !== 1) invalidFlow(`分组聚合节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const groupBy = (node.config.groupBy || []).filter(Boolean);
                for (const g of groupBy) {
                    if (!colSet.has(g)) invalidFlow(`分组字段「${g}」在上游输出中不存在。`);
                }
                const aggs = (node.config.aggregations || []).filter(a => a.fn === 'count' || a.field);
                if (!aggs.length) invalidFlow(`分组聚合节点「${node.name}」请至少配置一项汇总统计指标。`);
                const fnLabels = { sum: '求和', avg: '均值', count: '记录数', count_distinct: '去重数', min: '最小值', max: '最大值' };
                for (const agg of aggs) {
                    if (!['sum', 'avg', 'min', 'max'].includes(agg.fn) || agg.valueType === 'text') continue;
                    if (!colSet.has(agg.field)) invalidFlow(`聚合字段「${agg.field}」在上游输出中不存在。`);
                    const check = (await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${sqlIdent(upTables[0])} WHERE ${numberProjection(sqlIdent(agg.field)).invalidSql}`)).getRowObjectsJson()[0];
                    if (Number(check.n)) invalidFlow(`字段「${agg.field}」存在无法转换的数值，请先清洗；文本最大值、最小值请选择文本统计。`);
                }
                const aggSelects = aggs.map(agg => {
                    if (agg.fn !== 'count' && !colSet.has(agg.field)) {
                        invalidFlow(`聚合字段「${agg.field}」在上游输出中不存在。`);
                    }
                    const alias = agg.alias || (agg.fn === 'count' ? '记录条数' : `${agg.field}_${fnLabels[agg.fn] || agg.fn}`);
                    const colIdent = agg.field ? sqlIdent(agg.field) : '';
                    const value = agg.valueType === 'text' ? colIdent : numberProjection(colIdent).sql;
                    let expr = 'COUNT(*)';
                    if (agg.fn === 'count_distinct') expr = `COUNT(DISTINCT ${colIdent})`;
                    else if (agg.fn === 'sum') expr = `SUM(${value})`;
                    else if (agg.fn === 'avg') expr = averageProjection(value);
                    else if (agg.fn === 'min') expr = `MIN(${value})`;
                    else if (agg.fn === 'max') expr = `MAX(${value})`;
                    return `${expr} AS ${sqlIdent(alias)}`;
                });
                const selectParts = [...groupBy.map(g => sqlIdent(g)), ...aggSelects];
                const groupSql = groupBy.length ? `GROUP BY ${groupBy.map(g => sqlIdent(g)).join(', ')}` : '';
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${selectParts.join(', ')} FROM ${sqlIdent(upTables[0])} ${groupSql}`
                );
            } else if (node.kind === 'select') {
                if (upTables.length !== 1) invalidFlow(`字段清洗节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const activeCols = (node.config.columns || []).filter(c => c.enabled !== false && c.field);
                if ((node.config.columns || []).length && !activeCols.length) invalidFlow(`字段清洗节点「${node.name}」已取消全部字段，请至少保留一列。`);
                const chosen = activeCols.length
                    ? activeCols.map(c => {
                        if (!colSet.has(c.field)) invalidFlow(`选择的字段「${c.field}」在上游输出中不存在。`);
                        return `${sqlIdent(c.field)} AS ${sqlIdent(c.alias || c.field)}`;
                    })
                    : upstreamCols.map(col => sqlIdent(col.name));
                const distinctKeyword = node.config.deduplicate ? 'DISTINCT ' : '';
                let orderSql = '';
                if (node.config.sortField) {
                    const outNames = new Set(activeCols.length ? activeCols.map(c => c.alias || c.field) : upstreamCols.map(c => c.name));
                    if (outNames.has(node.config.sortField) || colSet.has(node.config.sortField)) {
                        orderSql = ` ORDER BY ${sqlIdent(node.config.sortField)} ${node.config.sortDirection === 'desc' ? 'DESC' : 'ASC'}`;
                    }
                }
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${distinctKeyword}${chosen.join(', ')} FROM ${sqlIdent(upTables[0])}${orderSql}`
                );
            } else if (node.kind === 'union') {
                if (upTables.length < 2) invalidFlow(`上下合并节点「${node.name}」需要连接至少 2 个上游输入节点。`);
                const unionOp = node.config.mode === 'distinct'
                    ? (node.config.byName !== false ? 'UNION BY NAME' : 'UNION')
                    : (node.config.byName !== false ? 'UNION ALL BY NAME' : 'UNION ALL');
                const unionSql = upTables.map(tbl => `SELECT * FROM ${sqlIdent(tbl)}`).join(` ${unionOp} `);
                await connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS ${unionSql}`
                );
            } else if (node.kind === 'sql') {
                if (!upTables.length) invalidFlow(`自定义 SQL 节点「${node.name}」请至少连接 1 个上游输入节点（在 SQL 中使用 input_1 引用）。`);
                const userSql = validateFlowCustomSql(node.config.sql);
                for (let i = 0; i < upTables.length; i += 1) {
                    await connection.run(
                        `CREATE OR REPLACE TEMP VIEW ${sqlIdent(`input_${i + 1}`)} AS SELECT * FROM ${sqlIdent(upTables[i])}`
                    );
                }
                await connection.run(
                    `CREATE OR REPLACE TEMP VIEW "input" AS SELECT * FROM ${sqlIdent(upTables[0])}`
                );
                await connection.run(
                    `CREATE TEMP TABLE ${sqlIdent(stepName)} AS ${userSql}`
                );
            }
            const schema = await describeTableColumns(connection, stepName);
            stepTables.set(node.id, stepName);
            stepSchemas.set(node.id, schema);
        } catch (error) {
            formatDuckError(node.name, error);
        }
    }

    return { stepTables, stepSchemas };
}


module.exports = { compileAndMaterializePlan, countRows };
