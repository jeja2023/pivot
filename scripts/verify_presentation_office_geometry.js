'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

async function compareOfficeGeometry(root) {
    const content = JSON.parse(await fs.readFile(path.join(root, 'presentation.json'), 'utf8'));
    const manifest = JSON.parse((await fs.readFile(path.join(root, 'office', 'office-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const pptx = await fs.readFile(path.join(root, 'Pivot-PPT-Studio.pptx'));
    const outputDigest = crypto.createHash('sha256').update(pptx).digest('hex');
    if (manifest.outputDigest !== outputDigest || manifest.slides !== content.slides.length) throw new Error('Office核验文件摘要或页数已失效，请针对当前PPTX重新渲染。');
    const native = JSON.parse((await fs.readFile(path.join(root, 'office', '原生对象核验.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const text = JSON.parse((await fs.readFile(path.join(root, 'office', '文字边界核验.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const comparisons = [];
    for (let index = 0; index < content.slides.length; index++) {
        const shapes = content.slides[index].elements.filter(element => element.type === 'shape' && /^shape_/.test(element.id));
        if (!shapes.length) continue;
        const preview = await sharp(path.join(root, `preview-${index + 1}.png`)).removeAlpha().raw().toBuffer();
        const office = await sharp(path.join(root, 'office', `slide-${index + 1}.png`)).removeAlpha().raw().toBuffer();
        const ink = (buffer, x, y) => { const offset = (y * content.width + x) * 3; return buffer[offset] < 245 || buffer[offset + 1] < 245 || buffer[offset + 2] < 245; };
        const near = (buffer, x, y) => {
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ink(buffer, x + dx, y + dy)) return true;
            return false;
        };
        for (const shape of shapes) {
            let intersection = 0, union = 0, previewCount = 0, officeCount = 0, previewMatched = 0, officeMatched = 0;
            for (let y = Math.ceil(shape.y); y < Math.floor(shape.y + shape.height); y++) for (let x = Math.ceil(shape.x); x < Math.floor(shape.x + shape.width); x++) {
                const a = ink(preview, x, y), b = ink(office, x, y);
                if (a && b) intersection++; if (a || b) union++;
                if (a) { previewCount++; if (near(office, x, y)) previewMatched++; }
                if (b) { officeCount++; if (near(preview, x, y)) officeMatched++; }
            }
            comparisons.push({ type: shape.shapeType, slide: index + 1, rawIoU: union ? intersection / union : 1,
                previewCoverage: previewCount ? previewMatched / previewCount : 1, officeCoverage: officeCount ? officeMatched / officeCount : 1 });
        }
    }
    const shapes = native.filter(item => item.name.startsWith('pivotAnim_shape_'));
    const connectors = native.filter(item => item.name.includes('__edge_') && !item.name.includes('__edge_label_'));
    const failures = [];
    if (new Set(comparisons.map(item => item.type)).size !== 187 || shapes.length !== 187) failures.push('187类形状未全部被PowerPoint识别并比较。');
    if (comparisons.some(item => item.previewCoverage < 0.98 || item.officeCoverage < 0.98)) failures.push('部分形状在1像素容差下的双向覆盖率低于98%。');
    if (connectors.some(item => !item.beginConnected || !item.endConnected)) failures.push('图示连接未附着到对应原生节点。');
    if (text.some(item => item.overflow)) failures.push('PowerPoint文字边界检查发现溢出。');
    const report = { checkedAt: new Date().toISOString(), outputDigest, engineVersion: manifest.engineVersion,
        status: failures.length ? 'failed' : 'passed', engine: 'Microsoft PowerPoint', nativeObjects: native.length, nativePresetShapes: shapes.length,
        connectedEdges: connectors.length, textOverflow: text.filter(item => item.overflow).length, tolerancePixels: 1,
        meanRawIoU: comparisons.reduce((sum, item) => sum + item.rawIoU, 0) / Math.max(1, comparisons.length),
        minimumCoverage: Math.min(...comparisons.map(item => Math.min(item.previewCoverage, item.officeCoverage))), failures, comparisons,
        scope: '固定技术样稿的几何/原生对象/文字边界对照；不代表设计美感、其他字体/调整值/Office平台或上游成稿盲评结果。' };
    await fs.writeFile(path.join(root, 'office-comparison.json'), JSON.stringify(report, null, 2));
    const summaryPath = path.join(root, 'report.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    summary.office = { status: report.status, engine: report.engine, engineVersion: report.engineVersion, outputDigest, contentDigest: summary.contentDigest,
        checkedAt: report.checkedAt, comparisonFile: 'office-comparison.json', nativeObjects: report.nativeObjects, nativePresetShapes: report.nativePresetShapes,
        connectedEdges: report.connectedEdges, textOverflow: report.textOverflow, minimumCoverage: report.minimumCoverage, scope: report.scope };
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    return report;
}
if (require.main === module) compareOfficeGeometry(path.resolve(process.argv[2] || 'artifacts/presentation-studio-acceptance')).then(report => {
    console.log(JSON.stringify({ status: report.status, nativeObjects: report.nativeObjects, presetShapes: report.nativePresetShapes, connectedEdges: report.connectedEdges,
        meanRawIoU: report.meanRawIoU, minimumCoverage: report.minimumCoverage, failures: report.failures }));
    if (report.status !== 'passed') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { compareOfficeGeometry };
