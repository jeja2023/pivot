const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../../data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// PostgreSQL 模式：db 为 null，所有数据库查询通过 server/db/client.js 进行
const db = null;
const dbPath = null;

module.exports = { db, dataDir, dbPath };

