
const {
    MAX_PROFILE_DISTINCT,
    createDuckConnection,
    sqlIdent,
    sqlLiteral
} = require('./shared');

// 数值清洗表达式：保留旧的千分位/货币清洗，同时把显式百分号统一转换为 0~1 比例。
const SQL_NUMERIC_CLEAN = "CASE WHEN regexp_matches(trim(v), '%$') THEN TRY_CAST(regexp_replace(v, '[,￥¥$%[:space:]]', '', 'g') AS DOUBLE) / 100 ELSE TRY_CAST(regexp_replace(v, '[,￥¥$%[:space:]]', '', 'g') AS DOUBLE) END";
const SQL_DATE_PATTERN = '[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}([ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?';

// 统一画像：直接在 DuckDB 内对 parquet 计算字段画像，CSV/Excel 两条导入路径共用，
// 输出形状与历史 buildProfile 完全一致（type/filled/empty/fillRate/distinct/samples/topValues/numeric）。
async function profileViaSql(parquetPath, columns, totalRows) {
    const { instance, connection } = await createDuckConnection();
    try {
        const profile = [];
        for (const column of columns) {
            const ident = sqlIdent(column.key);
            const nonEmpty = `SELECT CAST(${ident} AS VARCHAR) AS v FROM read_parquet(${sqlLiteral(parquetPath)}) WHERE trim(CAST(${ident} AS VARCHAR)) <> ''`;
            const aggSql = `
                WITH base AS (${nonEmpty}),
                prepared AS (
                    SELECT v,
                        ${SQL_NUMERIC_CLEAN} AS numv,
                        regexp_full_match(v, '${SQL_DATE_PATTERN}') AS is_date_raw,
                        lower(v) IN ('true', 'false', '是', '否', 'yes', 'no') AS is_bool
                    FROM base
                )
                SELECT
                    COUNT(*) AS filled,
                    COUNT(DISTINCT v) AS distinct_count,
                    COUNT(numv) AS number_count,
                    COUNT(*) FILTER (WHERE numv IS NULL AND is_date_raw) AS date_count,
                    COUNT(*) FILTER (WHERE is_bool) AS boolean_count,
                    MIN(numv) AS min_v, MAX(numv) AS max_v, AVG(numv) AS avg_v, SUM(numv) AS sum_v,
                    MEDIAN(numv) AS median_v, QUANTILE_CONT(numv, 0.25) AS p25_v,
                    QUANTILE_CONT(numv, 0.75) AS p75_v, STDDEV_POP(numv) AS stddev_v
                FROM prepared
            `;
            const agg = (await connection.runAndReadAll(aggSql)).getRowObjectsJson()[0] || {};
            const topRows = (await connection.runAndReadAll(
                `SELECT v, COUNT(*) AS cnt FROM (${nonEmpty}) GROUP BY v ORDER BY cnt DESC, v LIMIT ${MAX_PROFILE_DISTINCT}`
            )).getRowObjectsJson();

            const filled = Number(agg.filled) || 0;
            const numberCount = Number(agg.number_count) || 0;
            const dateCount = Number(agg.date_count) || 0;
            const booleanCount = Number(agg.boolean_count) || 0;
            const threshold = Math.max(1, Math.floor(filled * 0.75));
            let type = 'text';
            if (!filled) type = 'empty';
            else if (numberCount >= threshold) type = 'number';
            else if (dateCount >= threshold) type = 'date';
            else if (booleanCount >= threshold) type = 'boolean';

            const topValues = topRows.map(item => ({ value: item.v, count: Number(item.cnt) || 0 }));
            profile.push({
                key: column.key,
                name: column.name,
                type,
                filled,
                empty: Math.max(0, (Number(totalRows) || 0) - filled),
                fillRate: totalRows ? filled / totalRows : 0,
                distinct: Number(agg.distinct_count) || 0,
                samples: topValues.slice(0, 5).map(item => item.value),
                topValues,
                numeric: numberCount ? {
                    count: numberCount,
                    min: Number(agg.min_v),
                    max: Number(agg.max_v),
                    avg: Number(agg.avg_v),
                    sum: Number(agg.sum_v),
                    median: Number(agg.median_v),
                    p25: Number(agg.p25_v),
                    p75: Number(agg.p75_v),
                    stddev: Number(agg.stddev_v)
                } : null
            });
        }
        return profile;
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

module.exports = {
    profileViaSql
};
