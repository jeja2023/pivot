const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const migrations = require(path.join(root, 'server', 'db', 'migrations'));
const list = Array.isArray(migrations) ? migrations : migrations.migrations || [];
const baselinePath = path.join(__dirname, 'pg_migration_baseline.json');
const baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
const noUpPg = new Set(list.filter(migration => typeof migration.upPg !== 'function').map(migration => migration.id));
const unknownBaseline = [...baseline].filter(id => !noUpPg.has(id));
const unregistered = [...noUpPg].filter(id => !baseline.has(id));

if (unknownBaseline.length || unregistered.length) {
    console.error('PostgreSQL 迁移覆盖检查失败。');
    if (unknownBaseline.length) console.error(`基线中已不再需要登记的迁移: ${unknownBaseline.join(', ')}`);
    if (unregistered.length) console.error(`缺少 upPg 且未登记基线的迁移: ${unregistered.join(', ')}`);
    process.exit(1);
}

console.log(`PostgreSQL 迁移覆盖检查通过：${list.length} 条迁移，${noUpPg.size} 条显式基线迁移，其余均提供 upPg。`);
