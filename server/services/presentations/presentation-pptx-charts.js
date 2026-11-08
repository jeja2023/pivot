'use strict';

const Zip = require('jszip');
const { NS, parse, all, relationships } = require('./presentation-pptx-xml');

function cacheValues(series, kind) {
    const container = all(series, NS.c, kind)[0];
    if (!container) return [];
    return all(container, NS.c, 'pt').sort((a, b) => Number(a.getAttribute('idx')) - Number(b.getAttribute('idx')))
        .map(point => all(point, NS.c, 'v')[0]?.textContent ?? '');
}
function formulaValues(formula, sheets) {
    const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(String(formula || ''));
    if (!match || (match[5] && match[5] !== match[3])) return null;
    const sheet = sheets.get((match[1] || match[2]).replace(/''/g, "'")), start = Number(match[4]), end = Number(match[6] || match[4]);
    if (!sheet || start < 1 || end < start || end - start > 1000) return null;
    return Array.from({ length: end - start + 1 }, (_, index) => sheet.get(match[3] + (start + index)));
}
async function readWorkbook(buffer) {
    const zip = await Zip.loadAsync(buffer), strings = [];
    const shared = zip.file('xl/sharedStrings.xml');
    if (shared) all(parse(await shared.async('string')), NS.x, 'si').forEach(node => strings.push(all(node, NS.x, 't').map(item => item.textContent).join('')));
    const workbook = zip.file('xl/workbook.xml');
    if (!workbook) throw new Error('图表数据工作簿缺少登记文件。');
    const rels = await relationships(zip, 'xl/workbook.xml'), sheets = new Map();
    for (const sheet of all(parse(await workbook.async('string')), NS.x, 'sheet')) {
        const rel = rels.get(sheet.getAttributeNS(NS.r, 'id')), file = rel && zip.file(rel.target);
        if (!file || rel.external) throw new Error('图表数据工作表关系无效。');
        const cells = new Map();
        for (const cell of all(parse(await file.async('string')), NS.x, 'c')) {
            const raw = all(cell, NS.x, 'v')[0]?.textContent, type = cell.getAttribute('t');
            const value = type === 's' ? strings[Number(raw)] : type === 'inlineStr' ? all(cell, NS.x, 't').map(node => node.textContent).join('') : raw;
            cells.set(cell.getAttribute('r'), value);
        }
        sheets.set(sheet.getAttribute('name'), cells);
    }
    return sheets;
}

async function inspectNativeChart(zip, slideFile, record, element, workbookCache) {
    const issues = [], add = (code, message) => issues.push({ code, elementId: element.id, message });
    if (!record) { add('EXPORT_NATIVE_CHART_MISSING', 'PPTX 缺少对应原生图表对象。'); return issues; }
    const reference = all(record.node, NS.c, 'chart')[0];
    const rel = (await relationships(zip, slideFile)).get(reference?.getAttributeNS(NS.r, 'id'));
    const file = rel && /\/chart$/.test(rel.type) && !rel.external && zip.file(rel.target);
    if (!file) { add('EXPORT_CHART_RELATION_INVALID', '原生图表与当前页面的引用关系无效。'); return issues; }
    const document = parse(await file.async('string')), series = all(document, NS.c, 'ser');
    const expectedSeries = element.data.columns.length - 1;
    const mismatch = series.length !== expectedSeries || series.some((item, index) => {
        const categories = cacheValues(item, 'cat'), values = cacheValues(item, 'val'), name = all(all(item, NS.c, 'tx')[0] || item, NS.c, 'v')[0]?.textContent;
        return name !== element.data.columns[index + 1] || categories.length !== element.data.rows.length || values.length !== element.data.rows.length
            || element.data.rows.some((row, rowIndex) => categories[rowIndex] !== String(row[0]) || values[rowIndex] === '' || Number(values[rowIndex]) !== Number(row[index + 1]));
    });
    if (mismatch) add('EXPORT_CHART_DATA_MISMATCH', 'PPTX 原生图表的名称、分类或数值与源稿不一致。');
    const externalData = all(document, NS.c, 'externalData')[0];
    const dataRel = (await relationships(zip, rel.target)).get(externalData?.getAttributeNS(NS.r, 'id'));
    const dataFile = dataRel && /\/package$/.test(dataRel.type) && !dataRel.external && zip.file(dataRel.target);
    if (!dataFile) { add('EXPORT_CHART_WORKBOOK_MISSING', '原生图表缺少可编辑的数据工作簿。'); return issues; }
    if (!workbookCache.has(dataRel.target)) workbookCache.set(dataRel.target, readWorkbook(await dataFile.async('nodebuffer')));
    const sheets = await workbookCache.get(dataRel.target);
    const workbookMismatch = series.length !== expectedSeries || series.some((item, index) => {
        const names = formulaValues(all(all(item, NS.c, 'tx')[0] || item, NS.c, 'f')[0]?.textContent, sheets);
        const categories = formulaValues(all(all(item, NS.c, 'cat')[0] || item, NS.c, 'f')[0]?.textContent, sheets);
        const values = formulaValues(all(all(item, NS.c, 'val')[0] || item, NS.c, 'f')[0]?.textContent, sheets);
        return !names || names[0] !== element.data.columns[index + 1] || !categories || !values || categories.length !== element.data.rows.length || values.length !== element.data.rows.length
            || element.data.rows.some((row, rowIndex) => String(categories[rowIndex]) !== String(row[0]) || values[rowIndex] === undefined || values[rowIndex] === '' || Number(values[rowIndex]) !== Number(row[index + 1]));
    });
    if (workbookMismatch) add('EXPORT_CHART_WORKBOOK_MISMATCH', '图表嵌入工作簿中的名称、分类或数值与源稿不一致。');
    return issues;
}

module.exports = { inspectNativeChart };
