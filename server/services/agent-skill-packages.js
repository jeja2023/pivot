const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const unzipper = require('unzipper');
const { validateSkillManifest, verifySkillSignature } = require('./agent-skills');

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_PACKAGE_FILES = 128;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

function safeEntryPath(name) {
    const normalized = String(name || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('Skill 包包含非法路径。');
    const target = path.posix.normalize(normalized);
    if (target === '..' || target.startsWith('../')) throw new Error('Skill 包包含越权路径。');
    return target;
}

function packageDigest(entries) {
    // The detached signature must not sign itself. Keep the digest stable
    // while allowing SKILL.sig/package.sig to be added after signing.
    const ordered = [...entries]
        .filter(entry => !['SKILL.sig', 'package.sig'].includes(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    const hash = crypto.createHash('sha256');
    ordered.forEach(entry => hash.update(entry.name).update('\0').update(crypto.createHash('sha256').update(entry.data).digest('hex')).update('\0'));
    return hash.digest('hex');
}

function verifyPackageSignature(digest, signature, publicKey, algorithm = 'RSA-SHA256') {
    if (!signature || !publicKey) return { verified: false, reason: 'unsigned' };
    try {
        const verifier = crypto.createVerify(algorithm);
        verifier.update(String(digest));
        verifier.end();
        return { verified: verifier.verify(publicKey, Buffer.from(String(signature).trim(), 'base64')) };
    } catch (error) { return { verified: false, reason: error.message }; }
}

async function readSkillPackage(zipPath, options = {}) {
    const stat = await fsp.stat(zipPath);
    if (stat.size > (Number(options.maxPackageBytes) || MAX_PACKAGE_BYTES)) throw new Error('Skill 包超过大小限制。');
    const directory = await unzipper.Open.file(zipPath);
    const entries = [];
    const names = new Set();
    let totalBytes = 0;
    if (directory.files.length > (Number(options.maxFiles) || MAX_PACKAGE_FILES)) throw new Error('Skill 包文件数量超过限制。');
    for (const file of directory.files) {
        if (file.type === 'Directory') continue;
        const name = safeEntryPath(file.path);
        if (names.has(name)) throw new Error('Skill 包包含重复文件路径。');
        names.add(name);
        const declaredSize = Number(file.uncompressedSize);
        if (Number.isFinite(declaredSize) && declaredSize >= 0 && totalBytes + declaredSize > (Number(options.maxUnpackedBytes) || MAX_UNPACKED_BYTES)) {
            throw new Error('Skill 包解压后超过大小限制。');
        }
        const data = await file.buffer();
        totalBytes += data.length;
        if (totalBytes > (Number(options.maxUnpackedBytes) || MAX_UNPACKED_BYTES)) throw new Error('Skill 包解压后超过大小限制。');
        entries.push({ name, data });
    }
    const manifestEntry = entries.find(entry => entry.name === 'SKILL.yaml' || entry.name === 'SKILL.yml' || entry.name === 'SKILL.json');
    if (!manifestEntry) throw new Error('Skill 包缺少根目录 SKILL.yaml。');
    const signatureEntry = entries.find(entry => entry.name === 'SKILL.sig' || entry.name === 'package.sig');
    const instructionEntry = entries.find(entry => entry.name === 'INSTRUCTIONS.md' || entry.name === 'instructions.md');
    return {
        entries,
        manifestText: manifestEntry.data.toString('utf8'),
        instructions: instructionEntry ? instructionEntry.data.toString('utf8') : '',
        signature: signatureEntry ? signatureEntry.data.toString('utf8').trim() : '',
        digest: packageDigest(entries),
        bytes: totalBytes
    };
}

async function verifySkillPackage(zipPath, options = {}) {
    const pack = await readSkillPackage(zipPath, options);
    const checked = validateSkillManifest(pack.manifestText, options);
    if (!checked.valid) return { valid: false, errors: checked.errors, package: pack, manifest: checked };
    const manifestSignature = verifySkillSignature(checked.manifest, options);
    const packageSignature = verifyPackageSignature(pack.digest, pack.signature, options.publicKey, options.algorithm);
    const signatureRequired = options.requireSignature === true;
    const signatureValid = pack.signature ? packageSignature.verified : manifestSignature.verified;
    const errors = [];
    if (signatureRequired && !signatureValid) errors.push('Skill 包缺少有效数字签名。');
    if (checked.manifest.package_digest && String(checked.manifest.package_digest).replace(/^sha256:/i, '').toLowerCase() !== pack.digest) errors.push('Skill 包 package_digest 校验失败。');
    return { valid: errors.length === 0, errors, package: pack, manifest: checked, manifestSignature, packageSignature, signatureValid };
}

async function installSkillPackage(zipPath, options = {}) {
    const verified = await verifySkillPackage(zipPath, options);
    if (!verified.valid) {
        const error = new Error(`Skill 包校验失败：${verified.errors.join('；')}`);
        error.code = 'AGENT_SKILL_PACKAGE_INVALID';
        error.details = verified;
        throw error;
    }
    const manifest = verified.manifest.manifest;
    const root = path.resolve(options.installRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-skills'));
    const installDir = path.join(root, String(manifest.id).replace(/[^a-zA-Z0-9._-]/g, '_'), String(manifest.version).replace(/[^a-zA-Z0-9._-]/g, '_'));
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.mkdir(installDir, { recursive: true, mode: 0o700 });
    for (const entry of verified.package.entries) {
        const target = path.join(installDir, entry.name);
        const relative = path.relative(installDir, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Skill 包安装路径越权。');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, entry.data, { mode: 0o600 });
    }
    return { ...verified, installDir };
}

module.exports = {
    MAX_PACKAGE_BYTES,
    MAX_PACKAGE_FILES,
    MAX_UNPACKED_BYTES,
    installSkillPackage,
    packageDigest,
    readSkillPackage,
    verifyPackageSignature,
    verifySkillPackage
};
