'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const { defaultPresentation } = require('../server/services/presentations/presentation-schema');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');

const OFFICE_CLIENTS = Object.freeze({
    powerpoint: ['C:/Program Files/Microsoft Office/root/Office16/POWERPNT.EXE', 'C:/Program Files (x86)/Microsoft Office/root/Office16/POWERPNT.EXE'],
    wps: ['C:/Program Files/WPS Office/ksolaunch.exe', 'C:/Program Files (x86)/WPS Office/ksolaunch.exe'],
    libreoffice: ['C:/Program Files/LibreOffice/program/soffice.exe', 'C:/Program Files (x86)/LibreOffice/program/soffice.exe']
});

function firstExisting(candidates) { return candidates.find(file => fs.existsSync(file)) || ''; }
function detectOfficeClients() { return Object.fromEntries(Object.entries(OFFICE_CLIENTS).map(([name, paths]) => [name, { installed: Boolean(firstExisting(paths)), executable: firstExisting(paths) }])); }

async function verifyOfficePackage() {
    const presentation = defaultPresentation({ title: 'Office 兼容性矩阵', template: getBuiltInTemplate('business-blue') });
    presentation.slides[0].speakerNotes = 'Office 验证备注'; presentation.slides[0].transition = { type: 'fade', durationMs: 500 };
    presentation.slides[0].elements[0].animation = { type: 'fade', durationMs: 500, delayMs: 0, direction: '' };
    const rendered = await renderPresentation(presentation, 'pptx'); const zip = await JSZip.loadAsync(rendered.buffer);
    const files = Object.keys(zip.files); const required = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml'];
    const missing = required.filter(item => !files.includes(item)); const slide = await zip.file('ppt/slides/slide1.xml')?.async('string') || '';
    return {
        validZip: rendered.buffer.subarray(0, 2).toString() === 'PK',
        missing,
        hasNotes: files.includes('ppt/notesSlides/notesSlide1.xml'),
        hasTransition: /<p:transition\b/.test(slide),
        hasElementAnimation: /<p:timing>/.test(slide) && /name="pivotAnim_title"/.test(slide) && /filter="fade"/.test(slide),
        fileCount: files.length,
        byteSize: rendered.buffer.length
    };
}

async function main() {
    const packageCheck = await verifyOfficePackage(); const clients = detectOfficeClients(); const result = { packageCheck, clients, manualChecklist: Object.fromEntries(Object.keys(clients).map(client => [client, ['打开导出的 PPTX', '检查中文文字/主题/图表/备注/转场', '编辑后另存并重新打开', '导出 PDF 检查版式']])) };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (!packageCheck.validZip || packageCheck.missing.length || !packageCheck.hasElementAnimation) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { detectOfficeClients, verifyOfficePackage };
