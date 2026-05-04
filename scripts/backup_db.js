const fs = require('fs');
const path = require('path');

// 配置路径
const DB_PATH = path.join(__dirname, '../data/chat.db');
const BACKUP_DIR = path.join(__dirname, '../data/backups');

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 生成备份文件名 (含时间戳)
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `chat_backup_${timestamp}.db`);

const db = require('../server/db'); // 借用现有的数据库连接

async function runBackup() {
    try {
        console.log(`[持久化中心] 正在启动热备份...`);
        await db.backup(backupPath);
        console.log(`[持久化中心] ✅ 数据库热备份成功: ${backupPath}`);
        console.log(`[安全性提示] 当前已启用“永久保留”模式，请定期检查磁盘空间。`);
        process.exit(0);
    } catch (err) {
        console.error(`[持久化中心] ❌ 备份失败:`, err);
        process.exit(1);
    }
}

runBackup();
