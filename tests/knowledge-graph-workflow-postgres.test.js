'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { executeKnowledgeGraphQuery } = require('../server/services/knowledge-graph-tool-results');
const { publishLegacyDocumentProjection } = require('../server/services/knowledge-content');
const { indexKnowledgeGraphForChunks } = require('../server/services/knowledge-graph');
const { getDagNodeCompleteOutputForUser, getRunDetailForUser } = require('../server/services/agent-runs');

test('图谱统一来源、工作流节点详情及完整输出接口均复核数据库中的当前权限与版本', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`graph-chain-${suffix}`]);
    const other = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`graph-other-${suffix}`]);
    const runId = `graph-workflow-${suffix}`;
    const sessionId = `graph-history-${suffix}`;
    let doc;
    try {
        const collection = await queryOne('INSERT INTO knowledge_collections(user_id,name,created_at,updated_at) VALUES (?,?,NOW(),NOW()) RETURNING id', [user.id, '职责资料']);
        doc = await queryOne("INSERT INTO knowledge_docs(user_id,collection_id,name,status,is_enabled,chunk_count,indexed_chunks,created_at,updated_at) VALUES (?,?,?,'ready',1,1,1,NOW(),NOW()) RETURNING id", [user.id, collection.id, '职责制度.txt']);
        const content = '运维中心负责测试平台，测试平台依赖知识系统。';
        const chunk = await queryOne('INSERT INTO knowledge_chunks(doc_id,content,chunk_index,char_start,char_end) VALUES (?,?,0,0,?) RETURNING id', [doc.id, content, content.length]);
        await publishLegacyDocumentProjection({ legacyDocId: doc.id, userId: user.id });
        await indexKnowledgeGraphForChunks({ userId: user.id, docId: doc.id, chunks: [{ chunkId: chunk.id, content }] });
        const input = { query: '测试平台由谁负责', collectionIds: [Number(collection.id)] };
        const result = await executeKnowledgeGraphQuery(input, user);
        assert.equal(result.knowledgeSourceVersion, 1);
        assert.ok(result.paths.some(path => path.relationType === 'responsible_for'));
        assert.equal(result.sources.length, 1);
        assert.ok(result.sources[0].citationKey);
        await assert.rejects(executeKnowledgeGraphQuery(input, other), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
        const otherResult = await executeKnowledgeGraphQuery({ query: input.query }, other);
        assert.deepEqual(otherResult.sources, []);
        assert.doesNotMatch(JSON.stringify(otherResult), /运维中心|职责制度/);

        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,run_mode,metadata,created_at,updated_at) VALUES (?,?,'知识工作流','核对职责','completed','dag','{}',NOW(),NOW())", [runId, user.id]);
        await execute("INSERT INTO agent_dag_nodes(run_id,node_key,title,tool_name,status,input,output,created_at) VALUES (?,'graph','图谱查询','knowledge.graph.query','completed',?,?,NOW())", [runId, JSON.stringify(input), JSON.stringify(result)]);
        await execute("INSERT INTO agent_steps(run_id,step_index,type,title,tool_name,status,output,created_at) VALUES (?,1,'dag','图谱查询','knowledge.graph.query','success',?,NOW())", [runId, JSON.stringify(result)]);
        const current = await getDagNodeCompleteOutputForUser(runId, 'graph', user);
        assert.equal(current.complete, true);
        assert.equal(current.output.sources[0].citationKey, result.sources[0].citationKey);
        assert.equal(await getDagNodeCompleteOutputForUser(runId, 'graph', other), null);
        const detail = await getRunDetailForUser(runId, user);
        assert.equal(detail.dagNodes[0].output.sources[0].title, '职责制度.txt');
        assert.equal(detail.steps[0].output.sources[0].title, '职责制度.txt');
        const artifact = await require('../server/services/agent-tools-artifacts').executeArtifactTool('artifact.render', { format: 'docx',
            ir: { ir_version: '1', doc_type: 'report', meta: { title: '职责报告' }, blocks: [{ type: 'paragraph', runs: [{ text: content }] }] } }, user, { runId, stepId: `${runId}:document` });
        const renditions = require('../server/services/agent-artifact-renditions');
        const token = await renditions.issueDownloadToken(user, artifact.renditionId);
        assert.ok(token);
        await require('../server/services/agent-traces').recordAgentTraceSpan(runId, { name: '知识派生结果', output: { text: content } });
        await execute('UPDATE agent_runs SET final_answer = ? WHERE id = ?', [content, runId]);
        await execute("INSERT INTO sessions(id,user_id,title,created_at) VALUES (?,?,'来源历史',NOW())", [sessionId, user.id]);
        const route = JSON.stringify({ rag: { knowledgeEvidence: { knowledgeSourceVersion: 1, sources: result.sources } } });
        await execute("INSERT INTO messages(session_id,user_id,role,content,route_metadata,created_at) VALUES (?,?,'assistant',?,?,NOW())", [sessionId, user.id, content, route]);
        const history = await require('../server/repositories/sessions').listMessages(sessionId, user.id);
        assert.equal(history[0].content, content);
        const audit = await require('../server/services/knowledge-ai-audit').recordKnowledgeAiAnswer({ userId: user.id, sessionId, answer: content,
            retrieval: { knowledgeEvidence: { knowledgeSourceVersion: 1, sources: result.sources } }, grounding: { accepted: true, sourceCount: 1 } });
        assert.equal(audit.answer, content);

        await execute('UPDATE knowledge_chunks SET content = ? WHERE id = ?', ['新制度中已取消原职责', chunk.id]);
        const stale = await getDagNodeCompleteOutputForUser(runId, 'graph', user);
        assert.equal(stale.complete, false);
        assert.equal(stale.source, 'unavailable');
        assert.equal(stale.outputRef, null);
        assert.equal(stale.output.retrieval.reasonCode, 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        const revoked = await getRunDetailForUser(runId, user);
        assert.equal(revoked.knowledgeAccess.current, false);
        assert.doesNotMatch(JSON.stringify(revoked), /运维中心|职责制度/);
        assert.doesNotMatch(JSON.stringify(revoked.dagNodes.map(node => node.output)), /运维中心|测试平台|职责制度/);
        assert.doesNotMatch(JSON.stringify(revoked.steps.map(step => step.output)), /运维中心|测试平台|职责制度/);
        assert.equal(await require('../server/services/agent-artifacts').getAgentArtifactForUser(artifact.artifactId, user), null);
        assert.equal(await renditions.getRenditionForUser(artifact.renditionId, user), null);
        assert.equal(await renditions.issueDownloadToken(user, artifact.renditionId), null);
        await assert.rejects(require('../server/services/agent-traces').getAgentTraceForUser(runId, user), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        await assert.rejects(require('../server/services/agent-checkpoints').listAgentCheckpointsForUser(runId, user), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(await require('../server/repositories/sessions').listMessages(sessionId, user.id)), /运维中心负责测试平台/);
        assert.doesNotMatch(JSON.stringify(await require('../server/llm').getContext(sessionId, user.id, {})), /运维中心负责测试平台/);
        assert.doesNotMatch(JSON.stringify(await require('../server/services/knowledge-ai-audit').listKnowledgeAiAnswerLogs(user.id)), /运维中心负责测试平台/);
        assert.equal((await require('../server/repositories/sessions').getSessionById(sessionId, user.id)).knowledge_access.current, false);
        assert.deepEqual(await require('../server/services/chat-context-state-store').listChatContextSnapshotsForUser(sessionId, user), []);
        const changed = await executeKnowledgeGraphQuery(input, user);
        assert.deepEqual(changed.paths, []);
        assert.deepEqual(changed.sources, []);
        await execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        const disabled = await executeKnowledgeGraphQuery(input, user);
        assert.deepEqual(disabled.sources, []);
    } finally {
        await execute('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await execute('DELETE FROM agent_artifacts WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_steps WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_dag_nodes WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM knowledge_graph_claim_evidence WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM knowledge_graph_claims WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM knowledge_relations WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM knowledge_entity_mentions WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM knowledge_entities WHERE user_id = ?', [user.id]);
        if (doc?.id) {
            await execute('DELETE FROM knowledge_documents WHERE legacy_doc_id = ?', [doc.id]);
            await execute('DELETE FROM knowledge_chunks WHERE doc_id = ?', [doc.id]);
            await execute('DELETE FROM knowledge_docs WHERE id = ?', [doc.id]);
        }
        await execute('DELETE FROM knowledge_collections WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM users WHERE id IN (?,?)', [user.id, other.id]);
    }
});
