
const XLSX = require('@e965/xlsx');
const {
    getDatasetForUser,
    getColumn,
    getDatasetPaths,
    sqlIdent,
    sqlLiteral,
    withAnalysisSlot,
    duckReadAll,
    recordArtifact
} = require('./shared');

async function compareDatasets(userId, input = {}) {
    const left = getDatasetForUser(userId, input.leftDatasetId);
    const right = getDatasetForUser(userId, input.rightDatasetId);
    const leftKey = getColumn(left, input.leftKey);
    const rightKey = getColumn(right, input.rightKey);
    const compareField = String(input.compareField || '').trim();
    const leftCompare = compareField ? getColumn(left, compareField) : null;
    const rightCompare = compareField ? getColumn(right, String(input.rightCompareField || input.compareField || compareField)) : null;
    const leftPath = getDatasetPaths(left).parquetPath;
    const rightPath = getDatasetPaths(right).parquetPath;
    const leftValueExpr = leftCompare
        ? `STRING_AGG(DISTINCT COALESCE(CAST(${sqlIdent(leftCompare.key)} AS VARCHAR), ''), ' | ' ORDER BY COALESCE(CAST(${sqlIdent(leftCompare.key)} AS VARCHAR), '')) AS compare_value`
        : `NULL AS compare_value`;
    const rightValueExpr = rightCompare
        ? `STRING_AGG(DISTINCT COALESCE(CAST(${sqlIdent(rightCompare.key)} AS VARCHAR), ''), ' | ' ORDER BY COALESCE(CAST(${sqlIdent(rightCompare.key)} AS VARCHAR), '')) AS compare_value`
        : `NULL AS compare_value`;
    const changedWhere = leftCompare && rightCompare
        ? `WHERE COALESCE(l.compare_value, '') <> COALESCE(r.compare_value, '')`
        : 'WHERE 1 = 0';
    const sql = `
        WITH
        left_data AS (
            SELECT
                COALESCE(CAST(${sqlIdent(leftKey.key)} AS VARCHAR), '') AS join_key,
                COUNT(*) AS row_count,
                ${leftValueExpr}
            FROM read_parquet(${sqlLiteral(leftPath)})
            GROUP BY join_key
        ),
        right_data AS (
            SELECT
                COALESCE(CAST(${sqlIdent(rightKey.key)} AS VARCHAR), '') AS join_key,
                COUNT(*) AS row_count,
                ${rightValueExpr}
            FROM read_parquet(${sqlLiteral(rightPath)})
            GROUP BY join_key
        ),
        matched AS (
            SELECT COUNT(*) AS count
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
        ),
        matched_keys AS (
            SELECT l.join_key AS key
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
            LIMIT 100
        ),
        only_left AS (
            SELECT l.join_key AS key
            FROM left_data l
            LEFT JOIN right_data r ON l.join_key = r.join_key
            WHERE r.join_key IS NULL
            LIMIT 100
        ),
        only_right AS (
            SELECT r.join_key AS key
            FROM right_data r
            LEFT JOIN left_data l ON l.join_key = r.join_key
            WHERE l.join_key IS NULL
            LIMIT 100
        ),
        changed AS (
            SELECT l.join_key AS key, l.compare_value AS left_value, r.compare_value AS right_value
            FROM left_data l
            INNER JOIN right_data r ON l.join_key = r.join_key
            ${changedWhere}
            LIMIT 100
        ),
        duplicate_left AS (
            SELECT join_key AS key, row_count::VARCHAR AS left_value, NULL AS right_value
            FROM left_data
            WHERE row_count > 1
            ORDER BY row_count DESC
            LIMIT 50
        ),
        duplicate_right AS (
            SELECT join_key AS key, row_count::VARCHAR AS left_value, NULL AS right_value
            FROM right_data
            WHERE row_count > 1
            ORDER BY row_count DESC
            LIMIT 50
        )
        SELECT 'matched' AS section, count::VARCHAR AS key, NULL AS left_value, NULL AS right_value FROM matched
        UNION ALL SELECT 'matched_keys' AS section, key, NULL AS left_value, NULL AS right_value FROM matched_keys
        UNION ALL SELECT 'only_left', key, NULL, NULL FROM only_left
        UNION ALL SELECT 'only_right', key, NULL, NULL FROM only_right
        UNION ALL SELECT 'changed', key, left_value, right_value FROM changed
        UNION ALL SELECT 'duplicate_left', key, left_value, right_value FROM duplicate_left
        UNION ALL SELECT 'duplicate_right', key, left_value, right_value FROM duplicate_right
    `;
    const rows = await withAnalysisSlot(() => duckReadAll(sql));
    const matched = Number(rows.find(item => item.section === 'matched')?.key || 0);
    const matchedKeys = rows.filter(item => item.section === 'matched_keys').map(item => ({ key: item.key }));
    const onlyLeft = rows.filter(item => item.section === 'only_left').map(item => ({ key: item.key }));
    const onlyRight = rows.filter(item => item.section === 'only_right').map(item => ({ key: item.key }));
    const changed = rows.filter(item => item.section === 'changed').map(item => ({
        key: item.key,
        leftValue: item.left_value,
        rightValue: item.right_value
    }));
    const duplicateLeft = rows.filter(item => item.section === 'duplicate_left').map(item => ({ key: item.key, count: Number(item.left_value) || 0 }));
    const duplicateRight = rows.filter(item => item.section === 'duplicate_right').map(item => ({ key: item.key, count: Number(item.left_value) || 0 }));
    const result = {
        left: { id: left.id, name: left.name, key: leftKey.name },
        right: { id: right.id, name: right.name, key: rightKey.name },
        matched,
        matchedKeys,
        onlyLeft,
        onlyRight,
        changed,
        duplicateLeft,
        duplicateRight,
        compareField: leftCompare ? leftCompare.name : ''
    };
    recordArtifact({
        userId,
        datasetId: left.id,
        type: 'comparison',
        title: `${left.name} vs ${right.name}`,
        content: JSON.stringify(result),
        metadata: { rightDatasetId: right.id, leftKey: leftKey.key, rightKey: rightKey.key }
    });
    return result;
}

function exportCompareExcel(data = {}) {
    const workbook = XLSX.utils.book_new();
    const leftKeyName = data.left?.key || '主键';
    const rightKeyName = data.right?.key || '主键';
    const compareField = data.compareField || '对比字段';
    
    let hasAnySheet = false;
    
    // 1. 相同项
    const matchedKeys = data.matchedKeys || [];
    if (matchedKeys.length > 0) {
        const rows = [[leftKeyName]];
        matchedKeys.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '相同项');
        hasAnySheet = true;
    }
    
    // 2. 仅在A表
    const onlyLeft = data.onlyLeft || [];
    if (onlyLeft.length > 0) {
        const rows = [[leftKeyName]];
        onlyLeft.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '仅在A表');
        hasAnySheet = true;
    }
    
    // 3. 仅在B表
    const onlyRight = data.onlyRight || [];
    if (onlyRight.length > 0) {
        const rows = [[rightKeyName]];
        onlyRight.forEach(item => {
            rows.push([item.key]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '仅在B表');
        hasAnySheet = true;
    }
    
    // 4. 差异项
    const changed = data.changed || [];
    if (changed.length > 0) {
        const rows = [[leftKeyName, `左侧值 (${compareField})`, `右侧值 (${compareField})`]];
        changed.forEach(item => {
            rows.push([item.key, item.leftValue, item.rightValue]);
        });
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, '差异项');
        hasAnySheet = true;
    }
    
    // 如果没有任何 sheet，至少放一个空白 sheet 避免报错
    if (!hasAnySheet) {
        const sheet = XLSX.utils.aoa_to_sheet([['无比对数据']]);
        XLSX.utils.book_append_sheet(workbook, sheet, '无数据');
    }
    
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
    compareDatasets,
    exportCompareExcel
};
