'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatRagResponseFlow } = require('../server/services/chat-rag-grounding');
const { validateKnowledgeAnswer } = require('../server/services/knowledge-grounding');

test('严格知识回答生成期间不公开正文，引用授权变化后只显示安全提示', async () => {
    const previous = process.env.PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED;
    process.env.PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED = 'false';
    try {
        const events = [];
        const context = '[引用 1 | citation:kb:1:v1:b1 | 来源:制度]: 报销必须十日内提交。';
        const flow = createChatRagResponseFlow({ contextResult: { ragGrounding: { required: true }, ragContext: context }, user: { id: 7 },
            validateCitationKeys: async () => false, writeSse: value => events.push(JSON.parse(value)) });
        flow.writeContent('报销必须十日内提交。');
        assert.deepEqual(events, []);
        const result = await flow.ground('报销必须十日内提交。[引用 1 | citation:kb:1:v1:b1]');
        assert.equal(result.ragGrounding.grounding.status, 'source_revoked');
        assert.doesNotMatch(events.filter(item => item.content).map(item => item.content).join(''), /十日/);
        const mixed = validateKnowledgeAnswer({ answer: '知识库中未找到足够依据，但可享受一百天假期。', ragContext: context, strict: true });
        assert.equal(mixed.grounding.accepted, false);
        assert.equal(mixed.grounding.refusalMixedWithContent, true);
    } finally {
        if (previous === undefined) delete process.env.PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED;
        else process.env.PIVOT_KNOWLEDGE_SEMANTIC_VERIFIER_ENABLED = previous;
    }
});
