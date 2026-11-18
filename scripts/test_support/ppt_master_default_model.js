'use strict';

const pages = [
    { title: '经营概览', fact: '年度确认收入120.50万元' },
    { title: '成本核对', fact: '全年核定成本80.25万元' },
    { title: '执行安排', fact: '待复核事项12项' }
];
const materialPath = 'inputs/material-1.md';

function longMaterial() {
    const section = (label, number) => Array.from({ length: number }, (_, index) =>
        `${label}第${index + 1}条：本记录只说明收集、核对及移交过程。所有原始数据都应按正式确认口径逐项回读，避免把流程说明误当经营结果。`).join('\n');
    return ['## 核对后的经营资料', pages[0].fact, section('收入核对记录', 520), pages[1].fact,
        section('成本核对记录', 520), section('团队工作安排', 520), pages[2].fact].join('\n');
}

function lock() {
    return `<!-- ppt-master-schema: spec-lock/v1 -->
# 执行锁
## canvas
- viewBox: 0 0 1280 720
- format: PPT 16:9
## communication
- primary_language: zh-CN
- audience: 经营复核团队
- objective: 核对经营结果与下一步安排
- core_message: 分别呈现收入、成本和待复核事项
- consumption_mode: presentation
## mode
- mode: briefing
## visual_style
- visual_style: editorial
## colors
- bg: #FFFFFF
- primary: #17324D
- accent: #17614A
- text: #17324D
## typography
- font_family: Noto Sans CJK SC
- title_family: Noto Sans CJK SC
- body_family: Noto Sans CJK SC
- body: 32
- title: 44
## icons
- library: none
- inventory: none
## page_rhythm
- P01: anchor
- P02: anchor
- P03: anchor
## pptx_structure
- mode: flat
## forbidden
- \`mask\`, \`<style>\`, \`class\`, external CSS, \`<foreignObject>\`, \`textPath\`, \`@font-face\`, \`<animate*>\`, \`<set>\`, \`<script>\` / event attributes, \`<iframe>\`
- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters
`;
}

function spec() {
    const outline = pages.map((page, index) => `#### Slide 0${index + 1} - ${page.title}\n- **Audience move**: 核对当前指标\n- **Relationships**: none\n- **Title**: ${page.title}\n- **Core message**: ${page.fact}\n- **Content**: ${page.fact}\n`).join('\n');
    return `<!-- ppt-master-schema: design-spec/v1 -->
# 长材料验收 - Design Spec
## I. Project Information
| Item | Value |
| --- | --- |
| Page Count | 3 |
| Project Name | 长材料验收 |
| Speaker Notes | disabled |
| Custom Animations | disabled |
| Narration Audio | disabled |
## II. Canvas Specification
| Property | Value |
| --- | --- |
| Format | PPT 16:9 |
| Dimensions | 1280x720 |
| viewBox | 0 0 1280 720 |
## III. Visual Theme
白底深色文字，逐页单数据。
## IV. Typography System
Noto Sans CJK SC，标题44px，正文32px。
## V. Layout Principles
统一标题起点，正文与标题保留足够留白。
## VI. Icon Usage Specification
无。
## VIII. Image Resource List
上传图片仅用于准备阶段核对，本稿无嵌入图片。
## IX. Content Outline
### Part 1 - 经营结果
${outline}
## X. Speaker Notes Requirements
无。
`;
}

function slide(page) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" lang="zh-CN" data-pptx-page-role="content"><rect id="background" x="0" y="0" width="1280" height="720" fill="#FFFFFF"/><g id="heading" data-pptx-bounds="88 60 1104 110"><text x="88" y="128" font-family="Noto Sans CJK SC" font-size="44" fill="#17324D">${page.title}</text></g><g id="evidence" data-pptx-bounds="88 220 1104 300"><text x="128" y="310" font-family="Noto Sans CJK SC" font-size="32" fill="#17324D">${page.fact}</text></g></svg>`;
}

function turn(request, messages, assistant) {
    const system = String(messages.find(item => item.role === 'system')?.content || '');
    const observations = messages.filter(item => item.role === 'user').flatMap(item => {
        try { const value = JSON.parse(item.content); return Array.isArray(value) ? value : []; } catch (_) { return []; }
    });
    const approved = stage => assistant.some(item => item.requestInput?.stage === stage);
    const plan = (stage, question, content) => ({ requestInput: { kind: 'confirmation', stage, question, plan: content } });
    const didRun = tool => assistant.some(item => item.actions?.some(action => action.tool === tool));
    if (!approved('direction')) {
        if (!system.includes('上一回复未执行任何制作动作')) return { actions: [
            { action: 'write', path: 'forbidden-early-batch.md', text: '此文件不应执行写入。' },
            { action: 'run', tool: 'export', args: ['premature'] }
        ] };
        return plan('direction', '是否同意按经营结果和执行安排组织汇报？', { summary: '从实际经营材料提取三项确认口径，供复核团队逐项核对。' });
    }
    if (!didRun('project')) return { actions: [{ action: 'run', tool: 'project', args: ['init', 'master_default_e2e', '--dir', '.'] }, { action: 'list' }] };
    const project = observations.flatMap(item => item.result?.files || []).find(item => item.path.includes('/validation/workflow.log'))?.path.split('/')[0];
    if (!project) return { actions: [{ action: 'list' }] };
    const pendingImage = /下一未读 offset=(\d+)/.exec(system);
    if (pendingImage) return { actions: [{ action: 'read_images', offset: Number(pendingImage[1]) }] };
    const latest = observations.filter(item => item.action === 'read' && item.result?.path === materialPath).at(-1)?.result;
    if (!latest || latest.nextOffset != null) return { actions: [{ action: 'read', path: materialPath, offset: latest?.nextOffset || 0, length: 12000 }] };
    const images = request.sources.filter(item => /\.(?:png|jpe?g|webp)$/i.test(item.path));
    if (images.length && !didRun('analyze_images')) return { actions: [
        ...images.map(item => ({ action: 'copy', source: item.path, path: project + '/images/' + item.path.split('/').at(-1) })),
        { action: 'run', tool: 'analyze_images', args: [project + '/images'] }
    ] };
    const authored = assistant.some(item => item.actions?.some(action => action.path === project + '/spec_lock.md'));
    if (!authored) return { actions: [
        { action: 'write', path: project + '/design_spec.md', text: spec() },
        { action: 'write', path: project + '/spec_lock.md', text: lock() },
        { action: 'run', tool: 'project', args: ['validate', project] }
    ] };
    if (!approved('design')) return plan('design', '是否批准三页的标题、页序及关键数字？', {
        summary: '使用白底深色文字，标题和正文左对齐。每页单独核对一项事实。',
        project, pages: pages.map(page => ({ title: page.title, values: [{ text: page.fact, source: { path: materialPath, quote: page.fact } }] }))
    });
    if (!didRun('export')) return { actions: [
        ...pages.map((page, index) => ({ action: 'write', path: project + `/svg_output/slide_0${index + 1}.svg`, text: slide(page) })),
        { action: 'run', tool: 'check_svg', args: [project, '--canonical-authoring', '--stage', 'final', '--json'] },
        { action: 'run', tool: 'finalize', args: [project] },
        { action: 'run', tool: 'export', args: [project, '--no-notes', '-o', project + '/exports/final.pptx'] }
    ] };
    return { complete: { path: project + '/exports/final.pptx' } };
}

module.exports = { pages, longMaterial, lock, spec, slide, turn };
