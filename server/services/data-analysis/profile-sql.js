'use strict';

const { sqlIdentifier: sqlIdent, sqlLiteral } = require('./bi/sql-expressions');
const { numericValueSql } = require('./numeric-values');
const SQL_NUMERIC_CLEAN = numericValueSql('v');
const SQL_DATE_PATTERN = '[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}([ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?';

async function exactPartitionedValues(run, nonEmpty, partitions, maxDistinct, sampleChars) {
    const candidates = []; let distinct = 0;
    for (let partition = 0; partition < partitions; partition++) {
        // 哈希只负责分桶，每桶继续按原字符串精确分组；碰撞不会减少最终去重数。
        const rows = (await run(`WITH groups AS (SELECT v,COUNT(*) AS cnt FROM (${nonEmpty}) source
            WHERE hash(v)%${partitions}=${partition} GROUP BY v)
            SELECT ${sampleChars ? `left(v,${sampleChars})` : 'v'} AS v,cnt,COUNT(*) OVER() AS distinct_count FROM groups
            ORDER BY cnt DESC,groups.v LIMIT ${maxDistinct}`)).getRowObjectsJson();
        distinct += Number(rows[0]?.distinct_count || 0); candidates.push(...rows);
    }
    // 全局前 N 个值必在所在桶的前 N 中；显示截断后的同前缀值无需保留原始大字符串。
    candidates.sort((a, b) => Number(b.cnt) - Number(a.cnt) || Buffer.compare(Buffer.from(String(a.v)), Buffer.from(String(b.v))));
    return { distinct, rows: candidates.slice(0, maxDistinct) };
}

// 统一画像的纯计算部分，可由 API 连接或不持有数据库凭据的隔离执行器调用。
async function profileWithConnection(connection, parquetPath, columns, totalRows, { run = sql => connection.runAndReadAll(sql), maxDistinct = 20, sampleChars = null, onColumn = null } = {}) {
    const profile = [];
    for (const column of columns) {
        if (onColumn) await onColumn(profile.length);
        const ident = sqlIdent(column.key);
        const nonEmpty = `SELECT CAST(${ident} AS VARCHAR) AS v FROM read_parquet(${sqlLiteral(parquetPath)}) WHERE trim(CAST(${ident} AS VARCHAR)) <> ''`;
        const estimate = (await run(`SELECT approx_count_distinct(v) AS cardinality,MAX(length(v)) AS max_chars FROM (${nonEmpty}) source`)).getRowObjectsJson()[0] || {};
        const estimatedBytes = Number(estimate.cardinality || 0) * Number(estimate.max_chars || 0) * 4;
        const partitions = Math.min(128, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, estimatedBytes / (128 * 1024 ** 2))))));
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
                ${partitions > 1 ? 'NULL' : 'COUNT(DISTINCT v)'} AS distinct_count,
                COUNT(numv) AS number_count,
                COUNT(*) FILTER (WHERE numv IS NULL AND is_date_raw) AS date_count,
                COUNT(*) FILTER (WHERE is_bool) AS boolean_count,
                MIN(numv) AS min_v, MAX(numv) AS max_v, AVG(numv) AS avg_v, SUM(numv) AS sum_v,
                MEDIAN(numv) AS median_v, QUANTILE_CONT(numv, 0.25) AS p25_v,
                QUANTILE_CONT(numv, 0.75) AS p75_v, STDDEV_POP(numv) AS stddev_v
            FROM prepared
        `;
        const agg = (await run(aggSql)).getRowObjectsJson()[0] || {};
        const partitioned = partitions > 1 ? await exactPartitionedValues(run, nonEmpty, partitions, maxDistinct, sampleChars) : null;
        const topRows = partitioned?.rows || (await run(`SELECT ${sampleChars ? `left(v,${sampleChars})` : 'v'} AS v, COUNT(*) AS cnt FROM (${nonEmpty}) source GROUP BY source.v ORDER BY cnt DESC,source.v LIMIT ${maxDistinct}`)).getRowObjectsJson();

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

        const topValues = topRows.map(item => ({ value: sampleChars ? String(item.v).slice(0, sampleChars) : item.v, count: Number(item.cnt) || 0 }));
        profile.push({
            key: column.key,
            name: column.name,
            type,
            filled,
            empty: Math.max(0, (Number(totalRows) || 0) - filled),
            fillRate: totalRows ? filled / totalRows : 0,
            distinct: partitioned ? partitioned.distinct : Number(agg.distinct_count) || 0,
            samples: topValues.slice(0, 5).map(item => item.value),
            topValues,
            ...(sampleChars ? { sampleCharacterLimit: sampleChars } : {}),
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
}

module.exports = { profileWithConnection };
