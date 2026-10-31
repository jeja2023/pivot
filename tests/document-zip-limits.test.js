'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { readZipEntries } = require('../server/document-text');

test('异步解压让出事件循环并限制伪造声明后的实际总膨胀', async () => {
    const zip = new JSZip();
    const content = Buffer.alloc(16 * 1024 * 1024, 65);
    for (let i = 0; i < 4; i += 1) zip.file(`${i}.txt`, content);
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const end = archive.length - 22;
    assert.equal(archive.readUInt32LE(end), 0x06054b50);
    let offset = archive.readUInt32LE(end + 16);
    for (let i = 0; i < 4; i += 1) {
        assert.equal(archive.readUInt32LE(offset), 0x02014b50);
        archive.writeUInt32LE(1, offset + 24);
        offset += 46 + archive.readUInt16LE(offset + 28) + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
    }
    let yielded = false;
    setImmediate(() => { yielded = true; });
    await assert.rejects(readZipEntries(archive), /实际总解压体积超出/);
    assert.equal(yielded, true);
});
