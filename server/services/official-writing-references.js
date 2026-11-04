const { getOfficialWritingDocument } = require('./official-writing-documents');
const { readSourceChunks } = require('../repositories/knowledge');

async function checkOfficialWritingReferences(user, clientId, deps = {}) {
    const document = await (deps.getDocument || getOfficialWritingDocument)(user, clientId);
    const refs = (document.state.references || []).slice(0, 100);
    const knowledge = refs.filter(ref => ref.citationKey || /^rag-/.test(ref.id));
    const rows = await (deps.readChunks || readSourceChunks)(knowledge.map(ref => Number(ref.chunkId)), user);
    return refs.map(ref => {
        if (!knowledge.includes(ref)) return { id: ref.id, status: 'snapshot', message: '本篇导入材料快照，请按来源文件核对' };
        const row = rows.find(row => Number(row.chunk_id) === Number(ref.chunkId));
        if (!row) return { id: ref.id, status: 'unavailable', message: '来源已删除、停用或当前账号无法访问；本篇保留当时的引用快照' };
        const current = (!ref.citationKey || ref.citationKey === String(row.citation_key || ''))
            && (!ref.version || String(ref.version) === String(row.version_id)) && String(row.content || '').includes(ref.content);
        return { id: ref.id, status: current ? 'current' : 'changed', message: current ? '来源仍可访问，引用文字未变化' : '来源版本或内容已变化，请重新选择依据',
            currentContent: String(row.content || '').slice(0, 10000), citationKey: String(row.citation_key || '') };
    });
}

module.exports = { checkOfficialWritingReferences };
