const test = require('node:test');
const assert = require('node:assert/strict');
const { checkOfficialWritingReferences } = require('../server/services/official-writing-references');

test('公文来源核验区分有效、版本变化、不可访问与上传快照，不泄露失效来源内容', async () => {
    const references = [
        { id: 'one', chunkId: '1', citationKey: 'kb:1:v1:c1', version: '1', content: '引用内容' },
        { id: 'two', chunkId: '2', citationKey: 'kb:2:v1:c2', version: '1', content: '旧内容' },
        { id: 'three', chunkId: '3', citationKey: 'kb:3:v1:c3', version: '1', content: '不可访问的历史快照' },
        { id: 'upload-one', content: '上传文件的文字' }
    ];
    const checks = await checkOfficialWritingReferences({ id: 7 }, 'doc-one', {
        getDocument: async (user, id) => { assert.equal(user.id, 7); assert.equal(id, 'doc-one'); return { state: { references } }; },
        readChunks: async (ids, user) => {
            assert.deepEqual(ids, [1, 2, 3]); assert.equal(user.id, 7);
            return [{ chunk_id: 1, citation_key: 'kb:1:v1:c1', version_id: 1, content: '前文引用内容后文' },
                { chunk_id: 2, citation_key: 'kb:2:v2:c2', version_id: 2, content: '新内容' }];
        }
    });
    assert.deepEqual(checks.map(check => check.status), ['current', 'changed', 'unavailable', 'snapshot']);
    assert.equal(checks[2].currentContent, undefined);
    assert.equal(checks[2].citationKey, undefined);
});

test('文档无权访问时，不进行分块读取', async () => {
    await assert.rejects(() => checkOfficialWritingReferences({ id: 8 }, 'doc-one', {
        getDocument: async () => { throw Object.assign(new Error('公文不存在或已删除'), { status: 404 }); },
        readChunks: async () => { assert.fail('未获授权不能读取资料'); }
    }), error => error.status === 404);
});
