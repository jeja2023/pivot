'use strict';

const Zip = require('jszip');
const { diagramScene } = require('../../../client/chat/presentation-graphics');
const { NS, parse, all, children, text, compact, relationships, objectRecords } = require('./presentation-pptx-xml');
const { inspectNativeChart } = require('./presentation-pptx-charts');

const objectName = element => `pivotAnim_${element.id}`;
function equalText(node, value) { return compact(text(node)) === compact(value); }

function inspectDiagram(document, byName, element, add) {
    const prefix = objectName(element), scene = diagramScene(element), group = byName.get(prefix);
    if (!group || group.kind !== 'grpSp') add('EXPORT_DIAGRAM_GROUP_MISSING', element, '图示缺少可编辑的原生组合。');
    for (const node of scene.nodes) {
        const shape = byName.get(`${prefix}__node_${node.id}`), label = byName.get(`${prefix}__node_label_${node.id}`);
        if (!shape || !label || !equalText(label.node, node.label)) add('EXPORT_TEXT_MISSING', element, `图示节点“${node.label}”缺失或文字不一致。`);
    }
    for (const edge of scene.edges) {
        const connector = byName.get(`${prefix}__edge_${edge.id}`), from = byName.get(`${prefix}__node_${edge.from}`), to = byName.get(`${prefix}__node_${edge.to}`);
        const start = connector && all(connector.node, NS.a, 'stCxn')[0], end = connector && all(connector.node, NS.a, 'endCxn')[0];
        if (!connector || connector.kind !== 'cxnSp' || !from || !to || start?.getAttribute('id') !== from.id || end?.getAttribute('id') !== to.id) add('EXPORT_DIAGRAM_EDGE_MISMATCH', element, '图示连接缺失或未连接到正确的原生节点。');
        if (edge.label && !equalText(byName.get(`${prefix}__edge_label_${edge.id}`)?.node || document.createElement('missing'), edge.label)) add('EXPORT_TEXT_MISSING', element, '图示连接文字缺失。');
    }
}

function inspectTable(record, element, add) {
    const table = record && all(record.node, NS.a, 'tbl')[0];
    if (!table) { add('EXPORT_NATIVE_TABLE_MISSING', element, 'PPTX 缺少对应原生表格。'); return; }
    const actual = children(table, NS.a, 'tr').map(row => children(row, NS.a, 'tc').map(cell => compact(text(cell))));
    const expected = [element.columns, ...element.rows].map(row => row.map(compact));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) add('EXPORT_TEXT_MISSING', element, '原生表格的行列或单元格内容与源稿不一致。');
}

async function inspectPicture(zip, record, rels, element, add) {
    const blip = record && all(record.node, NS.a, 'blip')[0];
    const rel = rels.get(blip?.getAttributeNS(NS.r, 'embed'));
    if (!record || record.kind !== 'pic' || !rel || rel.external || !zip.file(rel.target)) add('EXPORT_IMAGE_MISSING', element, 'PPTX 图片对象或受控图片资源缺失。');
}

async function verifyPptxExport(buffer, presentation, options = {}) {
    const issues = [], workbookCache = new Map();
    const counts = { textElements: 0, tables: 0, charts: 0, diagrams: 0, images: 0, shapes: 0, media: 0 };
    let slideCount = 0;
    try {
        const zip = await Zip.loadAsync(buffer);
        const files = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
        slideCount = files.length;
        if (files.length !== presentation.slides.length) issues.push({ code: 'EXPORT_PAGE_COUNT', message: 'PPTX 页面数量与源稿不一致。' });
        for (let index = 0; index < presentation.slides.length; index++) {
            options.signal?.throwIfAborted();
            const slide = presentation.slides[index], file = files[index];
            const add = (code, element, message) => issues.push({ code, slideId: slide.id, ...(element ? { elementId: element.id } : {}), message });
            if (!file) continue;
            const document = parse(await zip.file(file).async('string')), records = objectRecords(document), byName = new Map();
            const ids = new Set(), rels = await relationships(zip, file);
            for (const record of records) {
                if (byName.has(record.name) || ids.has(record.id)) add('EXPORT_OBJECT_ID_DUPLICATE', null, 'PPTX 页面存在重复的对象名称或标识。');
                byName.set(record.name, record); ids.add(record.id);
            }
            for (const element of slide.elements.filter(element => element.visible)) {
                const record = byName.get(objectName(element));
                if (element.type === 'text') {
                    counts.textElements++;
                    if (!record || record.kind !== 'sp' || !equalText(record.node, element.content.text)) add('EXPORT_TEXT_MISSING', element, '对应文字对象缺失或内容与源稿不一致。');
                } else if (element.type === 'table') { counts.tables++; inspectTable(record, element, add); }
                else if (element.type === 'chart') {
                    counts.charts++;
                    const chartIssues = await inspectNativeChart(zip, file, record, element, workbookCache);
                    chartIssues.forEach(issue => issues.push({ ...issue, slideId: slide.id }));
                } else if (element.type === 'diagram') { counts.diagrams++; inspectDiagram(document, byName, element, add); }
                else if (element.type === 'image') { counts.images++; await inspectPicture(zip, record, rels, element, add); }
                else if (element.type === 'shape') {
                    counts.shapes++;
                    const geometry = record && all(record.node, NS.a, 'prstGeom')[0];
                    if (!record || record.kind !== 'sp' || geometry?.getAttribute('prst') !== element.shapeType) add('EXPORT_NATIVE_SHAPE_MISSING', element, '对应原生形状缺失或类型发生变化。');
                } else if (element.type === 'media') {
                    counts.media++;
                    const mediaRefs = record ? [...all(record.node, NS.a, 'videoFile'), ...all(record.node, NS.a, 'audioFile')] : [];
                    if (!record || !mediaRefs.some(node => {
                        const rel = rels.get(node.getAttributeNS(NS.r, 'link'));
                        return rel && !rel.external && zip.file(rel.target);
                    })) add('EXPORT_MEDIA_MISSING', element, '对应原生音视频对象或资源缺失。');
                }
            }
            if (options.includeNotes !== false && slide.speakerNotes) {
                const relation = [...rels.values()].find(item => /\/notesSlide$/.test(item.type) && !item.external), notes = relation && zip.file(relation.target);
                if (!notes || !compact(text(parse(await notes.async('string')))).includes(compact(slide.speakerNotes))) add('EXPORT_NOTES_MISSING', null, '当前页的演讲者备注缺失或不完整。');
            }
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        issues.push({ code: 'EXPORT_PACKAGE_INVALID', message: `PPTX 包或数据关系无法完成核验：${String(error.message || '无效文件').slice(0, 300)}` });
    }
    return { status: issues.length ? 'blocked' : 'passed', slideCount, ...counts,
        checkedScope: ['object_identity', 'text', 'table_cells', 'chart_relationships', 'chart_cache', 'chart_workbook', 'diagram_connections', 'image_resources', 'media_resources', 'notes'],
        issues, officeVisual: 'not_checked', message: '已回读真实PPTX的对象、文字、单元格、图表缓存与嵌入工作簿、图示连接和资源；独立Office视觉渲染另行验证。' };
}

module.exports = { verifyPptxExport };
