'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    normalizePublisherName,
    verifyWindowsUpdateArtifacts
} = require('../scripts/verify_windows_update_artifacts');

test('Windows 更新产物签名验收要求每个文件通过与发布者匹配的验证', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-artifact-'));
    const installer = path.join(root, 'Pivot Setup.exe');
    const executable = path.join(root, 'Pivot.exe');
    const verified = [];
    try {
        fs.writeFileSync(installer, 'installer');
        fs.writeFileSync(executable, 'executable');
        await verifyWindowsUpdateArtifacts([installer, executable], ' Pivot  Release ', {
            verifySignature: async (publishers, artifact) => {
                verified.push({ publishers, artifact });
                return null;
            }
        });
        assert.equal(normalizePublisherName(' Pivot  Release '), 'Pivot Release');
        assert.deepEqual(verified.map(item => item.publishers), [['Pivot Release'], ['Pivot Release']]);
        await assert.rejects(
            () => verifyWindowsUpdateArtifacts([installer], 'Pivot Release', { verifySignature: async () => 'not signed' }),
            /Windows 更新签名验收失败/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
