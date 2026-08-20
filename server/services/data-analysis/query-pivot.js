
const {
    MAX_PREVIEW_ROWS,
    MAX_QUERY_LIMIT,
    DATA_ANALYSIS_QUERY_TIMEOUT_MS,
    MAX_SQL_LEN,
    MAX_PIVOT_ROWS,
    MAX_PIVOT_COLS,
    jsonParse,
    getDatasetForUser,
    getColumn,
    normalizeAggregation,
    getDatasetPaths,
    sqlIdent,
    sqlLiteral,
    withAnalysisSlot,
    recordArtifact,
    createDuckConnection,
    withDuckTimeout,
    isMetricNumericColumn
} = require('./shared');

const CELL_KEY_SEPARATOR = '\u001F';

const DEFAULT_PIVOT_EMPTY_LABEL = '(空值)';

const PIVOT_AGGREGATION_LABELS = { sum: '求和', count: '计数', avg: '平均', min: '最小', max: '最大' };

function clampInteger(value, min, max, fallback) {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(Math.max(num, min), max);
  }

function normalizePivotSort(value) {
    const sort = String(value || '').toLowerCase();
    if (['total_desc', 'total_asc', 'label_asc', 'label_desc'].includes(sort)) return sort;
    return 'total_desc';
  }

function normalizePivotEmptyLabel(value) {
    const label = String(value || '').trim();
    return (label || DEFAULT_PIVOT_EMPTY_LABEL).slice(0, 40);
  }

function buildPivotLabelExpr(column, emptyLabel) {
    return `COALESCE(NULLIF(TRIM(CAST(${sqlIdent(column.key)} AS VARCHAR)), ''), ${sqlLiteral(emptyLabel)})`;
  }

function toPivotNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

function comparePivotLabel(a, b) {
    return String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
  }

function sortPivotLabels(totals, sortBy) {
    const entries = Array.from(totals.entries()).map(([label, value]) => [String(label), toPivotNumber(value)]);
    return entries.sort((a, b) => {
        if (sortBy === 'label_asc') return comparePivotLabel(a[0], b[0]);
        if (sortBy === 'label_desc') return comparePivotLabel(b[0], a[0]);
        const diff = sortBy === 'total_asc' ? a[1] - b[1] : b[1] - a[1];
        return diff || comparePivotLabel(a[0], b[0]);
    }).map(entry => entry[0]);
  }

function pivotTotalsMap(records, key = 'label') {
    const totals = new Map();
    (records || []).forEach(record => {
        totals.set(String(record[key]), toPivotNumber(record.value));
    });
    return totals;
  }

function pivotTopItems(labels, totals, grandTotal, { limit = 5, additive = true } = {}) {
    const denominator = Math.abs(toPivotNumber(grandTotal));
    return labels.slice(0, limit).map((label, index) => {
        const value = toPivotNumber(totals.get(label));
        return {
            label,
            value,
            share: additive && denominator ? Math.abs(value) / denominator : null,
            rank: index + 1
        };
    });
}

async function readPivotRows(connection, sql) {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson();
  }

async function runPivot(userId, datasetId, input = {}) {
    const row = await getDatasetForUser(userId, datasetId);
    const rowCol = getColumn(row, input.rowField);
    const colField = String(input.colField || '').trim();
    const colCol = colField ? getColumn(row, colField) : null;
    const valueField = String(input.valueField || '').trim();
    const valueCol = valueField ? getColumn(row, valueField) : null;
    const aggregation = normalizeAggregation(input.aggregation, Boolean(valueCol));
    if (aggregation !== 'count' && !valueCol) {
        const err = new Error('求和、平均、最小、最大聚合需要选择值字段。');
        err.status = 400;
        throw err;
    }

    const rowLimit = clampInteger(input.rowLimit ?? input.limit, 1, MAX_PIVOT_ROWS, Math.min(50, MAX_PIVOT_ROWS));
    const colLimit = clampInteger(input.colLimit, 1, MAX_PIVOT_COLS, Math.min(20, MAX_PIVOT_COLS));
    const sortBy = normalizePivotSort(input.sortBy || input.sort);
    const emptyLabel = normalizePivotEmptyLabel(input.emptyLabel);
    const { parquetPath } = getDatasetPaths(row);
    const valueExpr = aggregation === 'count'
        ? 'COUNT(*)'
        : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(valueCol.key)} AS DOUBLE))`;
    const fromExpr = `FROM read_parquet(${sqlLiteral(parquetPath)})`;
    const rowLabelExpr = buildPivotLabelExpr(rowCol, emptyLabel);
    const colLabelExpr = colCol ? buildPivotLabelExpr(colCol, emptyLabel) : sqlLiteral('合计');
    const cellSql = `
        SELECT ${rowLabelExpr} AS row_label, ${colLabelExpr} AS col_label, ${valueExpr} AS value
        ${fromExpr}
        GROUP BY row_label, col_label
    `;
    const rowTotalSql = `
        SELECT ${rowLabelExpr} AS label, ${valueExpr} AS value
        ${fromExpr}
        GROUP BY label
    `;
    const colTotalSql = colCol ? `
        SELECT ${colLabelExpr} AS label, ${valueExpr} AS value
        ${fromExpr}
        GROUP BY label
    ` : `
        SELECT ${sqlLiteral('合计')} AS label, ${valueExpr} AS value
        ${fromExpr}
    `;
    const grandSql = `SELECT ${valueExpr} AS value ${fromExpr}`;

    const { cellRecords, rowTotalRecords, colTotalRecords, grandRecords } = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const cells = await readPivotRows(connection, cellSql);
            const rowTotals = await readPivotRows(connection, rowTotalSql);
            const colTotals = await readPivotRows(connection, colTotalSql);
            const grand = await readPivotRows(connection, grandSql);
            return {
                cellRecords: cells,
                rowTotalRecords: rowTotals,
                colTotalRecords: colTotals,
                grandRecords: grand
            };
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });

    const rowTotals = pivotTotalsMap(rowTotalRecords);
    const colTotals = pivotTotalsMap(colTotalRecords);
    const grandTotal = toPivotNumber(grandRecords?.[0]?.value);
    const allRowLabels = sortPivotLabels(rowTotals, sortBy);
    const allColLabels = colCol ? sortPivotLabels(colTotals, sortBy) : ['合计'];
    const rowLabels = allRowLabels.slice(0, rowLimit);
    const colLabels = allColLabels.slice(0, colLimit);
    const truncatedRows = allRowLabels.length > rowLabels.length;
    const truncatedColumns = allColLabels.length > colLabels.length;
    const truncated = truncatedRows || truncatedColumns;

    const aggregationLabel = PIVOT_AGGREGATION_LABELS[aggregation] || aggregation;
    const additiveAggregation = aggregation === 'sum' || aggregation === 'count';
    const totalLabel = additiveAggregation ? '合计' : aggregationLabel;

    const cellMap = new Map();
    cellRecords.forEach(record => {
        cellMap.set(`${record.row_label}${CELL_KEY_SEPARATOR}${record.col_label}`, toPivotNumber(record.value));
    });
    const rows = rowLabels.map((label, index) => {
        const values = {};
        colLabels.forEach(col => {
            values[col] = cellMap.get(`${label}${CELL_KEY_SEPARATOR}${col}`) || 0;
        });
        const total = rowTotals.get(label) || 0;
        return {
            label,
            values,
            total,
            share: additiveAggregation && grandTotal ? Math.abs(total) / Math.abs(grandTotal) : null,
            rank: index + 1
        };
    });
    const colTotalsObj = {};
    colLabels.forEach(col => {
        colTotalsObj[col] = colTotals.get(col) || 0;
    });
    const result = {
        rowField: { key: rowCol.key, name: rowCol.name },
        colField: colCol ? { key: colCol.key, name: colCol.name } : null,
        valueField: valueCol ? { key: valueCol.key, name: valueCol.name } : null,
        aggregation,
        aggregationLabel,
        totalLabel,
        columns: colLabels,
        rows,
        colTotals: colTotalsObj,
        grandTotal,
        truncated,
        truncatedRows,
        truncatedColumns,
        totalRowCount: allRowLabels.length,
        totalColumnCount: allColLabels.length,
        displayedRowCount: rowLabels.length,
        displayedColumnCount: colLabels.length,
        omittedRows: Math.max(0, allRowLabels.length - rowLabels.length),
        omittedColumns: Math.max(0, allColLabels.length - colLabels.length),
        totalsIncludeHidden: truncated,
        topRows: pivotTopItems(allRowLabels, rowTotals, grandTotal, { additive: additiveAggregation }),
        topColumns: colCol ? pivotTopItems(allColLabels, colTotals, grandTotal, { additive: additiveAggregation }) : [],
        display: {
            rowLimit,
            colLimit,
            sortBy,
            emptyLabel,
            percentMode: String(input.percentMode || 'none')
        },
        source: {
            rowCount: Number(row.row_count) || 0,
            columnCount: Number(row.column_count) || 0
        }
    };
    await recordArtifact({
        userId,
        datasetId,
        type: 'pivot',
        title: `${rowCol.name}${colCol ? ` × ${colCol.name}` : ''} ${aggregation === 'count' ? '计数' : valueCol?.name || ''}`.trim(),
        content: JSON.stringify({
            rowField: rowCol.key,
            colField: colCol?.key || '',
            valueField: valueCol?.key || '',
            aggregation,
            rowLimit,
            colLimit,
            sortBy,
            emptyLabel
        }),
        metadata: { aggregation, truncated, truncatedRows, truncatedColumns, rowLimit, colLimit, sortBy }
    });
    return result;
  }

const SQL_BLOCKLIST = /\b(ATTACH|DETACH|COPY|INSTALL|LOAD|PRAGMA|SET|RESET|EXPORT|IMPORT|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CALL|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_text|read_blob|parquet_scan|glob|system|getenv)\b/i;

function validateUserSql(sql) {
    const raw = String(sql || '').trim();
    if (!raw) {
        const err = new Error('\u8BF7\u8F93\u5165\u67E5\u8BE2\u8BED\u53E5\u3002');
        err.status = 400;
        throw err;
    }
    if (raw.length > MAX_SQL_LEN) {
        const err = new Error(`\u67E5\u8BE2\u8BED\u53E5\u8FC7\u957F\uFF08\u4E0A\u9650 ${MAX_SQL_LEN} \u5B57\u7B26\uFF09\u3002`);
        err.status = 400;
        throw err;
    }
    // \u53BB\u6389\u5355\u4E2A\u5C3E\u90E8\u5206\u53F7\u540E\uFF0C\u82E5\u4ECD\u542B\u5206\u53F7\u5219\u89C6\u4E3A\u591A\u8BED\u53E5\uFF0C\u62D2\u7EDD\u3002
    const stripped = raw.replace(/;\s*$/, '');
    if (stripped.includes(';')) {
        const err = new Error('\u4EC5\u652F\u6301\u5355\u6761\u67E5\u8BE2\u8BED\u53E5\u3002');
        err.status = 400;
        throw err;
    }
    if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) {
        const err = new Error('\u4EC5\u652F\u6301\u4EE5 SELECT \u6216 WITH \u5F00\u5934\u7684\u53EA\u8BFB\u67E5\u8BE2\u3002');
        err.status = 400;
        throw err;
    }
    if (SQL_BLOCKLIST.test(stripped)) {
        const err = new Error('\u67E5\u8BE2\u5305\u542B\u4E0D\u5141\u8BB8\u7684\u5173\u952E\u5B57\uFF0C\u4EC5\u652F\u6301\u5BF9\u5F53\u524D\u6570\u636E\u96C6\u7684\u53EA\u8BFB\u67E5\u8BE2\u3002');
        err.status = 400;
        throw err;
    }
    return stripped;
}

function buildQuerySelectList(row, columns) {
    const profile = jsonParse(row.profile_json, []);
    const numericKeys = new Set(
        profile
            .filter(isMetricNumericColumn)
            .map(item => item.key)
    );
    if (!columns.length) return '*';
    return columns.map(column => {
        const source = sqlIdent(column.key);
        const target = sqlIdent(column.name);
        if (numericKeys.has(column.key)) {
            return `CASE WHEN regexp_matches(trim(CAST(${source} AS VARCHAR)), '%$') THEN TRY_CAST(NULLIF(regexp_replace(CAST(${source} AS VARCHAR), '[,￥¥$%[:space:]]', '', 'g'), '') AS DOUBLE) / 100 ELSE TRY_CAST(NULLIF(regexp_replace(CAST(${source} AS VARCHAR), '[,￥¥$%[:space:]]', '', 'g'), '') AS DOUBLE) END AS ${target}`;
        }
        return `${source} AS ${target}`;
    }).join(', ');
}

function formatQueryExecutionError(err) {
    const message = String(err?.message || '语法或字段有误');
    if (/No function matches|Binder Error|VARCHAR|argument types/i.test(message)) {
        return '字段类型或表达式不匹配。请确认用于加减、平均、求和的字段是数值字段，或使用 TRY_CAST("字段名" AS DOUBLE) 转换后再计算。';
    }
    if (/Referenced column|not found|Catalog Error/i.test(message)) {
        return '字段不存在或字段名拼写不一致。请使用当前数据集字段名，并用双引号包裹包含中文或特殊字符的字段名。';
    }
    return message.split('\n')[0].slice(0, 500);
}

async function runUserQuery(userId, datasetId, input = {}) {
    const row = await getDatasetForUser(userId, datasetId);
    const userSql = validateUserSql(input.sql);
    const limit = Math.min(Math.max(Number(input.limit) || MAX_PREVIEW_ROWS, 1), MAX_QUERY_LIMIT);
    const columns = jsonParse(row.columns_json, []);
    const { parquetPath } = getDatasetPaths(row);
    const selectList = buildQuerySelectList(row, columns);
    const result = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            await withDuckTimeout(connection, () => connection.run(`CREATE TABLE data AS SELECT ${selectList} FROM read_parquet(${sqlLiteral(parquetPath)})`), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            // 物化完成后切断外部文件访问，使用户 SQL 无法读取数据集以外的任何文件。
            await connection.run('SET enable_external_access=false');
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`SELECT * FROM (${userSql}) AS _q LIMIT ${limit + 1}`), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            return reader.getRowObjectsJson();
        } catch (err) {
            if (err?.code === 'ANALYSIS_QUERY_TIMEOUT') throw err;
            const wrapped = new Error(`查询执行失败：${formatQueryExecutionError(err)}`);
            wrapped.status = 400;
            throw wrapped;
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    const truncated = result.length > limit;
    const rows = truncated ? result.slice(0, limit) : result;
    const resultColumns = rows.length
        ? Object.keys(rows[0])
        : (columns.length ? columns.map(column => column.name) : []);
    await recordArtifact({
        userId,
        datasetId,
        type: 'query',
        title: userSql.slice(0, 120),
        content: JSON.stringify({ sql: userSql, rowCount: rows.length, truncated }),
        metadata: { rows: rows.length, truncated }
    });
    return { columns: resultColumns, rows, rowCount: rows.length, truncated };
}

module.exports = {
    runPivot,
    runUserQuery,
    validateUserSql
};
