'use strict';

// 流式、带鉴权且不可变存储，由物理数据库、WAL 和应用文件备份共享；密钥由单独的操作员私有文件读取。
const fs = require('node:fs/promises');
const streams = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const MAGIC = Buffer.from('PVTBKP01');
const HEADER_BYTES = MAGIC.length + 12;

function inside(root, target) { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); }
async function syncDirectory(directory) {
    let handle;
    try { handle = await fs.open(directory, 'r'); await handle.sync(); }
    catch (error) { if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error; }
    finally { await handle?.close(); }
}
async function privateDirectory(directory) {
    if (!path.isAbsolute(directory)) throw new Error('备份目录必须使用绝对路径。');
    const firstCreated = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)
        || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('备份目录必须为独立私有真实目录。');
    if (firstCreated) {
        const created = process.platform === 'win32' && firstCreated.startsWith('\\\\?\\') ? firstCreated.slice(4) : firstCreated;
        let current = path.resolve(directory);
        for (;;) {
            await syncDirectory(current);
            if (path.relative(current, path.resolve(created)) === '') { await syncDirectory(path.dirname(current)); break; }
            const parent = path.dirname(current);
            if (parent === current) throw new Error('备份目录持久化边界无效。');
            current = parent;
        }
    }
    return directory;
}
async function readKey(file, backupRoot) {
    if (!path.isAbsolute(file) || inside(backupRoot, path.resolve(file))) throw new Error('备份密钥必须独立于备份目录保管。');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || await fs.realpath(file) !== path.resolve(file)
        || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('备份密钥文件权限或类型无效。');
    const value = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('备份密钥必须为独立生成的三十二字节十六进制密钥。');
    return Buffer.from(value, 'hex');
}
async function regularFile(file) {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份只接受常规文件。');
    return stat;
}
function signature(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'); }
function sealedIdentity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(':'); }
function fileSink(handle) { return new Writable({ write(chunk, _encoding, callback) { handle.writeFile(chunk).then(() => callback(), callback); } }); }
async function digestBackupFile(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of streams.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function decryptTo({ source, key, context, destination, expectedDigest, expectedBytes }) {
    const stat = await regularFile(source);
    if (stat.size < BigInt(HEADER_BYTES + 16)) throw new Error('加密备份文件不完整。');
    const handle = await fs.open(source, 'r');
    let output;
    try {
        const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(16);
        if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.subarray(0, 8).equals(MAGIC)) throw new Error('加密备份格式无效。');
        await handle.read(tag, 0, 16, Number(stat.size) - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(8));
        decipher.setAAD(Buffer.from(`pivot.backup.v1:${context}`)); decipher.setAuthTag(tag);
        const hash = crypto.createHash('sha256'); let bytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); } });
        if (destination) output = await fs.open(destination, 'wx', 0o600);
        const sink = output ? fileSink(output) : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const input = stat.size === BigInt(HEADER_BYTES + 16) ? Readable.from([]) : handle.createReadStream({ start: HEADER_BYTES, end: Number(stat.size) - 17, autoClose: false });
        await pipeline(input, decipher, meter, sink);
        const sha256 = hash.digest('hex');
        if (expectedDigest && sha256 !== expectedDigest || expectedBytes !== undefined && bytes !== Number(expectedBytes)) throw new Error('备份明文摘要或长度不匹配。');

        // 移除发布方的临时硬链接会改变 inode 的 ctime，但不会改变不可变的密封字节；
        // 并发重复读取方绑定 inode/大小/修改时间并校验全部字节。
        if (sealedIdentity(stat) !== sealedIdentity(await handle.stat({ bigint: true })) || sealedIdentity(stat) !== sealedIdentity(await regularFile(source))) throw new Error('备份校验期间文件发生变化。');
        if (output) await output.sync();
        return { sha256, bytes };
    } catch (error) {
        if (output) { await output.close(); output = null; await fs.unlink(destination).catch(() => {}); }
        throw error;
    } finally { await output?.close(); await handle.close(); }
}

async function sealFile({ source, destination, key, context, expectedDigest }) {
    await privateDirectory(path.dirname(destination));
    const stat = await regularFile(source), before = signature(stat);
    // 已归档的段或内容对象可重试，但绝不可覆盖替换。
    try {
        await fs.lstat(destination);
        const sha256 = expectedDigest || await digestBackupFile(source);
        const verified = await decryptTo({ source: destination, key, context, expectedDigest: sha256, expectedBytes: stat.size });
        if (before !== signature(await regularFile(source))) throw new Error('备份期间来源文件发生变化。');
        return { ...verified, existing: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(destination), `.pending-${crypto.randomUUID()}`);
    let output;
    try {
        output = await fs.open(temporary, 'wx', 0o600);
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(`pivot.backup.v1:${context}`));
        await output.writeFile(Buffer.concat([MAGIC, nonce]));
        const hash = crypto.createHash('sha256'); let bytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); } });
        const input = await fs.open(source, streams.constants.O_RDONLY | (streams.constants.O_NOFOLLOW || 0));
        try {
            if (before !== signature(await input.stat({ bigint: true }))) throw new Error('备份来源在打开前发生变化。');
            await pipeline(input.createReadStream({ autoClose: false }), meter, cipher, fileSink(output));
            if (before !== signature(await input.stat({ bigint: true })) || before !== signature(await regularFile(source))) throw new Error('备份期间来源文件发生变化。');
        } finally { await input.close(); }
        const sha256 = hash.digest('hex');
        if (expectedDigest && expectedDigest !== sha256) throw new Error('来源文件不符合预期摘要。');
        await output.write(cipher.getAuthTag(), 0, 16, HEADER_BYTES + bytes); await output.sync();
        await output.close(); output = null;
        try { await fs.link(temporary, destination); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await decryptTo({ source: destination, key, context, expectedDigest: sha256, expectedBytes: bytes });
        }
        await syncDirectory(path.dirname(destination));
        return { sha256, bytes, existing: false };
    } finally {
        await output?.close(); await fs.unlink(temporary).catch(() => {}); await syncDirectory(path.dirname(destination));
    }
}

async function restoreFile(options) {
    const destination = path.resolve(options.destination), parent = path.dirname(destination);
    if (options.privateParent !== false) await privateDirectory(parent);
    else {
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(parent) !== parent || process.platform !== 'win32' && (stat.mode & 0o022)) throw new Error('配置恢复目录路径或写入权限无效。');
    }
    // 鉴权和完整摘要校验未通过前，绝不能发布明文内容。
    const temporary = path.join(parent, `.restore-${crypto.randomUUID()}`);
    try {
        const result = await decryptTo({ ...options, destination: temporary });
        await fs.link(temporary, destination); await syncDirectory(parent);
        return result;
    } finally { await fs.unlink(temporary).catch(() => {}); await syncDirectory(parent); }
}

async function writeJson({ value, destination, key, context }) {
    await privateDirectory(path.dirname(destination));
    const temporary = path.join(path.dirname(destination), `.json-${crypto.randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try { return await sealFile({ source: temporary, destination, key, context }); }
    finally { await fs.unlink(temporary).catch(() => {}); }
}
async function readSealedJson({ source, key, context, maxBytes = 128 * 1024 * 1024 }) {
    const stat = await regularFile(source);
    if (stat.size > BigInt(maxBytes + HEADER_BYTES + 16)) throw new Error('备份清单超过读取边界。');
    const value = await fs.readFile(source), nonce = value.subarray(8, HEADER_BYTES);
    if (!value.subarray(0, 8).equals(MAGIC)) throw new Error('备份清单格式无效。');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(`pivot.backup.v1:${context}`)); decipher.setAuthTag(value.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(value.subarray(HEADER_BYTES, -16)), decipher.final()]).toString('utf8'));
}

module.exports = { inside, privateDirectory, readKey, regularFile, signature, digest: digestBackupFile, syncDirectory, sealFile, verifyFile: decryptTo, restoreFile, writeJson, readJson: readSealedJson };
