'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const sample = require('../tests/fixtures/presentation-design-acceptance.json');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { buildTaskPresentation } = require('../server/services/presentations/presentation-task-content');
const { applyTemplateLayoutLayers } = require('../server/services/presentations/presentation-template-reflow');
const { normalizePresentation } = require('../server/services/presentations/presentation-schema');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { verifyPptxExport } = require('../server/services/presentations/presentation-export-verification');

async function main() {
    const root = path.resolve('output/ppt-upgrade-acceptance');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '同材料原文.txt'), sample.source, 'utf8');
    const source = { id: 'sample_source', title: '同材料设计验收示例', type: 'material', locator: '验收材料', digest: 'design-acceptance-v1', excerpt: sample.source };
    const documents = new Map();
    for (const id of ['business-blue', 'learning-studio', 'executive-clean', 'institutional-report']) {
        const template = getBuiltInTemplate(id);
        let content;
        if (id === 'business-blue') {
            const slides = sample.slides.map(slide => ({ ...slide, layout: ['agenda', 'process'].includes(slide.layout) ? 'content' : ['executive-summary', 'comparison'].includes(slide.layout) ? 'two-column' : slide.layout }));
            content = applyTemplateLayoutLayers(buildTaskPresentation({ ...sample, slides }, template, [source]), template, { reflow: true, normalizePresentation });
        } else content = (await compileDesignPlan(sample, template, [source])).presentation;
        assert.equal(content.slides.length, 8);
        const text = JSON.stringify(content).replace(/\s/gu, '');
        for (const fact of sample.facts) assert.ok(text.includes(fact), `验收事实缺失：${fact}`);
        const directory = path.join(root, id); await fs.mkdir(directory, { recursive: true });
        const pptx = await renderPresentation(content, 'pptx');
        const checked = await verifyPptxExport(pptx.buffer, content);
        assert.equal(checked.status, 'passed', JSON.stringify(checked.issues));
        await fs.writeFile(path.join(directory, '八页样稿.pptx'), pptx.buffer);
        await fs.writeFile(path.join(directory, '源稿.json'), JSON.stringify(content, null, 2));
        const pages = [];
        for (let index = 0; index < content.slides.length; index++) {
            const output = await renderPresentation(content, 'png', { slideIndex: index });
            await fs.writeFile(path.join(directory, `slide-${index + 1}.png`), output.buffer);
            pages.push(output.buffer);
        }
        documents.set(id, { pages, checked });
    }
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const styles = '<style>body{margin:18px;background:#eef1f4;color:#263642;font-family:Microsoft YaHei,sans-serif}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}figcaption{padding:6px;font-size:13px}img{width:100%;display:block}h1{font-size:20px}p{font-size:13px}</style>';
        let html = styles + '<h1>同一份材料：原商务蓝与新培训讲解</h1><p>均为八页原生可编辑样稿；金额与安排为验收示例。</p><main>';
        for (let index = 0; index < 8; index++) for (const id of ['business-blue', 'learning-studio']) html += `<figure><figcaption>${id === 'business-blue' ? '原版' : '新版'} · 第${index + 1}页</figcaption><img alt="第${index + 1}页" src="data:image/png;base64,${documents.get(id).pages[index].toString('base64')}"></figure>`;
        html += '</main>';
        await fs.writeFile(path.join(root, '新旧成稿对照.html'), html, 'utf8');
        await page.setContent(html); await page.screenshot({ path: path.join(root, '新旧成稿对照.png'), fullPage: true });
    } finally { await browser.close(); }
    await fs.writeFile(path.join(root, '验收结果.json'), JSON.stringify(Object.fromEntries([...documents].map(([id, value]) => [id, value.checked])), null, 2));
    console.log('四套八页样稿、原生PPTX内容核验与同材料新旧对照已生成。');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
