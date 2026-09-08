const assert = require('node:assert/strict');
const test = require('node:test');
const { validateDependencyOverrides } = require('../scripts/check_dependency_overrides');

test('dependency override policy requires review metadata and non-exact version ranges', () => {
    const policy = {
        safe: { reason: 'test', scope: 'production', expiresOn: '2099-01-01' }
    };
    assert.deepEqual(validateDependencyOverrides({ overrides: { safe: '^1.2.3' } }, policy, Date.parse('2026-01-01')), []);
    assert.match(validateDependencyOverrides({ overrides: { safe: '1.2.3' } }, policy, Date.parse('2026-01-01'))[0], /精确锁定/);
});
