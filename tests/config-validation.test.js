const assert = require('node:assert/strict');
const test = require('node:test');
const { validateDatabaseUrl } = require('../server/config');

test('database URL does not block existing PostgreSQL password complexity', () => {
    assert.equal(validateDatabaseUrl('postgresql://pivot:pivot123456@db.internal:5432/pivot', { enforce: true }), '');
    assert.equal(validateDatabaseUrl('postgresql://pivot:current-password@db.internal:5432/pivot', { enforce: true }), '');
    assert.match(validateDatabaseUrl('not-a-postgres-url', { enforce: true }), /格式无效/);
});
