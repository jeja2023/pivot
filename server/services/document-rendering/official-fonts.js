const fs = require('node:fs/promises');
const path = require('node:path');
const fontkit = require('@pdf-lib/fontkit');
const format = require('../../../client/common/official-writing-format');

const FILES = { title: ['方正小标宋_GBK.TTF', 'FZXBSK.TTF'], body: ['方正仿宋_GBK.TTF', 'FZFSK.TTF'], heading1: ['方正黑体_GBK.TTF', 'FZHTK.TTF'],
    heading2: ['方正楷体_GBK.TTF', 'FZKTK.TTF'], footer: ['simsun.ttc', 'SimSun.ttf'], ascii: ['times.ttf', 'Times New Roman.ttf'] };
let cached = null;

function fontDirectories() {
    const directories = [process.env.PIVOT_PDF_FONT_DIR, path.resolve(__dirname, '../../../assets/fonts/official')].filter(Boolean);
    if (process.platform === 'win32') directories.push(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'));
    return [...new Set(directories.map(dir => path.resolve(dir)))];
}

async function readOfficialFonts(directories = fontDirectories()) {
    const result = {}, missing = [];
    for (const [role, filenames] of Object.entries(FILES)) {
        let picked = null;
        for (const directory of directories) {
            let names;
            try { names = await fs.readdir(directory); } catch (_) { continue; }
            for (const filename of filenames) {
                const actual = names.find(name => name.toLowerCase() === filename.toLowerCase());
                if (!actual) continue;
                const filenamePath = path.join(directory, actual);
                const stat = await fs.stat(filenamePath);
                if (!stat.isFile() || stat.size > 64 * 1024 * 1024) continue;
                const data = await fs.readFile(filenamePath);
                const parsed = fontkit.create(data);
                const faces = parsed.fonts || [parsed];
                const face = faces.find(face => format.ALIASES[role].some(alias => [face.familyName, face.postscriptName, face.fullName].includes(alias)));
                if (!face) continue;
                const rights = face['OS/2']?.fsType;
                if (rights?.noEmbedding || rights?.bitmapOnly) continue;
                picked = { data, face, faceName: face.postscriptName, name: format.FONT[role], subset: !rights?.noSubsetting };
                break;
            }
            if (picked) break;
        }
        if (picked) result[role] = picked; else missing.push(format.FONT[role]);
    }
    if (missing.length) throw Object.assign(new Error(`严格公文版式缺少可嵌入的指定字体：${missing.join('、')}。请将已授权字体安装到服务端或放入字体目录后重试；不会使用替代字体冒充达标。`), { status: 503, code: 'OFFICIAL_FONTS_UNAVAILABLE' });
    return result;
}

async function loadOfficialFonts() {
    if (!cached) cached = readOfficialFonts().catch(error => { cached = null; throw error; });
    return cached;
}

async function embedOfficialFonts(document) {
    const sources = await loadOfficialFonts(), result = {};
    document.registerFontkit({ create(data) {
        const source = Object.values(sources).find(source => source.data.length === data.length && source.data.equals(Buffer.from(data)));
        return source ? source.face : fontkit.create(data);
    } });
    for (const [role, source] of Object.entries(sources)) result[role] = await document.embedFont(source.data, { subset: source.subset, customName: source.faceName });
    return result;
}

async function officialFontStatus() {
    try { await loadOfficialFonts(); return { available: true, fonts: Object.values(format.FONT), profile: format.ID }; }
    catch (error) { return { available: false, error: error.message, profile: format.ID }; }
}

module.exports = { embedOfficialFonts, loadOfficialFonts, officialFontStatus, readOfficialFonts };
