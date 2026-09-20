/**
 * server/db/schema.js
 * Schema 初始化出口（PostgreSQL runtime）。
 * 主数据库只加载原生 PostgreSQL schema 快照。
 */
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
    initSchemaPg,
    applyPgSchemaComments,
    buildPgSchemaStatements,
};
