/**
 * server/db/schema.js
 * Schema 初始化出口（PostgreSQL runtime）
 *
 * base.js 中的 SQLite 方言 DDL 仍作为 PG 转换器的源文本，也用于历史旧库测试。
 */
const { initSchema, baseTablesSql, baseIndexesSql, sqliteFtsSql } = require('./schema/base');

function initSchemaPg() {
    return require('./schema/pg').initSchemaPg();
}

function buildPgSchemaStatements() {
    return require('./schema/pg').buildPgSchemaStatements();
}

function applyPgSchemaComments() {
    return require('./schema/pg').applyPgSchemaComments();
}

module.exports = {
    // Legacy SQLite schema source/helpers
    initSchema,
    baseTablesSql,
    baseIndexesSql,
    sqliteFtsSql,
    // PostgreSQL
    initSchemaPg,
    applyPgSchemaComments,
    buildPgSchemaStatements,
};
