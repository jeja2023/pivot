'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Zip = require('jszip');
const sharp = require('sharp');
const { canonicalJson } = require('../server/services/canonical-json');
const { fixture } = require('./test_support/ppt_native_fixture');

async function main() {
    const tag = process.argv[2] || 'ppt-master:6.8.0';
    const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8', windowsHide: true }))[0];
    const image = inspected.Id;
    const output = path.resolve('artifacts/ppt-native-acceptance', new Date().toISOString().replace(/[:.]/g, '-')); await fs.mkdir(output, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = { version: 1, images: [{ image, commands: ['python,/runner/runner.py'] }] }, signer = crypto.createSign('RSA-SHA256'); signer.update(canonicalJson(manifest)); signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64'); manifest.signatureAlgorithm = 'RSA-SHA256';
    const trust = path.join(output, 'worker-trust.json'); await fs.writeFile(trust, JSON.stringify(manifest, null, 2));
    const key = publicKey.export({ type: 'spki', format: 'pem' }).toString(); await fs.writeFile(path.join(output, 'public-key.pem'), key);
    Object.assign(process.env, { DATA_DIR: path.join(output, 'data'), NODE_ENV: 'production', PIVOT_PPT_MASTER_ENABLED: 'true', PIVOT_PPT_MASTER_IMAGE: image, PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: trust, PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: key });
    const runtime = require('../server/services/presentations/master/runtime'), user = { id: 1 }, task = 'tooltask_' + crypto.randomBytes(24).toString('base64url');
    const original = await fixture(); await fs.writeFile(path.join(output, 'source.pptx'), original); await runtime.inputFile(user, task, 'source.pptx', original);
    const run = async action => { const result = await runtime.execute(user, task, action); console.log(JSON.stringify({ action: action.action, status: result.status, slideCount: result.slideCount })); return result; };
    await run({ action: 'native_inspect' });
    const initial = JSON.parse((await runtime.readOutput(user, task, 'manifest.json')).toString('utf8')); await fs.writeFile(path.join(output, 'initial-manifest.json'), JSON.stringify(initial, null, 2));
    const shape = name => initial.slides.flatMap(slide => slide.objects.map(object => ({ ...object, slideIndex: slide.index }))).find(object => object.name === name);
    const rich = shape('验收富文本'), gradient = shape('验收渐变'), custom = shape('验收自由路径'), formula = shape('验收公式'), table = shape('验收表格'), chart = shape('验收图表');
    for (const object of [rich, gradient, custom, formula, table, chart]) assert.ok(object, '验收对象必须存在');
    assert.equal(gradient.fill.type, 'gradient'); assert.equal(custom.geometry.type, 'custom'); assert.equal(formula.formulas[0].editable, true); assert.equal(chart.chart.editable, true);
    const paths = JSON.parse(JSON.stringify(custom.geometry.paths)); paths[0].commands[1].points[0].x = '650';
    const patches = [
        { slideIndex: rich.slideIndex, objectId: rich.id, runs: [{ paragraph: 0, run: 0, text: '离线修改', bold: true }] },
        { slideIndex: gradient.slideIndex, objectId: gradient.id, fill: { type: 'gradient', angle: 45, stops: [{ position: 0, color: '#17324D' }, { position: 1, color: '#00AA88' }] }, frame: { x: gradient.frame.x + 10 } },
        { slideIndex: custom.slideIndex, objectId: custom.id, geometry: { paths } },
        { slideIndex: formula.slideIndex, objectId: formula.id, formulas: [{ index: 0, latex: '\\frac{x+1}{y}' }] },
        { slideIndex: table.slideIndex, objectId: table.id, cells: [{ row: 1, column: 1, text: '121' }] },
        { slideIndex: chart.slideIndex, objectId: chart.id, chart: { categories: ['第一季', '第二季'], series: [{ name: '营收', values: [121, 0] }, { name: '成本', values: [80, -5] }] } }
    ];
    const receipt = await run({ action: 'native_patch', patches });
    const edited = await runtime.readOutput(user, task, 'presentation.pptx'); await fs.writeFile(path.join(output, 'edited.pptx'), edited);
    for (let index = 0; index < initial.slides.length; index++) await fs.writeFile(path.join(output, `edited-preview-${index + 1}.png`), await runtime.readOutput(user, task, `preview-${index + 1}.png`));
    const preview = await runtime.readOutput(user, task, 'preview-' + (formula.slideIndex + 1) + '.png'), dimensions = await sharp(preview).metadata();
    const scale = dimensions.width / initial.width, box = formula.frame;
    const formulaStats = await sharp(preview).extract({ left: Math.max(0, Math.floor(box.x * scale)), top: Math.max(0, Math.floor(box.y * scale)), width: Math.max(1, Math.floor(box.width * scale)), height: Math.max(1, Math.floor(box.height * scale)) }).stats();
    assert.ok(formulaStats.channels.slice(0, 3).some(channel => channel.stdev > 1), '固定白底公式区域必须渲染出实际字形，不能仅有有效OOXML而预览为空');
    const formulaPixels = await sharp(preview).extract({ left: Math.floor(box.x * scale), top: Math.floor(box.y * scale), width: Math.floor(box.width * scale), height: Math.floor(box.height * scale) }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const inkColumns = [];
    for (let x = 0; x < formulaPixels.info.width; x++) for (let y = 0; y < formulaPixels.info.height; y++) if (formulaPixels.data[y * formulaPixels.info.width + x] < 100) { inkColumns.push(x); break; }
    assert.ok(inkColumns.length && Math.max(...inkColumns) - Math.min(...inkColumns) < formulaPixels.info.width * 0.7, '固定公式不得被拉伸填满整段文本框');
    const editedZip = await Zip.loadAsync(edited), originalZip = await Zip.loadAsync(original);
    assert.equal(await editedZip.file('ppt/slides/slide3.xml').async('string'), await originalZip.file('ppt/slides/slide3.xml').async('string'));
    const first = await editedZip.file('ppt/slides/slide1.xml').async('string'); assert.match(first, /离线修改/); assert.match(first, /m:oMath/); assert.match(first, /2700000/);
    const chartXml = await editedZip.file(chart.chart.part).async('string'); assert.match(chartXml, /121/); assert.match(chartXml, /<c:v>0<\/c:v>/);
    const workbookName = receipt.preservation.changedParts.find(name => name.startsWith('ppt/embeddings/') && name.endsWith('.xlsx'));
    assert.ok(workbookName, '图表数据编辑必须同时更新嵌入工作簿');
    const workbook = await Zip.loadAsync(await editedZip.file(workbookName).async('nodebuffer')), worksheet = await workbook.file('xl/worksheets/sheet1.xml').async('string');
    for (const [cell, value] of [['B2', '121'], ['B3', '0'], ['C3', '-5']]) assert.match(worksheet, new RegExp(`<c[^>]*r="${cell}"[^>]*>[\\s\\S]*?<v>${value}</v>[\\s\\S]*?</c>`), '嵌入工作簿数值必须保留正数、零值和负数');
    const again = 'tooltask_' + crypto.randomBytes(24).toString('base64url'); await runtime.inputFile(user, again, 'source.pptx', edited);
    await runtime.execute(user, again, { action: 'native_inspect' });
    const reimported = JSON.parse((await runtime.readOutput(user, again, 'manifest.json')).toString('utf8'));
    assert.equal(reimported.slides[0].objects.find(object => object.id === rich.id).runs[0].text, '离线修改');
    assert.ok(reimported.slides[0].objects.find(object => object.id === formula.id).formulas[0].latex.includes('x'));
    await fs.writeFile(path.join(output, 'reimported-manifest.json'), JSON.stringify(reimported, null, 2));
    await assert.rejects(() => run({ action: 'native_patch', patches: [{ slideIndex: 0, objectId: rich.id, frame: { x: NaN } }] }), /数值|JSON|范围/);
    const prepared = await run({ action: 'native_video_prepare' }), clips = [];
    for (let page = 0; page < prepared.slideCount; page++) clips.push(await run({ action: 'native_video_clip', slideIndex: page, options: { duration: 1, transition: 'fade', resolution: '720p', fps: 24 } }));
    const video = await run({ action: 'native_video_finish', clips });
    await fs.writeFile(path.join(output, 'video.mp4'), await runtime.readOutput(user, task, 'video.mp4', 120 * 1024 * 1024));
    await fs.writeFile(path.join(output, 'video-first.png'), await runtime.readOutput(user, task, 'video-first.png'));
    const report = { checkedAt: new Date().toISOString(), image, output, packageEditing: 'passed', textRuns: 'passed', gradient: 'passed', freeform: 'passed', formula: 'passed', formulaPreview: 'passed', nativeTable: 'passed', nativeChartAndWorkbook: 'passed', reimport: 'passed', untouchedSlideBytes: 'passed', changedParts: receipt.preservation.changedParts, video, network: 'disabled' };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, status: 'passed', image }));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
