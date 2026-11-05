const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const manifest = require('../assets/fonts/official/manifest.json');
const { checkOfficialFonts, prepareOfficialFonts } = require('../scripts/official_fonts');
const { officialFontsOrSkip } = require('./helpers/official-writing-rendering');

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-official-font-bundle-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('字体包校验只接受目录内文件，缺失时不借用已安装的系统字体', async (t) => {
    const directory = await temporaryDirectory(t);
    await assert.rejects(() => checkOfficialFonts(directory), error => {
        assert.equal(error.code, 'OFFICIAL_FONT_BUNDLE_INVALID');
        assert.ok(error.message.includes(`缺少 ${manifest.fonts[0].filename}`));
        return true;
    });
});

test('字体包拒绝截断文件和大小相同但内容被替换的文件', async (t) => {
    const directory = await temporaryDirectory(t);
    const entry = manifest.fonts[0], filename = path.join(directory, entry.filename);
    await fs.writeFile(filename, Buffer.from('invalid-font'));
    await assert.rejects(() => checkOfficialFonts(directory), /文件类型或大小与清单不符/);
    await fs.writeFile(filename, Buffer.alloc(entry.sizeBytes));
    await assert.rejects(() => checkOfficialFonts(directory), /SHA-256 与清单不符/);
});

test('字体准备命令要求显式的完整原字体来源', async (t) => {
    const directory = await temporaryDirectory(t);
    await assert.rejects(() => prepareOfficialFonts(), /请传入已授权的原字体目录/);
    await assert.rejects(() => prepareOfficialFonts(directory, path.join(directory, 'output')), { code: 'OFFICIAL_FONTS_UNAVAILABLE' });
});

test('真实字体包可重复准备和校验，已有不同版本不会被覆盖', async (t) => {
    const sources = await officialFontsOrSkip(t);
    if (!sources) return;
    const directory = await temporaryDirectory(t), source = path.join(directory, 'source'), destination = path.join(directory, 'prepared');
    await fs.mkdir(source);
    for (const entry of manifest.fonts) await fs.writeFile(path.join(source, entry.filename), sources[entry.role].data);
    const first = await prepareOfficialFonts(source, destination);
    assert.equal(first.count, 6);
    assert.equal(first.totalBytes, 69533296);
    assert.equal(first.profile, manifest.profile);
    assert.deepEqual(await prepareOfficialFonts(source, destination), first);
    assert.deepEqual(await checkOfficialFonts(destination), first);
    const filename = path.join(destination, manifest.fonts[0].filename), changed = Buffer.from('已有其他字体版本');
    await fs.writeFile(filename, changed);
    await assert.rejects(() => prepareOfficialFonts(source, destination), /大小或 SHA-256 与清单不符/);
    assert.deepEqual(await fs.readFile(filename), changed);
});
