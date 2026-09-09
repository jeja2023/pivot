const { db } = require('../connection');
const { applyLegacySchemaPreflight } = require('./legacy-preflight');
const { enterpriseTablesSql } = require('./enterprise');
const { coreTablesSql } = require('./tables-core');
const { agentTablesSql } = require('./tables-agent');
const { baseIndexesSql } = require('./indexes');
const { sqliteFtsSql } = require('./fts');

/**
 * 建表 DDL（SQLite 方言，权威单一数据源）
 *
 * 本函数返回的文本同时被 PostgreSQL 侧复用：server/db/schema/pg.js 会读取
 * 此文本并做方言转换（INTEGER→BIGINT、DATETIME→TIMESTAMPTZ、AUTOINCREMENT→
 * IDENTITY、外键后置化）。因此新增表或列只需改这里一处，两种方言自动同步。
 *
 * 约束：
 *  - 外键必须写成独立的 FOREIGN KEY (col) REFERENCES tbl(col) 单行子句，
 *    不要用内联 col INTEGER REFERENCES tbl(col) —— PG 转换器按行剥离外键。
 *  - 布尔语义列统一用 INTEGER DEFAULT 0/1（两侧一致，应用层 === 1 判断成立）。
 */
function baseTablesSql() {
    return [
        coreTablesSql(),
        agentTablesSql(),
        enterpriseTablesSql()
    ].join('\n');
}

function initSchema() {
    if (!db || typeof db.exec !== 'function') {
        throw new Error('[DB] 当前版本已切换为 PostgreSQL-only；SQLite initSchema 仅允许历史旧库升级工具显式注入 SQLite 连接后调用。');
    }
    applyLegacySchemaPreflight();
    db.exec(baseTablesSql());
    db.exec(baseIndexesSql());
    db.exec(sqliteFtsSql());
}

module.exports = { initSchema, baseTablesSql, baseIndexesSql, sqliteFtsSql };
