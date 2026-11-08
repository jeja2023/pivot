'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sealed = require('../server/services/backup-sealed-files');

test('encrypted backup streams large and empty objects, validates retries, and publishes only authenticated plaintext', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-backup-files-'));
    try {
        const key = crypto.randomBytes(32), source = path.join(root, 'source'), destination = path.join(root, 'vault', 'object');
        const bytes = crypto.randomBytes(5 * 1024 * 1024 + 37); await fs.writeFile(source, bytes);
        const expectedDigest = crypto.createHash('sha256').update(bytes).digest('hex');
        const input = { source, destination, key, context: 'object:test', expectedDigest };
        assert.equal((await sealed.sealFile(input)).bytes, bytes.length);
        assert.equal((await sealed.sealFile(input)).existing, true);
        assert.equal((await fs.readFile(destination)).includes(bytes.subarray(0, 32)), false);
        const restored = path.join(root, 'restored');
        await sealed.restoreFile({ source: destination, destination: restored, key, context: input.context, expectedDigest, expectedBytes: bytes.length });
        assert.deepEqual(await fs.readFile(restored), bytes);
        await assert.rejects(sealed.restoreFile({ source: destination, destination: restored, key, context: input.context }), { code: 'EEXIST' });
        const bad = path.join(root, 'bad');
        await assert.rejects(sealed.restoreFile({ source: destination, destination: bad, key: crypto.randomBytes(32), context: input.context }));
        await assert.rejects(fs.stat(bad), { code: 'ENOENT' });
        await assert.rejects(sealed.verifyFile({ source: destination, key, context: 'different' }));
        await fs.writeFile(source, 'different bytes');
        await assert.rejects(sealed.sealFile({ ...input, expectedDigest: undefined }));
        await fs.writeFile(source, '');
        const empty = path.join(root, 'vault', 'empty');
        await sealed.sealFile({ source, destination: empty, key, context: 'empty' });
        assert.equal((await sealed.verifyFile({ source: empty, key, context: 'empty' })).bytes, 0);
        const tampered = await fs.readFile(destination); tampered[100] ^= 1; await fs.writeFile(destination, tampered);
        await assert.rejects(sealed.verifyFile({ source: destination, key, context: input.context }));
        assert.equal((await fs.readdir(path.dirname(destination))).some(name => name.startsWith('.pending') || name.startsWith('.restore')), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('backup key must be separate and manifests bind their identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-backup-keys-'));
    try {
        const vault = await sealed.privateDirectory(path.join(root, 'vault')), keyFile = path.join(root, 'key');
        await fs.writeFile(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
        const key = await sealed.readKey(keyFile, vault);
        const destination = path.join(vault, 'manifest');
        await sealed.writeJson({ value: { files: ['one'], point: 'point_a' }, destination, key, context: 'manifest:point_a' });
        assert.deepEqual(await sealed.readJson({ source: destination, key, context: 'manifest:point_a' }), { files: ['one'], point: 'point_a' });
        await assert.rejects(sealed.readJson({ source: destination, key, context: 'manifest:point_b' }));
        await assert.rejects(sealed.readKey(destination, vault));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent duplicate publications share one immutable ciphertext and verify while temporary links are removed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-backup-duplicates-'));
    try {
        const source = path.join(root, 'source'), destination = path.join(root, 'vault', 'object'), key = crypto.randomBytes(32);
        await fs.writeFile(source, crypto.randomBytes(65536));
        const input = { source, destination, key, context: 'concurrent-duplicate' };
        const values = await Promise.all(Array.from({ length: 16 }, () => sealed.sealFile(input)));
        assert.equal(new Set(values.map(item => item.sha256)).size, 1);
        assert.equal((await fs.readdir(path.dirname(destination))).filter(name => !name.startsWith('.')).length, 1);
        assert.equal((await sealed.verifyFile({ source: destination, key, context: input.context })).sha256, values[0].sha256);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retention protects seven-day continuous points, thirty-day daily points, and all required older bases', () => {
    const { retentionPlan } = require('../server/services/physical-backup-operations');
    const now = Date.parse('2026-11-07T12:00:00Z'), day = 86400000;
    const points = [], bases = [];
    for (let age = 0; age < 40; age++) {
        const baseId = `base_${age}`, createdAt = new Date(now - age * day).toISOString(); bases.push({ id: baseId, createdAt });
        points.push({ id: `point_${age}_new`, baseId, status: 'verified', createdAt });
        points.push({ id: `point_${age}_old`, baseId, status: 'verified', createdAt: new Date(now - age * day - 60000).toISOString() });
    }
    const plan = retentionPlan(points, bases, now);
    assert.equal(plan.retainPoints.has('point_1_old'), true);
    assert.equal(plan.retainPoints.has('point_20_new'), true);
    assert.equal(plan.retainPoints.has('point_20_old'), false);
    assert.equal(plan.retainPoints.has('point_31_new'), false);
    assert.equal(plan.retainBases.has('base_20'), true);
    assert.throws(() => retentionPlan(points, bases.filter(base => base.id !== 'base_20'), now), /基础备份缺失/);
    const stale = [{ ...points[0], createdAt: new Date(now - 60 * day).toISOString() }];
    assert.equal(retentionPlan(stale, bases, now).retainPoints.has(stale[0].id), true);
});

test('WAL names cross segment/log boundaries without dropping the segment containing the restore point', () => {
    const { walSegments } = require('../server/services/physical-backup');
    assert.deepEqual(walSegments({ startLSN: '0/FF000001', endLSN: '1/1000000', segmentBytes: 16 * 1024 * 1024, timeline: 1 }),
        ['0000000100000000000000FF', '000000010000000100000000', '000000010000000100000001']);
    assert.throws(() => walSegments({ startLSN: '1/1000000', endLSN: '0/FF000001', segmentBytes: 16 * 1024 * 1024, timeline: 1 }));
});
