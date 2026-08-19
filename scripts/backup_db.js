const path = require('path');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

const { backupDatabase } = require('../server/services/maintenance');

async function runBackup() {
    try {
        console.log('[持久化中心] 正在启动 PostgreSQL 备份...');
        const result = await backupDatabase();
        console.log(`[持久化中心] PostgreSQL 备份成功: ${result.path}`);
        console.log(`[持久化中心] 文件大小: ${result.sizeBytes} 字节，清理旧版本: ${result.deletedFiles} 个`);
    } catch (error) {
        console.error('[持久化中心] PostgreSQL 备份失败:', error.message);
        process.exitCode = 1;
    }
}

runBackup();
