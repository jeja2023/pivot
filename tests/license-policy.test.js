const assert = require('node:assert/strict');
const test = require('node:test');
const { validateLicenses } = require('../scripts/check_licenses');

test('license policy requires an active exception for dual/copyleft production packages', () => {
    const lock = { packages: { 'node_modules/demo': { license: 'MIT OR GPL-3.0-or-later' } } };
    const policy = { allowed: ['MIT'], exceptions: {} };
    assert.match(validateLicenses(lock, policy, Date.parse('2026-01-01'))[0], /未治理/);
    policy.exceptions.demo = { selectedLicense: 'MIT', reason: '选择 MIT', expiresOn: '2099-01-01' };
    assert.deepEqual(validateLicenses(lock, policy, Date.parse('2026-01-01')), []);
});
