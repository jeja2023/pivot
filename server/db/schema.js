/**
 * server/db/schema.js
 * Schema 初始化统一出口（双方言）
 *
 * PG 侧采用懒加载：SQLite 模式下不加载 pg 驱动与 PG 转换器。
 */
const { initSchema, baseTablesSql, baseIndexesSql, sqliteFtsSql } = require('./schema/base');

function initSchemaPg() {
    return require('./schema/pg').initSchemaPg();
}

function buildPgSchemaStatements() {
    return require('./schema/pg').buildPgSchemaStatements();
}

module.exports = {
    // SQLite
    initSchema,
    baseTablesSql,
    baseIndexesSql,
    sqliteFtsSql,
    // PostgreSQL
    initSchemaPg,
    buildPgSchemaStatements,
};
