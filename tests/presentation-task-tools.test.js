'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Zip = require('jszip');
const { queryOne, execute } = require('../server/db/client');
const { getBuiltInToolDefinitions, executeBuiltInTool } = require('../server/services/agent-tools');
const { rankTools } = require('../server/services/tool-discovery');
const { buildTaskPresentation } = require('../server/services/presentations/presentation-task-content');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { getPresentation } = require('../server/services/presentations/presentation-service');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');
const { readBuffer } = require('../server/services/agent-artifact-cas');
const { getRenditionForUser } = require('../server/services/agent-artifact-renditions');
const { getChatTaskFeed } = require('../server/services/chat-task-feed');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
const { taskDisplayTitle, requestedPresentationFormats } = require('../server/services/task-display-title');
const { normalizeAgentTitle } = require('../server/services/agent-validators');
const { executeToolDiscoveryMeta } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');

const input = { title: '文档生成的经营汇报', slides: [
    { title: '经营汇报', layout: 'cover', points: ['依据用户上传的演讲稿', '汇报期间：2026 年第三季度'] },
    { title: '汇报目录', points: ['经营结果', '主要风险与改进安排', '下一步行动'] },
    { title: '经营结果与主要风险', layout: 'two-column', left: ['收入增长至120万元', '成本控制在80万元'], right: ['交付周期延长', '应收账款回收偏慢'] },
    { title: '季度经营数据', layout: 'table', table: { columns: ['指标', '金额（万元）'], rows: [['收入', '120'], ['成本', '80']] } },
    { title: '收入与成本', layout: 'chart', chart: { type: 'bar', columns: ['指标', '万元'], rows: [['收入', 120], ['成本', 80]] } },
    { title: '下一步行动', layout: 'summary', points: ['建立每周交付跟踪机制', '按账龄推进应收款回收'], speakerNotes: '重点说明责任人和完成期限。' }
] };

test('PPTX 与 SVG 有可发现的独立工具，普通文档图片转换不会冒充完整 PPT', () => {
    const tools = getBuiltInToolDefinitions();
    for (const name of ['presentation.create', 'presentation.from_analysis', 'presentation.export', 'diagram.render_svg']) assert.ok(tools.some(tool => tool.name === name), name);
    for (const name of ['presentation.create', 'presentation.from_analysis', 'presentation.export', 'diagram.render_svg']) {
        const contract = require('../server/services/agent-contracts').normalizeToolContract(tools.find(tool => tool.name === name));
        assert.equal(contract.side_effect, true); assert.equal(contract.concurrency, 'write');
        const visible = require('../server/services/agent-tool-discovery-scope').filterRunToolCatalog([contract], { metadata: { chatBridge: { mcpEnabled: false } } });
        assert.equal(visible.length, 1, name);
    }
    assert.equal(rankTools('根据文档生成完整PPTX演示文稿', tools)[0].tool.name, 'presentation.create');
    const image = tools.find(tool => tool.name === 'artifact.render');
    assert.match(image.description, /不能把段落和标题直接变成图片/);
    assert.match(image.description, /presentation.create/);
});

test('任务标题保留业务与附件名称，移除上传地址、操作系统路径及附件正文', () => {
    const title = '根据上传文档，生成PPT [附件: 演讲稿.docx](/uploads/2/468ae23e-df39-40d3-bd9c-55f5ae84d80/file.docx)';
    assert.equal(taskDisplayTitle(title), '根据上传文档，生成PPT 附件: 演讲稿.docx');
    assert.doesNotMatch(normalizeAgentTitle(title, title), /uploads|468ae23e/);
    assert.doesNotMatch(taskDisplayTitle(title + '\n---\n【参考文档: 稿件】\n内部全文'), /内部全文/);
    assert.equal(taskDisplayTitle('分析文件 C:\\private\\file.docx'), '分析文件');
    assert.deepEqual(requestedPresentationFormats(title), ['pptx']);
    assert.deepEqual(requestedPresentationFormats('不要PPT，只要SVG图形'), []);
    assert.deepEqual(requestedPresentationFormats('分析已有PPT中的内容并给出总结'), []);
    assert.deepEqual(requestedPresentationFormats('根据PPT生成PDF文件'), []);
    assert.deepEqual(requestedPresentationFormats('生成PPT页面，只要SVG格式'), []);
});

test('页面内容不截断，非法数据与过密页面明确要求修正', () => {
    assert.equal(buildTaskPresentation(input, getBuiltInTemplate('business-blue')).slides.length, 6);
    assert.throws(() => buildTaskPresentation({ title: '完整内容', slides: [{ title: '内容', layout: 'content', points: Array(8).fill('过长要点'.repeat(60)) }] }, getBuiltInTemplate('business-blue')), /拆成更多页|放不下/);
    assert.throws(() => buildTaskPresentation({ title: '数据', slides: [{ title: '表格', layout: 'table', table: { columns: ['一列'], rows: [['1', '2']] } }] }, getBuiltInTemplate('business-blue')), /列数一致/);
});

test('真实任务从材料生成全部可编辑 PPTX 页面、复用导出、单页 SVG 并挂载结果', { timeout: 120000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const sessionId = crypto.randomUUID(), runId = 'ppt-task-' + crypto.randomUUID();
    await execute("INSERT INTO sessions(id,user_id,title) VALUES (?,?,'PPT任务测试')", [sessionId, user.id]);
    const message = await queryOne("INSERT INTO messages(session_id,user_id,role,content) VALUES (?,?,'user',?) RETURNING id", [sessionId, user.id,
        '根据上传文档生成完整PPT\n---\n【参考文档: 演讲稿.docx】\n第三季度收入120万元，成本80万元。风险为交付周期延长和应收账款回收偏慢。下一步建立交付跟踪并按账龄回收。']);
    const metadata = { chatBridge: { version: 1, sessionId, userMessageId: Number(message.id) }, automaticExecution: { version: 1 }, capabilityConstraints: { present: true, capabilities: ['document.render', 'conversation.read_source', 'viz.render'] } };
    await execute("INSERT INTO agent_runs(id,user_id,session_id,title,goal,status,metadata) VALUES (?,?,?,?,'根据文档生成PPT','running',?)", [runId, user.id, sessionId,
        '根据文档生成PPT [附件: 演讲稿.docx](/uploads/2/private/file.docx)', JSON.stringify(metadata)]);
    const run = { id: runId, user_id: user.id, session_id: sessionId, metadata };
    const context = { run, stepId: 'ppt-create-step', toolDiscoveryState: createToolDiscoveryState() };
    const search = await executeToolDiscoveryMeta('tools.search', { query: '根据文档生成完整PPTX演示文稿' }, user, context);
    const reference = search.value.candidates.find(candidate => candidate.toolRef.toolName === 'presentation.create')?.toolRef;
    assert.ok(reference, JSON.stringify(search.value));
    const description = await executeToolDiscoveryMeta('tools.describe', { toolRef: reference }, user, context);
    const execution = await executeToolDiscoveryMeta('tools.execute', { toolRef: description.value.toolRef, input }, user, context);
    const created = execution.value;
    assert.equal(created.status, 'completed', JSON.stringify(created.validation));
    assert.equal(created.format, 'pptx'); assert.equal(created.slideCount, 6);
    const presentation = await getPresentation(user, created.presentationId);
    assert.equal(presentation.template.id, 'executive-clean');
    const design = await executeBuiltInTool('presentation.design_info', {}, user, context);
    assert.equal(design.skill.manifest.id, 'presentation-design-zh');
    assert.ok(design.templates.some(template => template.id === 'learning-studio' && template.layouts.length === 18));
    assert.equal(presentation.content.sources[0].locator, `message:${message.id}`);
    const repeated = await executeBuiltInTool('presentation.create', input, user, { ...context, stepId: 'ppt-retry-step' });
    assert.equal(repeated.presentationId, created.presentationId); assert.equal(repeated.renditionId, created.renditionId);
    const rendition = await getRenditionForUser(created.renditionId, user);
    assert.equal(rendition.run_id, runId);
    const { buffer: bytes } = await readBuffer({ ref: rendition.storage_ref, userId: user.id, tenantId: rendition.tenant_id });
    const zip = await Zip.loadAsync(bytes);
    const pages = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(pages.length, 6);
    const texts = await Promise.all(pages.map(name => zip.file(name).async('string')));
    assert.match(texts.join('\n'), /收入增长至120万元/); assert.match(texts.join('\n'), /按账龄推进应收款回收/);
    assert.ok(zip.file('ppt/charts/chart1.xml'));
    const svg = await executeBuiltInTool('presentation.export', { presentationId: created.presentationId, format: 'svg', slideIndex: 2 }, user, { run, stepId: 'svg-export' });
    assert.equal(svg.format, 'svg'); assert.equal(svg.slideIndex, 2);
    const svgRendition = await getRenditionForUser(svg.renditionId, user);
    const { buffer: svgBytes } = await readBuffer({ ref: svgRendition.storage_ref, userId: user.id, tenantId: svgRendition.tenant_id });
    assert.match(svgBytes.toString(), /<svg/); assert.match(svgBytes.toString(), /收入增长至120万元/);
    await assert.rejects(() => executeBuiltInTool('presentation.export', { presentationId: created.presentationId, format: 'svg', slideIndex: 50 }, user, { run }), /页码不存在/);
    const feed = await getChatTaskFeed(runId, user);
    assert.ok(feed.artifacts.some(artifact => artifact.rendition?.format === 'pptx' && artifact.rendition.ready));
    assert.ok(feed.artifacts.some(artifact => artifact.rendition?.format === 'svg' && artifact.rendition.ready));
    assert.doesNotMatch(feed.run.title, /uploads|private/);
    const originalTexts = presentation.content.slides[2].elements.filter(element => element.type === 'text' && !element.locked).map(element => element.content.text).sort();
    const changed = await executeBuiltInTool('presentation.relayout', { presentationId: created.presentationId, slideIndex: 2, layoutId: 'design-comparison' }, user, context);
    const reloaded = await getPresentation(user, created.presentationId);
    assert.ok(changed.version > presentation.version);
    assert.deepEqual(reloaded.content.slides[2].elements.filter(element => element.type === 'text' && !element.locked).map(element => element.content.text).sort(), originalTexts);
    const review = await executeBuiltInTool('presentation.review', { presentationId: created.presentationId, slideIndex: 2, modelId: 'not-accessible' }, user, context);
    assert.equal(review.status, 'unavailable');
    await require('../server/services/presentations/presentation-service').reviewPresentationSlide(user, created.presentationId, reloaded.content.slides[2].id, true);
    await assert.rejects(() => executeBuiltInTool('presentation.relayout', { presentationId: created.presentationId, slideIndex: 2, layoutId: 'design-two-column' }, user, context), /已批准/);
    const other = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING *", ['ppt-other-' + crypto.randomBytes(5).toString('hex')]);
    await assert.rejects(() => executeBuiltInTool('presentation.export', { presentationId: created.presentationId }, other, { run }), /无权导出/);
    await assert.rejects(() => executeBuiltInTool('presentation.review', { presentationId: created.presentationId, slideIndex: 0 }, other, { run }), /无权访问/);
    await execute('UPDATE messages SET deleted_at=NOW() WHERE id=?', [message.id]);
    await assert.rejects(() => executeBuiltInTool('presentation.create', input, user, context), /不可访问/);
    await fs.mkdir(path.resolve('output/ppt-task'), { recursive: true });
    await fs.writeFile(path.resolve('output/ppt-task/经营汇报.pptx'), bytes);
    for (const index of [0, 1, 2, 3, 4, 5]) {
        const image = await renderPresentation(presentation.content, 'png', { slideIndex: index });
        await fs.writeFile(path.resolve(`output/ppt-task/slide-${index + 1}.png`), image.buffer);
    }
});

test('原始 SVG 源码可直接登记图片结果，不要求用户自己创建受控图片引用', { timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const runId = 'svg-task-' + crypto.randomUUID();
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status) VALUES (?,?,'SVG测试','生成SVG','running')", [runId, user.id]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#ffffff"/><text x="40" y="100">示例页面</text></svg>';
    const result = await executeBuiltInTool('diagram.render_svg', { title: '示例页面', svg }, user, { run: { id: runId }, stepId: 'svg-source' });
    assert.equal(result.format, 'svg'); assert.ok(result.renditionId);
    await assert.rejects(() => executeBuiltInTool('diagram.render_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, user, { run: { id: runId }, stepId: 'bad-svg' }), /不允许/);
});

test('要求完整 PPTX 的验收不能被单页 SVG 或文本大纲替代', async () => {
    const result = await verifyAutomaticTask({ run: { id: 'run', goal: '生成完整PPT' }, user: { id: 1 }, contract: {
        goal: '生成完整PPT', acceptance: { artifactRequired: true, requiredFormats: ['pptx'] } }, answer: 'SVG已完成' }, {
        readyRunArtifacts: async () => [{ id: 1, format: 'svg' }], getModel: async () => { throw new Error('格式缺失时不应靠模型放行'); }
    });
    assert.equal(result.passed, false); assert.equal(result.reason, 'artifact_format_missing');
});
