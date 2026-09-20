const path = require('path');

const root = path.resolve(__dirname, '..');
const migrations = require(path.join(root, 'server', 'db', 'migrations'));
const list = Array.isArray(migrations) ? migrations : migrations.migrations || [];
const noUpPg = new Set(list.filter(migration => typeof migration.upPg !== 'function').map(migration => migration.id));

if (noUpPg.size) {
    console.error('PostgreSQL 迁移覆盖检查失败。');
    console.error(`缺少 upPg 的迁移: ${[...noUpPg].join(', ')}`);
    process.exit(1);
}

console.log(`PostgreSQL 迁移覆盖检查通过：${list.length} 条迁移均提供 upPg。`);
