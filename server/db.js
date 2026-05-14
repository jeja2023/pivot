/* 数据库逻辑模块 (已拆分，为保持向后兼容保留此入口) */
const { db, dataDir, dbPath, stmts } = require('./db/index');
module.exports = { db, dataDir, dbPath, stmts };
