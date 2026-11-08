'use strict';

const { getDatasetPaths, sqlIdent, sqlLiteral, createDuckConnection, withAnalysisSlot, withDuckTimeout } = require('./shared');

async function relationQuality(left, right, { leftFieldKey, rightFieldKey, joinType = 'left', cardinality = 'many_to_one', userId }) {
    return withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            // 先按键计数再计算匹配规模，避免质量检查本身物化多对多的巨大结果。
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`
                WITH l AS (SELECT CAST(${sqlIdent(leftFieldKey)} AS VARCHAR) AS k, COUNT(*) AS n FROM read_parquet(${sqlLiteral(getDatasetPaths(left).parquetPath)}) GROUP BY 1),
                     r AS (SELECT CAST(${sqlIdent(rightFieldKey)} AS VARCHAR) AS k, COUNT(*) AS n FROM read_parquet(${sqlLiteral(getDatasetPaths(right).parquetPath)}) GROUP BY 1),
                     matches AS (SELECT l.n AS ln, r.n AS rn FROM l JOIN r ON l.k = r.k)
                SELECT
                    (SELECT COALESCE(SUM(n), 0) FROM l) AS left_rows,
                    (SELECT COALESCE(SUM(n), 0) FROM r) AS right_rows,
                    (SELECT COUNT(k) FROM l) AS left_distinct,
                    (SELECT COUNT(k) FROM r) AS right_distinct,
                    (SELECT COALESCE(SUM(n), 0) FROM l WHERE k IS NULL) AS left_nulls,
                    (SELECT COALESCE(SUM(n), 0) FROM r WHERE k IS NULL) AS right_nulls,
                    (SELECT COUNT(*) FROM l WHERE k IS NOT NULL AND n > 1) AS left_duplicates,
                    (SELECT COUNT(*) FROM r WHERE k IS NOT NULL AND n > 1) AS right_duplicates,
                    (SELECT COALESCE(SUM(ln), 0) FROM matches) AS matched_left,
                    (SELECT COALESCE(SUM(rn), 0) FROM matches) AS matched_right,
                    (SELECT COALESCE(SUM(CAST(ln AS HUGEINT) * rn), 0) FROM matches) AS inner_rows
            `));
            const row = reader.getRowObjectsJson()[0] || {};
            const quality = {
                leftRows: Number(row.left_rows) || 0, rightRows: Number(row.right_rows) || 0,
                leftDistinct: Number(row.left_distinct) || 0, rightDistinct: Number(row.right_distinct) || 0,
                leftNullRows: Number(row.left_nulls) || 0, rightNullRows: Number(row.right_nulls) || 0,
                leftDuplicateKeys: Number(row.left_duplicates) || 0, rightDuplicateKeys: Number(row.right_duplicates) || 0,
                matchedLeftRows: Number(row.matched_left) || 0, matchedRightRows: Number(row.matched_right) || 0
            };
            quality.unmatchedLeftRows = quality.leftRows - quality.matchedLeftRows;
            quality.joinedRows = (Number(row.inner_rows) || 0) + (joinType === 'left' ? quality.unmatchedLeftRows : 0);
            quality.leftMatchRate = quality.leftRows ? quality.matchedLeftRows / quality.leftRows : null;
            quality.cardinalityMismatch = (['one_to_one', 'one_to_many'].includes(cardinality) && quality.leftDuplicateKeys > 0)
                || (['one_to_one', 'many_to_one'].includes(cardinality) && quality.rightDuplicateKeys > 0);
            quality.warnings = [];
            if (quality.cardinalityMismatch) quality.warnings.push('关联键存在重复值，与声明的对应基数不一致，请核对关联字段。');
            if (quality.joinedRows > quality.leftRows) quality.warnings.push('关联后的记录数大于左表记录数，计数或金额汇总可能重复。');
            if (quality.unmatchedLeftRows) quality.warnings.push(`左表有 ${quality.unmatchedLeftRows} 行未匹配；${joinType === 'inner' ? '内关联会排除这些记录' : '左关联会保留这些记录并将右表字段置空'}。`);
            return quality;
        } finally { connection.closeSync(); instance.closeSync(); }
    }, { userId: userId });
}

module.exports = { relationQuality };
