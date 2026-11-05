'use strict';

// 画像与汇总共用显示值解析，避免 Excel 的千分位、货币和百分号在不同入口得到不同结果。
// expression 只能由调用方用受控字段键和 SQL 标识符构造，不能传入用户表达式。
function numericValueSql(expression) {
    const value = `trim(CAST(${expression} AS VARCHAR))`;
    const parsed = `(TRY_CAST(regexp_replace(${value}, '[,￥¥$%[:space:]]', '', 'g') AS DOUBLE) / CASE WHEN regexp_matches(${value}, '%$') THEN 100 ELSE 1 END)`;
    return `CASE WHEN isfinite(${parsed}) THEN ${parsed} ELSE NULL END`;
}

module.exports = { numericValueSql };
