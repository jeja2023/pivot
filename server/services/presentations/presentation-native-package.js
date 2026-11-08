'use strict';

const Zip = require('jszip');
const { diagramScene } = require('../../../client/chat/presentation-graphics');
const geometry = require('./presentation-geometry');
const { NS, parse, all, children, objectRecords, element, serialize, relationships } = require('./presentation-pptx-xml');

async function repairGeneratedChartWorkbooks(zip) {
    let changed = false;
    const workbooks = new Set();
    for (const name of Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))) {
        for (const rel of (await relationships(zip, name)).values()) if (/\/package$/.test(rel.type) && !rel.external && /\.xlsx$/.test(rel.target)) workbooks.add(rel.target);
    }
    for (const name of workbooks) {
        const file = zip.file(name);
        if (!file) continue;
        const workbook = await Zip.loadAsync(await file.async('nodebuffer'));
        let repaired = false;
        for (const sheetName of Object.keys(workbook.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
            const document = parse(await workbook.file(sheetName).async('string'));
            for (const cell of all(document, NS.x, 'c')) {
                const value = all(cell, NS.x, 'v')[0], type = cell.getAttribute('t');
                // PptxGenJS 会把明确零值写成空的数值 <v>。
                // 此处仅处理本服务生成、每个数值单元格均已有有限输入的工作簿。
                if ((!type || type === 'n') && value && value.textContent === '') { value.textContent = '0'; repaired = true; }
            }
            if (repaired) workbook.file(sheetName, serialize(document));
        }
        if (repaired) { zip.file(name, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); changed = true; }
    }
    return changed;
}

function connectEdge(document, record, from, to, edge) {
    if (!record || !from || !to) throw new Error('原生图示连接缺少对应节点。');
    const node = element(document, NS.p, 'p:cxnSp');
    const nonVisual = element(document, NS.p, 'p:nvCxnSpPr');
    const identity = all(record.node, NS.p, 'cNvPr')[0].cloneNode(true);
    const properties = element(document, NS.p, 'p:cNvCxnSpPr');
    const site = (start, end) => Math.abs(end.x - start.x) > Math.abs(end.y - start.y) ? end.x > start.x ? 3 : 1 : end.y > start.y ? 2 : 0;
    properties.appendChild(element(document, NS.a, 'a:stCxn', { id: from.id, idx: site(edge.start, edge.end) }));
    properties.appendChild(element(document, NS.a, 'a:endCxn', { id: to.id, idx: site(edge.end, edge.start) }));
    nonVisual.appendChild(identity); nonVisual.appendChild(properties); nonVisual.appendChild(element(document, NS.p, 'p:nvPr'));
    node.appendChild(nonVisual);
    node.appendChild(children(record.node, NS.p, 'spPr')[0].cloneNode(true));
    record.node.parentNode.replaceChild(node, record.node);
    record.node = node; record.kind = 'cxnSp';
}

function groupObjects(document, records, name, nextId, bounds, rotation = 0) {
    if (!records.length) return;
    const parent = records[0].node.parentNode;
    if (records.some(record => record.node.parentNode !== parent)) throw new Error('原生组合的对象不属于同一图层。');
    const group = element(document, NS.p, 'p:grpSp'), nonVisual = element(document, NS.p, 'p:nvGrpSpPr');
    nonVisual.appendChild(element(document, NS.p, 'p:cNvPr', { id: nextId, name }));
    nonVisual.appendChild(element(document, NS.p, 'p:cNvGrpSpPr')); nonVisual.appendChild(element(document, NS.p, 'p:nvPr'));
    group.appendChild(nonVisual);
    const properties = element(document, NS.p, 'p:grpSpPr'), transform = element(document, NS.a, 'a:xfrm', rotation ? { rot: Math.round(rotation * 60000) } : {});
    const box = { x: Math.round(bounds.x), y: Math.round(bounds.y), cx: Math.max(1, Math.round(bounds.width)), cy: Math.max(1, Math.round(bounds.height)) };
    for (const kind of ['off', 'ext', 'chOff', 'chExt']) transform.appendChild(element(document, NS.a, `a:${kind}`, /ext/i.test(kind) ? { cx: box.cx, cy: box.cy } : { x: box.x, y: box.y }));
    properties.appendChild(transform); group.appendChild(properties);
    const order = children(parent, NS.p).filter(child => records.some(record => record.node === child));
    parent.insertBefore(group, order[0]);
    order.forEach(node => group.appendChild(node));
}

async function applyNativePresentationObjects(buffer, presentation) {
    const zip = await Zip.loadAsync(buffer);
    const emuPerPx = presentation.aspectRatio === '4:3' ? 9144000 / presentation.width : 12192000 / presentation.width;
    let changed = await repairGeneratedChartWorkbooks(zip);
    for (let index = 0; index < presentation.slides.length; index++) {
        const slide = presentation.slides[index], diagrams = slide.elements.filter(item => item.type === 'diagram' && item.visible);
        const name = `ppt/slides/slide${index + 1}.xml`, document = parse(await zip.file(name).async('string'));
        const records = objectRecords(document), byName = new Map(records.map(record => [record.name, record]));
        records.forEach((record, index) => {
            record.id = String(index + 2); all(record.node, NS.p, 'cNvPr')[0].setAttribute('id', record.id);
        });
        let nextId = Math.max(0, ...records.map(record => Number(record.id))) + 1;
        for (const shape of slide.elements.filter(item => item.type === 'shape' && item.visible)) {
            const record = byName.get(`pivotAnim_${shape.id}`), nativeGeometry = record && all(record.node, NS.a, 'prstGeom')[0];
            if (!nativeGeometry) throw new Error('原生形状缺少对应几何对象。');
            nativeGeometry.setAttribute('prst', shape.shapeType);
            while (nativeGeometry.firstChild) nativeGeometry.removeChild(nativeGeometry.firstChild);
            const adjustments = element(document, NS.a, 'a:avLst');
            for (const [key, value] of Object.entries(geometry.effectiveAdjustments(shape))) adjustments.appendChild(element(document, NS.a, 'a:gd', { name: key, fmla: `val ${Math.round(value)}` }));
            nativeGeometry.appendChild(adjustments);
        }
        for (const diagram of diagrams) {
            const prefix = `pivotAnim_${diagram.id}`, scene = diagramScene(diagram);
            for (const edge of scene.edges) connectEdge(document, byName.get(`${prefix}__edge_${edge.id}`), byName.get(`${prefix}__node_${edge.from}`), byName.get(`${prefix}__node_${edge.to}`), edge);
            groupObjects(document, records.filter(record => record.name.startsWith(prefix + '__')), prefix, nextId++, {
                x: diagram.x * emuPerPx, y: diagram.y * 9525, width: diagram.width * emuPerPx, height: diagram.height * 9525
            }, diagram.rotation);
        }
        zip.file(name, serialize(document)); changed = true;
    }
    return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }) : buffer;
}

module.exports = { applyNativePresentationObjects };
