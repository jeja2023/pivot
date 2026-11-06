'use strict';

const Zip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

function compact(value) { return String(value ?? '').replace(/\s/gu, ''); }
function xmlText(xml) {
    const document = new DOMParser({ onError: () => {} }).parseFromString(xml, 'application/xml');
    return Array.from(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 't')).map(node => node.textContent).join('');
}

async function verifyPptxExport(buffer, presentation) {
    const zip = await Zip.loadAsync(buffer);
    const files = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
    const issues = [];
    const expectedCharts = [];
    if (files.length !== presentation.slides.length) issues.push({ code: 'EXPORT_PAGE_COUNT', message: 'PPTX 页面数量与源稿不一致。' });
    let textElements = 0, tables = 0, charts = 0;
    for (let index = 0; index < presentation.slides.length; index++) {
        const slide = presentation.slides[index], file = files[index];
        if (!file) continue;
        const actual = compact(xmlText(await zip.file(file).async('string')));
        for (const element of slide.elements.filter(element => element.visible)) {
            const expected = element.type === 'text' ? [element.content.text] : element.type === 'table' ? [element.columns, ...element.rows].flat() : element.type === 'diagram' ? element.items : [];
            if (element.type === 'text') textElements++;
            if (element.type === 'table') tables++;
            if (element.type === 'chart') { charts++; expectedCharts.push({ slideId: slide.id, element }); }
            if (expected.some(value => compact(value) && !actual.includes(compact(value)))) issues.push({ code: 'EXPORT_TEXT_MISSING', slideId: slide.id, elementId: element.id, message: 'PPTX 缺少源稿文字或表格内容，请检查导出器。' });
        }
    }
    const chartFiles = Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/chart(\d+)/)[1]) - Number(b.match(/chart(\d+)/)[1]));
    const nativeCharts = chartFiles.length;
    if (nativeCharts < charts) issues.push({ code: 'EXPORT_NATIVE_CHART_MISSING', message: 'PPTX 未保留全部原生图表。' });
    const chartNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
    for (let index = 0; index < expectedCharts.length && chartFiles[index]; index++) {
        const { slideId, element } = expectedCharts[index];
        const document = new DOMParser({ onError: () => {} }).parseFromString(await zip.file(chartFiles[index]).async('string'), 'application/xml');
        const series = Array.from(document.getElementsByTagNameNS(chartNamespace, 'ser'));
        const values = (series, tag) => Array.from(series.getElementsByTagNameNS(chartNamespace, tag)[0]?.getElementsByTagNameNS(chartNamespace, 'v') || []).map(node => node.textContent);
        const mismatch = series.length !== element.data.columns.length - 1 || series.some((item, seriesIndex) => {
            const categories = values(item, 'cat'), numbers = values(item, 'val');
            return categories.length !== element.data.rows.length || numbers.length !== element.data.rows.length
                || element.data.rows.some((row, rowIndex) => categories[rowIndex] !== String(row[0]) || Number(numbers[rowIndex]) !== Number(row[seriesIndex + 1]));
        });
        if (mismatch) issues.push({ code: 'EXPORT_CHART_DATA_MISMATCH', slideId, elementId: element.id, message: 'PPTX 原生图表的分类或数值与源稿不一致。' });
    }
    return { status: issues.length ? 'blocked' : 'passed', slideCount: files.length, textElements, tables, charts: nativeCharts,
        issues, officeVisual: 'not_checked', message: '已核对真实PPTX的页数、文字、表格及原生图表；尚未执行独立Office视觉渲染。' };
}

module.exports = { verifyPptxExport };
