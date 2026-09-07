const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { buildPgSchemaStatements } = require(path.join(root, 'server', 'db', 'schema', 'pg'));
const required = JSON.parse(fs.readFileSync(path.join(__dirname, 'pg_required_indexes.json'), 'utf8'));
const statements = buildPgSchemaStatements().indexes || [];
const declared = new Set(statements.map(statement => {
    const match = String(statement).match(/\bINDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i);
    return match ? match[1] : '';
}).filter(Boolean));
const missing = required.filter(name => !declared.has(name));

if (missing.length) {
    console.error(`PostgreSQL 关键索引基线缺失: ${missing.join(', ')}`);
    process.exit(1);
}
console.log(`PostgreSQL 关键索引基线通过：声明 ${declared.size} 条索引，关键清单 ${required.length} 条。`);
