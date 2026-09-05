const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');

const {
    installSkillPackage,
    packageDigest,
    readSkillPackage,
    verifyPackageSignature,
    verifySkillPackage
} = require('../server/services/agent-skill-packages');
const {
    installRuntimePack,
    isRuntimePackConsoleEnabled,
    listRuntimePacks,
    sha256File,
    syncRuntimePack,
    verifyRuntimePack
} = require('../server/services/agent-runtime-packs');
const { uploadSecurityMiddleware } = require('../server/upload');

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Store-only ZIP writer keeps this test independent of a platform zip utility.
function writeZip(target, entries) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [name, value] of entries) {
        const nameBuffer = Buffer.from(name, 'utf8');
        const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        const crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuffer.length, 26);
        local.push(header, nameBuffer, data);

        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(data.length, 20);
        directory.writeUInt32LE(data.length, 24);
        directory.writeUInt16LE(nameBuffer.length, 28);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, nameBuffer);
        offset += header.length + nameBuffer.length + data.length;
    }
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(target, Buffer.concat([...local, centralBuffer, end]));
}

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-packages-')); }

test('skill ZIP runtime declares unzipper as a production dependency and verifies it during image build', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
    assert.match(String(manifest.dependencies?.unzipper || ''), /^\^?0\.12\./);
    assert.match(dockerfile, /require\(['"]unzipper['"]\)/);
});

test('SKILL.zip verifies detached RSA signature, permissions and installs in a jailed directory', async () => {
    const root = tempRoot();
    const zipPath = path.join(root, 'demo.skill.zip');
    const unsignedEntries = [
        ['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\npermissions:\n  - filesystem.read_workspace\n'],
        ['INSTRUCTIONS.md', '# Demo\nUse only the supplied workspace.\n']
    ];
    writeZip(zipPath, unsignedEntries);
    const unsignedPack = await readSkillPackage(zipPath);
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedPack.digest);
    signer.end();
    const signature = signer.sign(keys.privateKey).toString('base64');
    writeZip(zipPath, [...unsignedEntries, ['SKILL.sig', signature]]);

    try {
        const checked = await verifySkillPackage(zipPath, {
            allowedPermissions: ['filesystem.read_workspace'],
            requireSignature: true,
            publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
        });
        assert.equal(checked.valid, true);
        assert.equal(checked.package.signature, signature);
        assert.equal(verifyPackageSignature(checked.package.digest, signature, keys.publicKey).verified, true);

        const installed = await installSkillPackage(zipPath, {
            allowedPermissions: ['filesystem.read_workspace'],
            requireSignature: true,
            publicKey: keys.publicKey,
            installRoot: path.join(root, 'installed')
        });
        assert.equal(fs.readFileSync(path.join(installed.installDir, 'INSTRUCTIONS.md'), 'utf8').startsWith('# Demo'), true);
        // 安装目录改为内容寻址且不可变：sha256/<contentDigest>，不再由 manifest 推导且不再先删后写。
        assert.equal(path.dirname(installed.installDir), path.join(root, 'installed', 'sha256'));
        assert.equal(path.basename(installed.installDir), checked.package.digest);
        const reinstalled = await installSkillPackage(zipPath, {
            allowedPermissions: ['filesystem.read_workspace'],
            requireSignature: true,
            publicKey: keys.publicKey,
            installRoot: path.join(root, 'installed')
        });
        assert.equal(reinstalled.installDir, installed.installDir);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('SKILL.zip rejects traversal, duplicate entries and unauthorized permissions', async () => {
    const root = tempRoot();
    try {
        const traversal = path.join(root, 'traversal.zip');
        writeZip(traversal, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['../escape.txt', 'nope']]);
        await assert.rejects(() => readSkillPackage(traversal), /越权/);

        const duplicate = path.join(root, 'duplicate.zip');
        writeZip(duplicate, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['SKILL.yaml', 'id: corp.other\nname: other\nversion: 1.0.0\n']]);
        await assert.rejects(() => readSkillPackage(duplicate), /重复/);

        const unauthorized = path.join(root, 'unauthorized.zip');
        writeZip(unauthorized, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\npermissions:\n  - network.request\n']]);
        const result = await verifySkillPackage(unauthorized, { allowedPermissions: ['filesystem.read_workspace'] });
        assert.equal(result.valid, false);
        assert.match(result.errors.join(' '), /权限/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('SKILL.zip supply chain scan covers actual entries, not the self-declared manifest list', async () => {
    const root = tempRoot();
    try {
        const sensitive = path.join(root, 'sensitive.zip');
        writeZip(sensitive, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['.env', 'SECRET=1']]);
        const sensitiveResult = await verifySkillPackage(sensitive);
        assert.equal(sensitiveResult.valid, false);
        assert.match(sensitiveResult.errors.join(' '), /敏感文件/);

        const hooked = path.join(root, 'hooked.zip');
        writeZip(hooked, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['package.json', JSON.stringify({ name: 'x', scripts: { preinstall: 'node evil.js' } })]]);
        const hookedResult = await verifySkillPackage(hooked);
        assert.equal(hookedResult.valid, false);
        assert.match(hookedResult.errors.join(' '), /生命周期脚本/);

        const scripted = path.join(root, 'scripted.zip');
        writeZip(scripted, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['scripts/run.sh', 'echo hi']]);
        const scriptedResult = await verifySkillPackage(scripted);
        assert.equal(scriptedResult.valid, false);
        assert.match(scriptedResult.errors.join(' '), /可执行内容/);

        const undeclared = path.join(root, 'undeclared.zip');
        writeZip(undeclared, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\nfiles:\n  - data/a.txt\n'], ['data/b.txt', 'not declared']]);
        const undeclaredResult = await verifySkillPackage(undeclared);
        assert.equal(undeclaredResult.valid, false);
        assert.match(undeclaredResult.errors.join(' '), /未在 manifest.files 申报|声明的文件在包中不存在/);

        const lockless = path.join(root, 'lockless.zip');
        writeZip(lockless, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\ndependencies:\n  lodash: 4.17.21\n']]);
        const locklessResult = await verifySkillPackage(lockless);
        assert.equal(locklessResult.valid, false);
        assert.match(locklessResult.errors.join(' '), /锁定文件/);

        const reserved = path.join(root, 'reserved.zip');
        writeZip(reserved, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n'], ['CON.txt', 'reserved']]);
        await assert.rejects(() => readSkillPackage(reserved), /保留名/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('LAN Data/Browser Pack install verifies SHA256 and blocks unallowlisted sync', async () => {
    const root = tempRoot();
    const bundle = path.join(root, 'pack.bundle');
    fs.writeFileSync(bundle, Buffer.from('offline-runtime-pack-v1'));
    const digest = await sha256File(bundle);
    try {
        const checked = await verifyRuntimePack(bundle, { type: 'data', id: 'sales', version: '1.0.0', sha256: digest.sha256, size: digest.size });
        assert.equal(checked.valid, true);
        const installed = await installRuntimePack(bundle, checked.manifest, { root: path.join(root, 'runtime') });
        assert.equal(fs.existsSync(installed.target), true);
        const listed = await listRuntimePacks({ root: path.join(root, 'runtime') });
        assert.equal(listed.length, 1);
        await assert.rejects(() => syncRuntimePack({ type: 'browser', id: 'chromium', version: '1.0.0', sha256: digest.sha256, url: 'https://lan.example.invalid/pack' }, { networkPolicy: { allowed_origins: [] } }), /Origin 白名单/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('LAN runtime pack sync downloads and verifies an allowlisted bundle', async () => {
    const root = tempRoot();
    const payload = Buffer.from('browser-pack-over-lan');
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': payload.length }); res.end(payload); });
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const result = await syncRuntimePack({
            type: 'browser', id: 'chromium', version: '1.0.0', sha256: digest,
            url: `http://127.0.0.1:${port}/browser.bundle`, size: payload.length
        }, {
            root: path.join(root, 'runtime'),
            networkPolicy: { allowed_origins: [`http://127.0.0.1:${port}`], allowed_ports: [port], block_loopback: false, block_private_ranges: false, block_link_local: false }
        });
        assert.equal(fs.readFileSync(result.target).toString(), payload.toString());
    } finally {
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('package digest is independent of detached signature bytes', () => {
    const entries = [{ name: 'SKILL.yaml', data: Buffer.from('id: corp.demo\n') }];
    assert.equal(packageDigest(entries), packageDigest([...entries, { name: 'SKILL.sig', data: Buffer.from('different signature') }]));
});

test('运行资源包控制台默认收起，只有显式 true 才开放内部入口', () => {
    assert.equal(isRuntimePackConsoleEnabled({}), false);
    assert.equal(isRuntimePackConsoleEnabled({ PIVOT_RUNTIME_PACKS_CONSOLE_ENABLED: 'false' }), false);
    assert.equal(isRuntimePackConsoleEnabled({ PIVOT_RUNTIME_PACKS_CONSOLE_ENABLED: 'true' }), true);
});

test('skill ZIP upload passes binary magic validation', async () => {
    const root = tempRoot();
    const zipPath = path.join(root, 'demo.skill.zip');
    writeZip(zipPath, [['SKILL.yaml', 'id: corp.demo\nname: demo\nversion: 1.0.0\n']]);
    let called = false;
    const req = { file: { path: zipPath, originalname: 'demo.skill.zip' }, _pivotUploadRoot: root, _pivotUploadPaths: new Set() };
    const res = { status() { return this; }, json() { return this; } };
    try {
        await uploadSecurityMiddleware(req, res, () => { called = true; });
        assert.equal(called, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
