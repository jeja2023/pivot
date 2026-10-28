'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkDocument, detectDocType } = require('../server/services/rag-chunker');

test('虚构法律文档按章节和条款分块，保留原文可追溯范围', () => {
    const source = '第一章 总则\n第一条 本示例仅用于测试，不构成真实法律。\n第二条 测试资料应记录来源。\n第三条 测试人员按程序核验。';
    const chunks = chunkDocument(source, { docName: '测试条例.txt', chunkSize: 120, overlap: 10 });
    assert.equal(detectDocType('测试条例.txt', source), 'legal');
    const target = chunks.find(item => item.content.includes('第二条'));
    assert.match(target.headingPath, /第一章.*第二条/);
    assert.equal(source.slice(target.charStart, target.charEnd), target.content);
});

test('虚构讲话稿按中文标题切分，后半部分保留章节与原文定位', () => {
    const source = '开场说明。\n一、加强基础建设\n第一部分的虚构讲话内容。\n二、完善协同机制\n后半部分要求开展跨部门协作和总结。';
    const chunks = chunkDocument(source, { docName: '测试讲话稿.txt', chunkSize: 120, overlap: 10 });
    assert.equal(detectDocType('测试讲话稿.txt', source), 'structured_prose');
    const target = chunks.find(item => item.content.includes('后半部分要求'));
    assert.match(target.headingPath, /二、完善协同机制/);
    assert.equal(source.slice(target.charStart, target.charEnd), target.content);
});
