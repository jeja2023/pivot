const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const settings = require('../server/services/app-settings');
const { getStealthSecret, setStealthConfigAsync } = require('../server/services/stealth-service');

test('隐身密钥加密保存，旧明文安全迁移且不会覆盖新密钥', { skip: !process.env.DATABASE_URL }, async () => {
    const key = 'stealth_secret';
    const original = await queryOne('SELECT value FROM app_settings WHERE key = ?', [key]);
    try {
        await settings.setAppSettingAsync(key, 'legacy-test-secret-0123456789');
        assert.equal(getStealthSecret(), 'legacy-test-secret-0123456789');
        for (let i = 0; i < 50; i += 1) {
            const row = await queryOne('SELECT value FROM app_settings WHERE key = ?', [key]);
            if (row.value.startsWith('enc:v2:')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.match((await queryOne('SELECT value FROM app_settings WHERE key = ?', [key])).value, /^enc:v2:/);
        assert.equal(getStealthSecret(), 'legacy-test-secret-0123456789');
        await setStealthConfigAsync({ secret: 'updated-test-secret-0123456789' });
        assert.equal(getStealthSecret(), 'updated-test-secret-0123456789');
        assert.equal(await settings.replaceAppSettingValueIfUnchanged(key, 'legacy-test-secret-0123456789', 'stale'), false);
        assert.match((await queryOne('SELECT value FROM app_settings WHERE key = ?', [key])).value, /^enc:v2:/);
    } finally {
        if (original) await settings.setAppSettingAsync(key, original.value);
        else await execute('DELETE FROM app_settings WHERE key = ?', [key]);
        await settings.refreshAppSettingsCache();
    }
});
