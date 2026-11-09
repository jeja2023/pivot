'use strict';
const crypto = require('node:crypto');

function memoryContentDigest(content) { return crypto.createHash('sha256').update(String(content || '')).digest('hex'); }

function captureMemoryReferences(memories) {
    return memories.map(memory => ({ id: Number(memory.id), contentDigest: memoryContentDigest(memory.content) }));
}

async function resolveRunMemoryEvidence(run, user, deps = {}) {
    const references = await (deps.references || require('../repositories/agent-memory-evidence').injectedRunMemoryReferences)(run.id, user.id);
    if (!references.length) return { current: true, memories: [] };
    const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata || {};
    const config = typeof run.context_config === 'string' ? JSON.parse(run.context_config) : run.context_config || {};
    // 复用实际检索入口重新检查记忆开关、账号、作用域、状态、有效期及治理策略，不相信模型或调用方自报的事实。
    const current = await (deps.retrieve || require('./long-term-memory').retrieveLongTermMemories)(user.id, run.goal, {
        user, sessionId: run.session_id || '', projectId: config.projectId || metadata.projectId || '', limit: 20
    });
    const selected = [];
    for (const reference of references) {
        const memory = current.find(memory => Number(memory.id) === Number(reference.id));
        if (!memory || !reference.contentDigest || memoryContentDigest(memory.content) !== reference.contentDigest) return { current: false, memories: [] };
        selected.push({ id: Number(memory.id), content: String(memory.content || ''), origin: memory.origin, assertedBy: memory.assertedBy });
    }
    return { current: true, memories: selected };
}

module.exports = { captureMemoryReferences, resolveRunMemoryEvidence };
