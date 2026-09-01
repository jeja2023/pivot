const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const unzipper = require('unzipper');
const { validateSkillManifest, verifySkillSignature } = require('./agent-skills');
const { normalizeRelativeEntryPath, isSymlinkExternalAttributes } = require('./agent-path-safety');
const { scanSkillPackageEntries } = require('./agent-skill-supply-chain');

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_PACKAGE_FILES = 128;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/**
 * 条目路径安全校验。
 * 落地方案 v1.2 §7.7 第 3 条：与本机交付写入共用同一套路径安全工具（agent-path-safety），
 * 不再各写一份，因此这里只做委派并保留原有的中文错误语义。
 */
function safeEntryPath(name) {
    try {
        return normalizeRelativeEntryPath(name);
    } catch (error) {
        const wrapped = new Error(`Skill 包包含非法或越权路径：${error.message}`);
        wrapped.code = 'AGENT_SKILL_PACKAGE_PATH_UNSAFE';
        throw wrapped;
    }
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
        // 符号链接必须在解包前拒绝：写盘阶段再判断已经晚了。
        if (isSymlinkExternalAttributes(file.externalFileAttributes)) {
            throw new Error(`Skill 包禁止包含符号链接条目：${name}`);
        }
        const declaredSize = Number(file.uncompressedSize);
        if (Number.isFinite(declaredSize) && declaredSize >= 0 && totalBytes + declaredSize > (Number(options.maxUnpackedBytes) || MAX_UNPACKED_BYTES)) {
            throw new Error('Skill 包解压后超过大小限制。');
        }
        const data = await file.buffer();
        totalBytes += data.length;
        if (totalBytes > (Number(options.maxUnpackedBytes) || MAX_UNPACKED_BYTES)) throw new Error('Skill 包解压后超过大小限制。');
        entries.push({
            name,
            data,
            compressedSize: Number(file.compressedSize) || 0,
            uncompressedSize: Number.isFinite(declaredSize) ? declaredSize : data.length,
            externalFileAttributes: Number(file.externalFileAttributes) || 0
        });
    }
    const manifestEntry = entries.find(entry => ['SKILL.yaml', 'SKILL.yml', 'SKILL.json', 'SKILL.md'].includes(entry.name));
    if (!manifestEntry) throw new Error('Skill 包缺少根目录 SKILL.yaml。');
    const signatureEntry = entries.find(entry => entry.name === 'SKILL.sig' || entry.name === 'package.sig');
    const instructionEntry = entries.find(entry => entry.name === 'INSTRUCTIONS.md' || entry.name === 'instructions.md');
    return {
        entries,
        manifestEntryName: manifestEntry.name,
        manifestText: manifestEntry.data.toString('utf8'),
        instructions: instructionEntry ? instructionEntry.data.toString('utf8') : '',
        signature: signatureEntry ? signatureEntry.data.toString('utf8').trim() : '',
        signatureForm: signatureEntry ? 'detached' : 'embedded',
        digest: packageDigest(entries),
        bytes: totalBytes
    };
}

async function verifySkillPackage(zipPath, options = {}) {
    const pack = await readSkillPackage(zipPath, options);
    const { parseSkillSourceMarkdown, isSkillSourceMarkdown } = require('./agent-skill-source');
    // SKILL.md 与 SKILL.yaml 走同一条规范化路径，保证清单事实来源唯一（§5.2 第 1/2 条）。
    const manifestValue = isSkillSourceMarkdown(pack.manifestEntryName)
        ? parseSkillSourceMarkdown(pack.manifestText).manifest
        : pack.manifestText;
    const checked = validateSkillManifest(manifestValue, options);
    if (!checked.valid) return { valid: false, errors: checked.errors, package: pack, manifest: checked };
    const manifestSignature = verifySkillSignature(checked.manifest, options);
    const packageSignature = verifyPackageSignature(pack.digest, pack.signature, options.publicKey, options.algorithm);
    const signatureRequired = options.requireSignature === true;
    const signatureValid = pack.signature ? packageSignature.verified : manifestSignature.verified;
    const supplyChain = scanSkillPackageEntries(pack.entries, checked.manifest);
    const errors = [];
    if (signatureRequired && !signatureValid) errors.push('Skill 包缺少有效数字签名。');
    if (checked.manifest.package_digest && String(checked.manifest.package_digest).replace(/^sha256:/i, '').toLowerCase() !== pack.digest) errors.push('Skill 包 package_digest 校验失败。');
    errors.push(...supplyChain.errors);
    return {
        valid: errors.length === 0,
        errors,
        package: pack,
        manifest: checked,
        manifestSignature,
        packageSignature,
        signatureValid,
        signatureForm: pack.signatureForm,
        supplyChain
    };
}

/**
 * 安装 Skill 包到内容寻址目录。
 * 落地方案 v1.2 §5.2 第 4 条与阶段 0.8：
 * 1. 目录名取内容摘要（sha256/<contentDigest>），同一逻辑版本摘要不同即产生新目录；
 * 2. 绝不再对由 manifest 推导出的路径执行 rm -rf；已存在的摘要目录视为同一制品直接复用，
 *    从而使安装目录不可变，也消除路径穿越删除目标外内容的风险。
 */
async function installSkillPackage(zipPath, options = {}) {
    const verified = await verifySkillPackage(zipPath, options);
    if (!verified.valid) {
        const error = new Error(`Skill 包校验失败：${verified.errors.join('；')}`);
        error.code = 'AGENT_SKILL_PACKAGE_INVALID';
        error.details = verified;
        throw error;
    }
    const root = path.resolve(options.installRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-skills'));
    const contentDigest = verified.package.digest;
    if (!/^[0-9a-f]{64}$/.test(contentDigest)) throw new Error('Skill 包内容摘要非法，拒绝安装。');
    const installDir = path.join(root, 'sha256', contentDigest);
    await fsp.mkdir(installDir, { recursive: true, mode: 0o700 });
    for (const entry of verified.package.entries) {
        const target = path.join(installDir, entry.name);
        const relative = path.relative(installDir, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Skill 包安装路径越权。');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        // 内容寻址目录是不可变制品：同摘要文件已存在即认为一致，不覆盖也不删除。
        try {
            await fsp.access(target);
        } catch (_) {
            await fsp.writeFile(target, entry.data, { mode: 0o600 });
        }
    }
    return { ...verified, installDir, contentDigest };
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
