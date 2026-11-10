'use strict';

const MAX_SQL_LEN = 5000;

const SQL_BLOCKLIST = /\b(ATTACH|DETACH|COPY|INSTALL|LOAD|PRAGMA|SET|RESET|EXPORT|IMPORT|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CALL|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_text|read_blob|parquet_scan|glob|system|getenv)\b/i;

function validateUserSql(sql, { maxLength = MAX_SQL_LEN } = {}) {
    const raw = String(sql || '').trim();
    if (!raw) {
        const err = new Error('请输入查询语句。');
        err.status = 400;
        throw err;
    }
    if (raw.length > maxLength) {
        const err = new Error(`查询语句过长（上限 ${maxLength} 字符）。`);
        err.status = 400;
        throw err;
    }
    // 去掉单个尾部分号后，若仍含分号则视为多语句，拒绝。
    const stripped = raw.replace(/;\s*$/, '');
    if (stripped.includes(';')) {
        const err = new Error('仅支持单条查询语句。');
        err.status = 400;
        throw err;
    }
    if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) {
        const err = new Error('仅支持以 SELECT 或 WITH 开头的只读查询。');
        err.status = 400;
        throw err;
    }
    if (SQL_BLOCKLIST.test(stripped)) {
        const err = new Error('查询包含不允许的关键字，仅支持对当前数据集的只读查询。');
        err.status = 400;
        throw err;
    }
    return stripped;
}

module.exports = { validateUserSql, MAX_SQL_LEN };
