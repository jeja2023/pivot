'use strict';

const unzipper = require('unzipper');
const { STANDARD_LAYOUTS } = require('./presentation-templates');

const MAX_PPTX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const MAX_PPTX_TEMPLATE_ENTRIES = 800;
const MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;

function importError(message, code = 'PRESENTATION_PPTX_TEMPLATE_INVALID', status = 400) {
    const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; error.expose = true; return error;
}

function decodeXml(value) {
    return String(value || '').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attributeValue(tag, name) {
    const match = String(tag || '').match(new RegExp('\\b' + name + '\\s*=\\s*[\"\']([^\"\']*)[\"\']', 'i'));
    return match ? decodeXml(match[1]) : '';
}

function hexColor(value, fallback) {
    const color = String(value || '').replace(/^#/, '').trim();
    return /^[0-9a-f]{6}$/i.test(color) ? '#' + color.toUpperCase() : fallback;
}

function colorFromFragment(fragment, fallback) {
    const srgb = String(fragment || '').match(/<a:srgbClr\b[^>]*\bval=[\"']([0-9a-f]{6})[\"'][^>]*>/i);
    if (srgb) return hexColor(srgb[1], fallback);
    const system = String(fragment || '').match(/<a:sysClr\b[^>]*\blastClr=[\"']([0-9a-f]{6})[\"'][^>]*>/i);
    return system ? hexColor(system[1], fallback) : fallback;
}

function extractColorScheme(themeXml) {
    const defaults = { primary: '#1769AA', secondary: '#5B8FF9', accent: '#61DDAA', text: '#1F2937', background: '#F7F9FC' };
    const find = key => { const match = String(themeXml || '').match(new RegExp('<a:' + key + '\b[^>]*>([\s\S]*?)</a:' + key + '>', 'i')); return match ? match[1] : ''; };
    return {
        primary: colorFromFragment(find('accent1'), defaults.primary),
        secondary: colorFromFragment(find('accent2'), defaults.secondary),
        accent: colorFromFragment(find('accent3'), defaults.accent),
        text: colorFromFragment(find('dk1'), defaults.text),
        background: colorFromFragment(find('lt1'), defaults.background)
    };
}

function extractTypeface(fontBlock) {
    const eastAsian = String(fontBlock || '').match(/<a:ea\b[^>]*\btypeface=[\"']([^\"']*)[\"']/i);
    const latin = String(fontBlock || '').match(/<a:latin\b[^>]*\btypeface=[\"']([^\"']*)[\"']/i);
    return (eastAsian?.[1] || latin?.[1] || 'Microsoft YaHei').trim().slice(0, 120) || 'Microsoft YaHei';
}

function extractFonts(themeXml) {
    const major = String(themeXml || '').match(/<a:majorFont\b[^>]*>([\s\S]*?)<\/a:majorFont>/i);
    const minor = String(themeXml || '').match(/<a:minorFont\b[^>]*>([\s\S]*?)<\/a:minorFont>/i);
    return { heading: extractTypeface(major?.[1]), body: extractTypeface(minor?.[1]) };
}

function inferAspectRatio(presentationXml) {
    const match = String(presentationXml || '').match(/<p:sldSz\b[^>]*\bcx=[\"'](\d+)[\"'][^>]*\bcy=[\"'](\d+)[\"'][^>]*>/i);
    if (!match) return '16:9';
    const ratio = Number(match[1]) / Math.max(1, Number(match[2]));
    return Math.abs(ratio - 4 / 3) < Math.abs(ratio - 16 / 9) ? '4:3' : '16:9';
}

function inferBackground(masterXml, fallback) {
    const match = String(masterXml || '').match(/<p:bgPr\b[^>]*>([\s\S]*?)<\/p:bgPr>/i);
    return colorFromFragment(match?.[1], fallback);
}

function layoutIdForName(name, index) {
    const normalized = String(name || '').toLowerCase();
    if (/section|章节/.test(normalized)) return 'section';
    if (/title.*slide|标题幻灯片|封面/.test(normalized)) return 'cover';
    if (/two|comparison|比较|双栏/.test(normalized)) return 'two-column';
    if (/three|三栏|card/.test(normalized)) return 'three-card';
    if (/picture|image|图片|图像/.test(normalized)) return 'image-focus';
    if (/chart|图表/.test(normalized)) return 'chart';
    if (/table|表格/.test(normalized)) return 'table';
    if (/quote|引用/.test(normalized)) return 'quote';
    if (/summary|总结/.test(normalized)) return 'summary';
    if (/title|标题|content|内容/.test(normalized)) return 'title-content';
    return STANDARD_LAYOUTS[index % STANDARD_LAYOUTS.length].id;
}

function parseLayouts(entries) {
    const seen = new Set(); const layouts = [];
    entries.filter(entry => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(entry.path)).sort((a, b) => a.path.localeCompare(b.path)).forEach((entry, index) => {
        const match = String(entry.text || '').match(/<p:cSld\b[^>]*>/i); const name = attributeValue(match?.[0], 'name') || '导入布局 ' + (index + 1);
        const id = layoutIdForName(name, index); if (seen.has(id)) return; seen.add(id);
        const standard = STANDARD_LAYOUTS.find(item => item.id === id) || STANDARD_LAYOUTS[0]; layouts.push({ id, name: decodeXml(name).slice(0, 120), category: standard.category, slots: [...standard.slots] });
    });
    return layouts.length ? layouts : STANDARD_LAYOUTS.map(item => ({ ...item, slots: [...item.slots] }));
}

function collectWarnings(entries) {
    const paths = entries.map(entry => entry.path.toLowerCase()); const content = entries.map(entry => entry.text || '').join('\n'); const warnings = [];
    if (paths.some(path => path.endsWith('vbaproject.bin') || path.includes('/activex/'))) warnings.push('检测到宏或 ActiveX 控件；已忽略且不会导入。');
    if (/<p:timing\b/i.test(content)) warnings.push('检测到动画或转场；已忽略。');
    if (paths.some(path => path.includes('/embeddings/'))) warnings.push('检测到嵌入对象；已忽略。');
    if (paths.some(path => path.includes('/media/'))) warnings.push('检测到音视频媒体；已忽略。');
    if (paths.some(path => path.includes('/charts/'))) warnings.push('检测到 Office 原生图表；布局会保留，图表数据不会转换为模板对象。');
    if (paths.some(path => path.includes('/theme/')) === false) warnings.push('未找到主题定义，已使用 Pivot 默认颜色和字体。');
    return warnings;
}

async function readArchiveEntries(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PPTX_TEMPLATE_BYTES) throw importError('PPTX 模板包为空或超过 20MB 限制。', 'PRESENTATION_PPTX_TEMPLATE_TOO_LARGE', 413);
    if (buffer.subarray(0, 2).toString() !== 'PK') throw importError('导入文件不是有效的 PPTX/OOXML 包。');
    let directory; try { directory = await unzipper.Open.buffer(buffer); } catch (_) { throw importError('PPTX 模板包无法解压。'); }
    const files = directory.files.filter(file => file.type === 'File');
    if (!files.length || files.length > MAX_PPTX_TEMPLATE_ENTRIES) throw importError('PPTX 模板包文件数量异常。');
    const uncompressedBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.uncompressedSize ?? file.vars?.uncompressedSize ?? 0) || 0), 0);
    if (uncompressedBytes > MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES) throw importError('PPTX 模板解压后超过 12MB 限制。', 'PRESENTATION_PPTX_TEMPLATE_UNCOMPRESSED_TOO_LARGE', 413);
    if (files.some(file => /(^|\/)\.\.(\/|$)|^[\/\\]/.test(file.path))) throw importError('PPTX 模板包包含非法路径。');
    return Promise.all(files.map(async file => ({ path: file.path.replace(/\\/g, '/'), text: /\.(xml|rels)$/i.test(file.path) ? (await file.buffer()).toString('utf8') : '' })));
}

async function importPptxTemplatePackage(buffer, options = {}) {
    const entries = await readArchiveEntries(buffer);
    const contentTypes = entries.find(entry => entry.path === '[Content_Types].xml')?.text || '';
    const presentation = entries.find(entry => entry.path === 'ppt/presentation.xml')?.text || '';
    if (!/presentationml\.presentation\.main\+xml/i.test(contentTypes) || !presentation) throw importError('文件不是演示文稿 PPTX。');
    const themeXml = entries.find(entry => /^ppt\/theme\/theme\d+\.xml$/i.test(entry.path))?.text || '';
    const masterXml = entries.find(entry => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(entry.path))?.text || '';
    const colors = extractColorScheme(themeXml); colors.background = inferBackground(masterXml, colors.background);
    const aspectRatio = inferAspectRatio(presentation); const layouts = parseLayouts(entries); const warnings = collectWarnings(entries);
    const name = String(options.name || options.filename || '导入 PPTX 模板').replace(/\.pptx$/i, '').trim().slice(0, 120) || '导入 PPTX 模板';
    return {
        name, aspectRatio, warnings,
        definition: {
            theme: { name, colors, fonts: extractFonts(themeXml), chartPalette: [colors.primary, colors.secondary, colors.accent, '#F59E0B', '#8B5CF6', '#EC4899'] },
            layouts, brandControls: {},
            importMetadata: { sourceFormat: 'pptx', importedAt: new Date().toISOString(), warningCount: warnings.length }
        }
    };
}

module.exports = { MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES, importPptxTemplatePackage, parseLayouts };
