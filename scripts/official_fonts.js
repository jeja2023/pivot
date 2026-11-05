const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const manifest = require('../assets/fonts/official/manifest.json');
const format = require('../client/common/official-writing-format');
const { readOfficialFonts } = require('../server/services/document-rendering/official-fonts');

const DEFAULT_DIRECTORY = path.resolve(__dirname, '../assets/fonts/official');

function bundleError(message) {
    return Object.assign(new Error(`公文字体包校验失败：${message}`), { code: 'OFFICIAL_FONT_BUNDLE_INVALID' });
}

function validateManifest() {
    const roles = Object.keys(format.FONT);
    if (manifest.schemaVersion !== 1 || manifest.profile !== format.ID || manifest.fonts?.length !== roles.length
        || new Set(manifest.fonts.map(font => font.role)).size !== roles.length) {
        throw bundleError('字体清单版本或用途不完整，请恢复受控的 manifest.json。');
    }
    for (const entry of manifest.fonts) {
        if (!roles.includes(entry.role) || entry.name !== format.FONT[entry.role]
            || typeof entry.filename !== 'string' || !/^[^/\\]+\.(ttf|ttc|otf)$/i.test(entry.filename)
            || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || entry.sizeBytes > 64 * 1024 * 1024
            || !/^[a-f0-9]{64}$/.test(entry.sha256) || !entry.postscriptName) {
            throw bundleError('字体清单条目无效，请检查文件名、大小、摘要和内部字体名。');
        }
    }
}

function validateBytes(entry, data) {
    if (data.length !== entry.sizeBytes || crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) {
        throw bundleError(`${entry.filename} 的大小或 SHA-256 与清单不符，请使用对应版本的授权字体包。`);
    }
}

async function checkOfficialFonts(directory = DEFAULT_DIRECTORY) {
    validateManifest();
    for (const entry of manifest.fonts) {
        const filename = path.join(directory, entry.filename);
        let stat;
        try { stat = await fs.stat(filename); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            throw bundleError(`缺少 ${entry.filename}，请先运行 npm run prepare:official-fonts -- <授权字体目录>。`);
        }
        if (!stat.isFile() || stat.size !== entry.sizeBytes) throw bundleError(`${entry.filename} 的文件类型或大小与清单不符。`);
        validateBytes(entry, await fs.readFile(filename));
    }
    // 只检查包内文件，禁止用宿主机系统字体或环境变量掩盖镜像缺失。
    const sources = await readOfficialFonts([directory]);
    for (const entry of manifest.fonts) {
        validateBytes(entry, sources[entry.role].data);
        if (sources[entry.role].faceName !== entry.postscriptName) throw bundleError(`${entry.filename} 的内部字体名与清单不符。`);
    }
    return { profile: manifest.profile, count: manifest.fonts.length, totalBytes: manifest.fonts.reduce((sum, entry) => sum + entry.sizeBytes, 0) };
}

async function prepareOfficialFonts(sourceDirectory, directory = DEFAULT_DIRECTORY) {
    if (!sourceDirectory) throw bundleError('请传入已授权的原字体目录，例如 npm run prepare:official-fonts -- C:/Windows/Fonts。');
    validateManifest();
    const sources = await readOfficialFonts([path.resolve(sourceDirectory)]);
    for (const entry of manifest.fonts) {
        validateBytes(entry, sources[entry.role].data);
        if (sources[entry.role].faceName !== entry.postscriptName) throw bundleError(`${entry.filename} 的内部字体名与清单不符。`);
    }
    await fs.mkdir(directory, { recursive: true });
    // 写入前检查已有文件，避免覆盖发布人员提供的其他字体版本。
    for (const entry of manifest.fonts) {
        try { validateBytes(entry, await fs.readFile(path.join(directory, entry.filename))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of manifest.fonts) {
        try { await fs.writeFile(path.join(directory, entry.filename), sources[entry.role].data, { flag: 'wx', mode: 0o644 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return checkOfficialFonts(directory);
}

if (require.main === module) {
    const [command = 'check', directory, destination] = process.argv.slice(2);
    const task = command === 'check' ? checkOfficialFonts(directory)
        : command === 'prepare' ? prepareOfficialFonts(directory, destination)
            : Promise.reject(bundleError('命令无效，请使用 check [字体包目录] 或 prepare <授权字体目录> [目标目录]。'));
    task.then(result => console.log(`公文字体包校验通过：${result.count} 种字体，共 ${(result.totalBytes / 1024 / 1024).toFixed(2)} MiB，版式 ${result.profile}。`))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { checkOfficialFonts, prepareOfficialFonts };
