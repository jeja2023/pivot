const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const { hashPasswordsOffThread, normalizeWorkerCount } = require('../server/services/password-hasher');

test('用户导入密码在有限 Worker Thread 中按原顺序哈希', async () => {
    const passwords = ['Alpha1234', 'Beta5678', 'Gamma9012'];
    const hashes = await hashPasswordsOffThread(passwords, { workerCount: 2, rounds: 8 });
    assert.equal(hashes.length, passwords.length);
    hashes.forEach((hash, index) => assert.equal(bcrypt.compareSync(passwords[index], hash), true));
    assert.equal(normalizeWorkerCount(999, 3), 3);
});
