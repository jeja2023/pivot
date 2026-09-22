'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { verifyDesktopUpdateRelease } = require('../scripts/verify_desktop_update_release');

function writeFixture(root) {
    const downloadsDir = path.join(root, 'downloads');
    const resourcesDir = path.join(root, 'resources');
    const version = '1.2.3';
    const publisherName = 'Pivot Production Signing';
    const installerName = `Pivot Setup ${version}.exe`;
    const installer = path.join(downloadsDir, installerName);
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(installer, 'signed installer payload');
    fs.writeFileSync(`${installer}.blockmap`, 'blockmap');
    const size = fs.statSync(installer).size;
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
    fs.writeFileSync(path.join(downloadsDir, 'latest.yml'), yaml.dump({
        version,
        files: [{ url: installerName, sha512, size }],
        path: installerName,
        sha512
    }));
    fs.writeFileSync(path.join(resourcesDir, 'config.json'), JSON.stringify({
        mode: 'remote',
        remoteUrl: 'https://pivot.example.com/',
        autoUpdate: {
            enabled: true,
            path: '/downloads/',
            url: '',
            publisherName,
            allowedOrigins: ['https://pivot.example.com']
        }
    }));
    fs.writeFileSync(path.join(resourcesDir, 'app-update.yml'), yaml.dump({
        provider: 'generic',
        url: 'https://pivot.example.com/downloads/',
        publisherName: [publisherName]
    }));
    return { downloadsDir, resourcesDir, version, publisherName, installer };
}

test('Windows update release validation binds metadata, artifacts, feed and publisher as one release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-release-'));
    try {
        const fixture = writeFixture(root);
        assert.deepEqual(verifyDesktopUpdateRelease(fixture), {
            version: fixture.version,
            installerName: path.basename(fixture.installer),
            feedUrl: 'https://pivot.example.com/downloads/',
            publisherName: fixture.publisherName
        });
        fs.appendFileSync(fixture.installer, 'tampered');
        assert.throws(() => verifyDesktopUpdateRelease(fixture), /大小|SHA-512/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
