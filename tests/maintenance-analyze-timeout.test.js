const test = require('node:test');
const assert = require('node:assert/strict');

test('ANALYZE 使用独立维护超时，不应降低普通 SQL 的全局超时', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'services', 'maintenance.js'), 'utf8');
    assert.match(source, /PG_ANALYZE_TIMEOUT_MS/);
    assert.match(source, /SET LOCAL statement_timeout = \$\{ANALYZE_TIMEOUT_MS\}; ANALYZE \$\{schema\}\.\$\{name\}/);
    assert.match(source, /getPgSchemaTableNames\(\)/);
    assert.match(source, /for \(const table of tables\)/);
});
