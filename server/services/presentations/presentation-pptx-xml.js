'use strict';

const path = require('node:path').posix;
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const NS = Object.freeze({ p: 'http://schemas.openxmlformats.org/presentationml/2006/main', a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    c: 'http://schemas.openxmlformats.org/drawingml/2006/chart', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    rel: 'http://schemas.openxmlformats.org/package/2006/relationships', x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' });
function parse(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('PPTX XML 包含不支持的外部声明。');
    return new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`PPTX XML 无效：${message}`); } }).parseFromString(xml, 'application/xml');
}
function all(node, namespace, name) { return Array.from(node.getElementsByTagNameNS(namespace, name)); }
function children(node, namespace, name) { return Array.from(node.childNodes || []).filter(child => child.nodeType === 1 && child.namespaceURI === namespace && (!name || child.localName === name)); }
function text(node) { return all(node, NS.a, 't').map(item => item.textContent).join(''); }
const compact = value => String(value ?? '').replace(/\s/gu, '');
function relationshipPath(file) { return path.join(path.dirname(file), '_rels', path.basename(file) + '.rels'); }
function resolveTarget(file, target) {
    if (!target || /[\\\u0000]|^[a-z][a-z0-9+.-]*:/i.test(target)) return '';
    const resolved = path.normalize(target.startsWith('/') ? target.slice(1) : path.join(path.dirname(file), target));
    return resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/') ? '' : resolved;
}
async function relationships(zip, file) {
    const relsFile = zip.file(relationshipPath(file));
    if (!relsFile) return new Map();
    return new Map(all(parse(await relsFile.async('string')), NS.rel, 'Relationship').map(node => {
        const mode = node.getAttribute('TargetMode'), target = node.getAttribute('Target');
        return [node.getAttribute('Id'), { type: node.getAttribute('Type'), external: mode === 'External', target: mode === 'External' ? '' : resolveTarget(file, target) }];
    }));
}
function objectRecords(document) {
    return ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].flatMap(kind => all(document, NS.p, kind).flatMap(node => {
        const nonVisual = children(node, NS.p).find(child => child.localName.startsWith('nv'));
        const identity = nonVisual && all(nonVisual, NS.p, 'cNvPr')[0];
        return identity ? [{ node, kind, id: identity.getAttribute('id'), name: identity.getAttribute('name') }] : [];
    }));
}
function element(document, namespace, name, attributes = {}) {
    const node = document.createElementNS(namespace, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
}
function serialize(document) { return new XMLSerializer().serializeToString(document); }

module.exports = { NS, parse, all, children, text, compact, relationships, objectRecords, element, serialize };
