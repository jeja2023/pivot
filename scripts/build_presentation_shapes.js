'use strict';

// 从固定版本的 Apache POI DrawingML 数据重建精简运行时目录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');
const SOURCE_SHA256 = '4a762444d8d85876881c02a5b1dedf6f73006fcd8acb7b4e393435615b37c780';
const output = path.resolve(__dirname, '../client/vendor/presentation/preset-shapes.json');
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error('请通过 --source 指定已固定版本的 presetShapeDefinitions.xml。');
const bytes = Buffer.from(fs.readFileSync(path.resolve(process.argv[sourceIndex + 1]), 'utf8').replace(/\r\n/g, '\n'));
if (crypto.createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256) throw new Error('形状数据摘要与固定版本不一致，请核对来源。');
const document = new DOMParser({ onError: (level, message) => { throw new Error(`${level}: ${message}`); } }).parseFromString(bytes.toString('utf8'), 'application/xml');
const children = node => Array.from(node?.childNodes || []).filter(node => node.nodeType === 1);
const find = (node, name) => children(node).find(node => node.localName === name);
const attributes = node => Object.fromEntries(Array.from(node?.attributes || []).filter(attribute => !attribute.name.startsWith('xmlns')).map(attribute => [attribute.name, attribute.value]));
const point = node => [node.getAttribute('x'), node.getAttribute('y')];
const guides = node => children(node).map(node => [node.getAttribute('name'), node.getAttribute('fmla')]);
const presets = {};
for (const shape of children(document.documentElement)) {
    presets[shape.localName] = {
        adjustments: guides(find(shape, 'avLst')), guides: guides(find(shape, 'gdLst')),
        handles: children(find(shape, 'ahLst')).map(node => ({ type: node.localName, ...attributes(node), position: point(find(node, 'pos')) })),
        connections: children(find(shape, 'cxnLst')).map(node => ({ angle: node.getAttribute('ang'), position: point(find(node, 'pos')) })),
        textRect: attributes(find(shape, 'rect')),
        paths: children(find(shape, 'pathLst')).map(node => ({ ...attributes(node), commands: children(node).map(command => {
            const name = command.localName;
            return name === 'arcTo' ? [name, ...['wR', 'hR', 'stAng', 'swAng'].map(key => command.getAttribute(key))] : [name, ...children(command).flatMap(point)];
        }) }))
    };
}
if (Object.keys(presets).length !== 187) throw new Error('形状目录数量与固定版本不一致。');
const catalog = { schemaVersion: 1, source: { project: 'Apache POI 5.4.1', commit: '4554f204cbbf00ecbcaed134fe57e43a1779a612', sha256: SOURCE_SHA256,
    license: 'Apache-2.0', retrievedThrough: 'ppt-master@769547394107870a0c7b5ad8d1c0c75035123aef' }, presets };
const serialized = JSON.stringify(catalog) + '\n';
if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== serialized) throw new Error('运行时形状目录与固定源数据不一致。');
} else { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, serialized); }
console.log(`DrawingML 形状目录：${Object.keys(presets).length} 项，${Buffer.byteLength(serialized)} 字节。`);
