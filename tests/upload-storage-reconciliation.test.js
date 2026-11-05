'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reconcile } = require('../server/services/upload-storage-reconciliation');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function fixture(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-upload-reconcile-'));
    const old = new Date(Date.now() - 40 * 86400000);
    const create = async name => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, '保留或清理'); await fs.utimes(target, old, old); return target; };
    const options = { root, retentionDays: 30, limit: 100, nowMs: Date.now(), remove: true, getReferences: async () => new Set(), onDeleteError() {} };
    try { await run({ root, create, options }); }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^pivot-upload-reconcile-/);
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('引用查询失败时不删除文件，删除前重新查询新增引用', async () => fixture(async ({ create, options }) => {
    const file = await create('original.txt');
    await assert.rejects(reconcile({ ...options, getReferences: async () => { throw new Error('数据库暂时不可用'); } }), /数据库暂时不可用/);
    assert.equal(await fs.readFile(file, 'utf8'), '保留或清理');
    let reads = 0;
    const result = await reconcile({ ...options, getReferences: async () => ++reads === 1 ? new Set() : new Set([key(file)]) });
    assert.equal(result.deletedFiles, 0);
    assert.equal(reads, 2);
    assert.equal(await fs.readFile(file, 'utf8'), '保留或清理');
}));

test('扫描后被替换或更新的文件会保留，目录链接不能引导到外部', async () => fixture(async ({ root, create, options }) => {
    const file = await create('changed.txt'); let reads = 0;
    await reconcile({ ...options, getReferences: async () => { if (++reads === 2) await fs.writeFile(file, '新文件'); return new Set(); } });
    assert.equal(await fs.readFile(file, 'utf8'), '新文件');
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-upload-reconcile-external-'));
    const link = path.join(root, 'linked');
    try {
        const target = path.join(external, 'keep.txt'); await fs.writeFile(target, '外部文件');
        const old = new Date(Date.now() - 40 * 86400000); await fs.utimes(target, old, old);
        await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
        await reconcile(options);
        assert.equal(await fs.readFile(target, 'utf8'), '外部文件');
    } finally {
        if (process.platform === 'win32') await fs.rmdir(link); else await fs.unlink(link);
        assert.equal(path.dirname(external), path.resolve(os.tmpdir()));
        await fs.rm(external, { recursive: true, force: true });
    }
}));

test('多批扫描能越过大量受引用文件并找到后面的孤儿，预览不会删除', async () => fixture(async ({ root, create, options }) => {
    const referenced = new Set();
    for (let start = 0; start < 1005; start += 50) {
        const files = await Promise.all(Array.from({ length: Math.min(50, 1005 - start) }, (_, index) => create(`keep-${String(start + index).padStart(4, '0')}.txt`)));
        files.forEach(file => referenced.add(key(file)));
    }
    const orphan = await create('z-orphan.txt');
    const input = { ...options, references: referenced, limit: 1 };
    assert.equal((await reconcile(input)).deletedFiles, 0);
    const preview = await reconcile({ ...input, remove: false });
    assert.equal(preview.candidates, 1);
    assert.equal(await fs.readFile(orphan, 'utf8'), '保留或清理');
    let deleted = 0;
    for (let batch = 0; batch < 4 && !deleted; batch += 1) deleted += (await reconcile(input)).deletedFiles;
    assert.equal(deleted, 1);
    assert.equal(await fs.readFile(path.join(root, 'keep-0000.txt'), 'utf8'), '保留或清理');
    await assert.rejects(fs.access(path.join(root, 'z-orphan.txt')), { code: 'ENOENT' });
}));
