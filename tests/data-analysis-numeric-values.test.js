'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuckDBInstance } = require('@duckdb/node-api');
const { numericValueSql } = require('../server/services/data-analysis/numeric-values');

test('显示数值统一解析货币、千分位和百分号，忽略空值、无效值和非有限值', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
        const sql = numericValueSql('value');
        const rows = (await connection.runAndReadAll(`SELECT ${sql} AS parsed FROM (VALUES ('￥1,200.50'), ('25%'), (' -2.5 '), (''), (NULL), ('待核对'), ('NaN'), ('Infinity')) t(value)`)).getRowObjectsJson();
        assert.deepEqual(rows.map(row => row.parsed), [1200.5, 0.25, -2.5, null, null, null, null, null]);
        const summary = (await connection.runAndReadAll(`SELECT SUM(${sql}) AS total, AVG(${sql}) AS average, COUNT(${sql}) AS filled FROM (VALUES ('1,000'), ('￥200'), ('错误'), (NULL)) t(value)`)).getRowObjectsJson()[0];
        assert.equal(summary.total, 1200);
        assert.equal(summary.average, 600);
        assert.equal(Number(summary.filled), 2);
    } finally { connection.closeSync(); instance.closeSync(); }
});
