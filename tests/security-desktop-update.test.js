const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertAllowedUpdateFeedUrl,
    normalizeOriginList,
    normalizeUpdateFeedUrl
} = require('../desktop/update-policy');
const { normalizeAutoUpdate } = require('../desktop/config');

test('desktop update policy requires https for remote feeds', () => {
    assert.equal(
        normalizeUpdateFeedUrl('https://updates.example.com/pivot', { required: true }),
        'https://updates.example.com/pivot/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://updates.example.com/pivot'),
        /must use https/
    );
});

test('desktop update policy allows explicit loopback dev feeds only', () => {
    assert.equal(
        assertAllowedUpdateFeedUrl('http://127.0.0.1:9000/releases', {
            env: { PIVOT_DESKTOP_ALLOW_INSECURE_UPDATE_FEED: 'true' }
        }),
        'http://127.0.0.1:9000/releases/'
    );
    assert.throws(
        () => assertAllowedUpdateFeedUrl('http://127.0.0.1:9000/releases'),
        /must use https/
    );
});

test('desktop update policy enforces allowed origins', () => {
    assert.deepEqual(normalizeOriginList(['https://updates.example.com/path']), ['https://updates.example.com']);
    assert.equal(
        normalizeAutoUpdate({
            enabled: true,
            url: 'https://updates.example.com/pivot',
            allowedOrigins: ['https://updates.example.com']
        }).url,
        'https://updates.example.com/pivot/'
    );
    assert.throws(
        () => normalizeAutoUpdate({
            enabled: true,
            url: 'https://evil.example.com/pivot',
            allowedOrigins: ['https://updates.example.com']
        }),
        /not in config\.autoUpdate\.allowedOrigins/
    );
});
