'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageRevision } = require('../server/services/presentations/native/page-revision');

test('原稿改写仅生成当前版本指定页的文字补丁', async () => {
    const object = (id, text) => ({ id, runs: [{ paragraph: 0, run: 0, text }] });
    const owner = { id: 1 };
    const lookup = async (user, id, version) => {
        assert.deepEqual([user, id, version], [owner, 'draft', 2]);
        return { current_version: 2, manifest_json: { slides: [
            { objects: [object('1', '保留文字')] }, { objects: [object('2', '原支出10万元')] }
        ] } };
    };
    const request = { baseVersion: 2, slideIndex: 1, instruction: '改成实际支出12万元。' };
    const { messages, parse } = await pageRevision(owner, 'draft', request, lookup);
    assert.doesNotMatch(messages[1].content, /保留文字/);
    const edit = (objectId, text) => ({ objectId, paragraph: 0, run: 0, text });
    const parseEdits = edits => parse(JSON.stringify({ edits }));
    assert.deepEqual(parseEdits([edit('2', '实际支出12万元')]), { patches: [
        { slideIndex: 1, objectId: '2', runs: [{ paragraph: 0, run: 0, text: '实际支出12万元' }] }
    ] });
    assert.throws(() => parseEdits([edit('1', '越页修改')]), /当前页以外/);
    assert.throws(() => parseEdits([edit('2', '支出90万元')]), /缺少依据/);
    await assert.rejects(pageRevision(owner, 'draft', request, async () => ({ current_version: 3 })), { code: 'PRESENTATION_NATIVE_CONFLICT' });
});
