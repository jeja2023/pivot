'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { normalizeMaterials } = require('../server/services/presentations/presentation-evidence');
const { normalizePresentation, computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const { runRenderedPresentationQuality } = require('../server/services/presentations/presentation-render-quality');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');
const geometry = require('../server/services/presentations/presentation-geometry');

function text(id, value, x, y, width, height, size) { return { id, type: 'text', x, y, width, height, content: { text: value }, style: { fontSize: size, fontWeight: size >= 32 ? 700 : 400, color: '#17324D', lineHeight: 1.2 } }; }
async function buildSample() {
    const quote = '本期收入120万元，成本80万元。';
    const sources = normalizeMaterials([{ id: 'sample', title: '验收数据（非真实业务）', text: `本材料仅用于软件验收，非真实业务数据。${quote}季度收入为120、-20、200万元，净变化为-35、80、0万元。负责人统筹交付与财务，交付组管理执行组。规划、执行、复盘、改进构成闭环。` }]);
    const plan = { title: 'Pivot PPT 原生能力与事实核验样稿', productionProfile: { audience: '产品与技术验收', purpose: '检查跨格式一致性及原生编辑能力', consumptionMode: 'presentation', targetDurationSeconds: 600 }, slides: [
        { title: 'Pivot PPT 原生能力与事实核验', layout: 'cover', points: ['软件验收示例，非真实业务数据', '实际形状、关系、数值与最终文件回读'], intent: { stage: 'opening', purpose: '明确验收范围', durationSeconds: 30 } },
        { title: '多序列、负数和零值保持同一口径', layout: 'chart', sourceRefs: ['sample'], points: ['收入与净变化使用两条独立序列', '负数方向、零值和图例在预览与原生文件中一致'],
            chart: { type: 'bar', columns: ['季度', '收入', '净变化'], rows: [['Q1', 120, -35], ['Q2', -20, 80], ['Q3', 200, 0]] }, intent: { stage: 'evidence', relation: 'comparison', purpose: '核对全部序列与方向', durationSeconds: 60 } },
        { title: '层级关系使用真实父子连接', layout: 'process', sourceRefs: ['sample'], diagram: { type: 'hierarchy', graph: { nodes: [{ id: 'lead', label: '负责人' }, { id: 'delivery', label: '交付组' }, { id: 'finance', label: '财务组' }, { id: 'ops', label: '执行组' }], edges: [{ from: 'lead', to: 'delivery' }, { from: 'lead', to: 'finance' }, { from: 'delivery', to: 'ops' }] } }, intent: { stage: 'proposal', relation: 'hierarchy', purpose: '保留组织关系，节点可单独编辑', durationSeconds: 60 } },
        { title: '闭环使用首尾相连的原生连接线', layout: 'process', sourceRefs: ['sample'], diagram: { type: 'cycle', items: ['规划', '执行', '复盘', '改进'] }, intent: { stage: 'action', relation: 'sequence', purpose: '检查闭环和连接对象', durationSeconds: 45 } },
        { title: '差额计算保留原始输入与证据', layout: 'key-metrics', sourceRefs: ['sample'], metrics: [{ value: '120万元', label: '收入' }, { value: '80万元', label: '成本' }, { value: '40万元', label: '收入与成本差额' }],
            claims: [{ id: 'difference', type: 'calculation', text: '收入与成本差额为40万元', sourceRefs: ['sample'], evidence: [{ sourceId: 'sample', quote, locator: '验收材料第1段' }], calculation: { operation: 'difference', values: [120, 80], result: 40, unit: '万元' } }],
            intent: { stage: 'evidence', relation: 'composition', purpose: '独立复算并检查证据片段', durationSeconds: 45 } }
    ] };
    const content = (await compileDesignPlan(plan, getBuiltInTemplate('executive-clean'), sources)).presentation;
    const names = geometry.list();
    for (let index = 0; index < names.length; index += 16) {
        const elements = [text('title', `原生形状目录 ${Math.floor(index / 16) + 1} / ${Math.ceil(names.length / 16)}`, 88, 58, 1100, 64, 36)];
        names.slice(index, index + 16).forEach((name, offset) => {
            const x = 88 + offset % 4 * 278, y = 168 + Math.floor(offset / 4) * 124;
            elements.push({ id: 'shape_' + (index + offset), type: 'shape', shapeType: name, x: x + 55, y, width: 180, height: 72, style: { fill: '#E4EFFA', stroke: '#1769AA', strokeWidth: 1.5, radius: 12 } });
            elements.push(text('label_' + (index + offset), geometry.label(name), x, y + 84, 270, 32, 18));
        });
        content.slides.push({ id: 'gallery_' + index, layoutId: 'native-gallery', elements, speakerNotes: '本页为原生形状技术验收目录，标签属于阅读型注释。' });
    }
    return normalizePresentation(content);
}

async function main() {
    const index = process.argv.indexOf('--output'), output = path.resolve(index >= 0 ? process.argv[index + 1] : 'artifacts/presentation-studio-acceptance');
    await fs.mkdir(output, { recursive: true });
    const content = await buildSample(), started = performance.now();
    const pptx = await renderPresentation(content, 'pptx'), pdf = await renderPresentation(content, 'pdf');
    const native = await verifyPptxExport(pptx.buffer, content); assert.equal(native.status, 'passed', JSON.stringify(native.issues));
    const quality = await runRenderedPresentationQuality(content); assert.equal(quality.summary.blocking, 0, JSON.stringify(quality.issues.filter(issue => issue.level === 'blocking')));
    await fs.writeFile(path.join(output, 'Pivot-PPT-Studio.pptx'), pptx.buffer);
    await fs.writeFile(path.join(output, 'Pivot-PPT-Studio.pdf'), pdf.buffer);
    await fs.writeFile(path.join(output, 'presentation.json'), JSON.stringify(content, null, 2));
    const montage = [];
    for (let i = 0; i < content.slides.length; i++) {
        const png = (await renderPresentation(content, 'png', { slideIndex: i })).buffer;
        await fs.writeFile(path.join(output, `preview-${i + 1}.png`), png);
        montage.push({ input: await sharp(png).resize(480, 270).toBuffer(), left: i % 3 * 488, top: Math.floor(i / 3) * 278 });
    }
    await sharp({ create: { width: 1464, height: Math.ceil(content.slides.length / 3) * 278, channels: 3, background: '#DDE3EA' } }).composite(montage).png().toFile(path.join(output, 'montage.png'));
    const report = { checkedAt: new Date().toISOString(), rendererVersion: pptx.rendererVersion, contentDigest: computePresentationDigest(content),
        slides: content.slides.length, native, quality, durationMs: Math.round(performance.now() - started),
        upstreamComparison: { commit: '769547394107870a0c7b5ad8d1c0c75035123aef', status: 'not_run', reason: '尚未使用相同模型、输入、资源与预算执行上游生成和匿名成稿评审。' },
        office: { status: 'not_run', command: 'powershell -NoProfile -File scripts/verify_ppt_office.ps1 -PresentationPath <pptx> -OutputDirectory <office-output>' } };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, slides: report.slides, native: native.status, qualityBlocking: quality.summary.blocking, durationMs: report.durationMs, upstreamComparison: report.upstreamComparison.status }));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { buildSample };
