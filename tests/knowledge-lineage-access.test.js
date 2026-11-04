'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../server/services/knowledge-tool-results');
const { mergeKnowledgeEvidence, packKnowledgeOutput, unpackKnowledgeOutput } = require('../server/services/knowledge-evidence-lineage');
const { inspectRunKnowledgeAccess, assertRunKnowledgeAccess, blockedRunDetail } = require('../server/services/knowledge-run-access');
const { createSubworkflowRuntime } = require('../server/services/agent-dag-subworkflow-runtime');
const source = { chunkId: 1, legacyDocumentId: 2, citationKey: 'kb:4:v5:b6', contentDigest: digest('制度正文') };
const evidence = { knowledgeSourceVersion: 1, sources: [source] };
const output = { ...evidence, matches: [{ content: '制度正文' }], context: '制度正文' };
const user = { id: 7 };

test('来源信封保持字符串、数组、数字及对象契约，来源集合去重且溢出时阻断', () => {
    for (const value of ['制度正文', [1, 2], 0, false, null, { answer: '结果' }]) {
        const restored = unpackKnowledgeOutput(JSON.stringify(packKnowledgeOutput(value, evidence)));
        assert.deepEqual(restored.value, value);
        assert.deepEqual(restored.knowledgeEvidence, evidence);
    }
    assert.equal(mergeKnowledgeEvidence(evidence, { knowledgeEvidence: evidence }).sources.length, 1);
    const overflow = mergeKnowledgeEvidence({ knowledgeSourceVersion: 1, sources: Array.from({ length: 1001 }, (_, chunkId) => ({ ...source, chunkId })) });
    assert.equal(overflow.knowledgeEvidenceIncomplete, true);
});

test('运行读取复核聚合来源，旧格式、禁用账号和无法确认时不放行', async () => {
    const read = async () => ({ run: { metadata: '{}' }, actor: { id: 7, status: 'active' }, rows: [{ tool_name: 'workflow.output', status: 'completed', output: packKnowledgeOutput('制度正文', evidence) }] });
    const access = await inspectRunKnowledgeAccess('run', user, { read, revalidate: async observations => observations[0].knowledgeEvidence.sources[0].chunkId === 1 });
    assert.equal(access.current, true);
    assert.equal(access.tracked, true);
    for (const patch of [{ actor: { status: 'disabled' } }, { rows: [{ tool_name: 'rag.search', status: 'success', output: '旧制度' }] }, { incomplete: true }]) {
        assert.equal((await inspectRunKnowledgeAccess('run', user, { read: async () => ({ ...await read(), ...patch }) })).current, false);
    }
    await assert.rejects(assertRunKnowledgeAccess('run', user, { read, revalidate: async () => false }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    const blocked = blockedRunDetail({ id: 'run', status: 'completed', title: '敏感标题', final_answer: '制度正文', metadata: '内部记录' }, { message: '来源失效' });
    assert.doesNotMatch(JSON.stringify(blocked), /敏感标题|制度正文|内部记录/);
});

test('预检索快照必须核对当前引用及原文，缺少引用和版本失效时阻断', async () => {
    const bridge = { ragEnabled: true, ragContext: '[引用 1 | citation: kb:4:v5:b6 | 来源: 制度]:\n制度正文' };
    const read = async () => ({ run: { metadata: { chatBridge: bridge } }, actor: { id: 7, status: 'active' }, rows: [] });
    assert.equal((await inspectRunKnowledgeAccess('run', user, { read, getCitation: async () => ({ document: { isCurrentVersion: true }, quotedText: '制度正文' }) })).current, true);
    for (const citation of [null, { document: { isCurrentVersion: false }, quotedText: '制度正文' }, { quotedText: '新正文' }]) {
        assert.equal((await inspectRunKnowledgeAccess('run', user, { read, getCitation: async () => citation })).current, false);
    }
});

test('子工作流来源沿输出节点传递，撤权与恢复均阻断旧内容', async () => {
    let allowed = true;
    const states = new Map(), calls = [];
    const nodes = [{ id: 'search', tool: 'rag.search', input: { query: '制度' }, dependsOn: [] },
        { id: 'output', tool: 'workflow.output', input: { name: 'result', value: '{{nodes.search.output.context}}' }, dependsOn: ['search'] }];
    const deps = { listDagNodes: async () => [...states.values()], upsertDagNode: async (_run, node, patch) => {
        const key = patch.nodeKey || node.id; states.set(key, { ...patch, node_key: key });
    }, resolveAgentWorkflowVersion: async () => ({ workflow: { id: 10, name: '子工作流' }, version: 1, version_id: 2, dagSpec: { nodes } }),
    resolveAgentWorkflowDependencyBindings: async value => value, getSubworkflowInvocation: async () => null, upsertSubworkflowInvocation: async () => {},
    assertRunNotCancelled: async () => {}, maybePauseForApproval: async () => false, isApprovalGranted: () => false,
    knowledge: { readSourceChunks: async () => allowed ? [{ chunk_id: 1, doc_id: 2, citation_key: source.citationKey, content: '制度正文' }] : [], validateCitationKeys: async () => true } };
    const runtime = createSubworkflowRuntime({ executeDagNodeWithPolicy: async ({ node, resolvedInput }) => { calls.push(node.tool); return { ok: true, output: node.tool === 'rag.search' ? output : { name: 'result', value: resolvedInput.value } }; },
        buildDagErrorInfo: () => ({}), prepareDagFallbackOutput: () => null, buildDagFallbackFinalAnswer: () => '', extractReadableDagOutput: () => '', upsertDagNode: deps.upsertDagNode });
    const run = () => runtime.executeSubworkflowDag({ input: { workflowId: 10 }, run: { id: 'lineage', goal: '制度' }, user, modelCfg: null, toolList: [{ name: 'rag.search' }, { name: 'workflow.output' }], deadline: Date.now() + 30000, deps });
    const result = await run();
    assert.equal(result.output, '制度正文');
    assert.equal(result.knowledgeEvidence.sources[0].citationKey, source.citationKey);
    assert.ok([...states.values()].find(row => row.node_key.endsWith(':output')).output.knowledgeEvidence);
    allowed = false; calls.length = 0;
    await assert.rejects(run(), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    assert.deepEqual(calls, []);
});

test('普通会话历史与摘要携带来源，撤权后不能进入展示或后续模型上下文', async () => {
    const { presentKnowledgeMessages, collectMessageKnowledgeEvidence } = require('../server/services/chat-knowledge-history');
    const rows = [{ id: 1, role: 'user', content: '用户问题' }, { id: 2, role: 'assistant', content: '制度正文', route_metadata: JSON.stringify({ rag: { knowledgeEvidence: evidence } }) },
        { id: 3, role: 'system', is_summary: 1, content: '制度摘要', route_metadata: JSON.stringify({ knowledgeEvidence: evidence }) }];
    const current = await presentKnowledgeMessages(rows, user, { revalidate: async () => true });
    assert.equal(current[1].content, '制度正文');
    assert.equal(collectMessageKnowledgeEvidence(current).sources[0].citationKey, source.citationKey);
    const revoked = await presentKnowledgeMessages(rows, user, { revalidate: async () => false });
    assert.doesNotMatch(JSON.stringify(revoked), /制度正文|制度摘要/);
    assert.equal(revoked[0].content, '用户问题');
    const legacy = await presentKnowledgeMessages([{ role: 'assistant', content: '旧制度', route_metadata: { rag: { grounding: { accepted: true, sourceCount: 1 } } } }], user);
    assert.doesNotMatch(JSON.stringify(legacy), /旧制度/);
    assert.equal(require('../server/services/semantic-router').buildRouteMetadata({ rag: { knowledgeEvidence: evidence } }).rag.knowledgeEvidence.sources[0].citationKey, source.citationKey);
});

test('聊天来源快照必须对应本轮已注入原文，不能用新内容重新绑定旧引用', async () => {
    const { captureChatKnowledgeEvidence } = require('../server/services/chat-knowledge-history');
    const row = { chunk_id: 1, doc_id: 2, citation_key: source.citationKey, content: '制度正文' };
    const deps = { getCitation: async () => ({ chunkId: 1, document: { isCurrentVersion: true } }), read: async () => [row],
        knowledge: { readSourceChunks: async () => [row], validateCitationKeys: async () => true } };
    assert.equal((await captureChatKnowledgeEvidence([{ citationKey: source.citationKey, excerpts: ['制度正文'] }], user, deps)).sources[0].contentDigest, source.contentDigest);
    row.content = '新制度正文';
    await assert.rejects(captureChatKnowledgeEvidence([{ citationKey: source.citationKey, excerpts: ['已不存在的旧条款'] }], user, deps), /不一致/);
});
