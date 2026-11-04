'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const repository = require('../server/repositories/knowledge');
const { executeKnowledgeSearch, revalidateKnowledgeToolEvidence } = require('../server/services/knowledge-tool-results');
const { publishLegacyDocumentProjection } = require('../server/services/knowledge-content');

test('统一知识结果使用当前 ACL 和版本，变更、停用和跨用户时不复用旧证据', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`knowledge-chain-${suffix}`]);
    const sessionId = `scope-session-${suffix}`;
    const runId = `knowledge-delivery-${suffix}`;
    let doc;
    try {
        const collection = await queryOne('INSERT INTO knowledge_collections(user_id,name,created_at,updated_at) VALUES (?,?,NOW(),NOW()) RETURNING id', [user.id, '测试制度']);
        await execute('INSERT INTO sessions(id,user_id,title,created_at) VALUES (?,?,?,NOW())', [sessionId, user.id, '范围测试']);
        const turns = require('../server/repositories/chat-conversation-turns');
        const turn = await turns.claimTurn({ userId: user.id, sessionId, requestKey: 'scope', inputHash: 'a'.repeat(64), content: '指定专题', modelId: null });
        await turns.updateTurn(turn, { decision: { action: 'direct_answer', knowledgeScope: { collectionIds: [Number(collection.id)] } } });
        assert.deepEqual((await turns.latestKnowledgeScope(sessionId, user.id, Number(turn.user_message_id) + 1)).collectionIds, [Number(collection.id)]);
        assert.equal(await turns.latestKnowledgeScope(sessionId, Number(user.id) + 99999, Number(turn.user_message_id) + 1), null);
        doc = await queryOne("INSERT INTO knowledge_docs(user_id,collection_id,name,status,is_enabled,chunk_count,indexed_chunks,created_at,updated_at) VALUES (?,?,?,'ready',1,1,1,NOW(),NOW()) RETURNING *", [user.id, collection.id, '测试制度.txt']);
        const chunk = await queryOne("INSERT INTO knowledge_chunks(doc_id,content,chunk_index,char_start,char_end) VALUES (?,'报销应在十日内提交',0,0,10) RETURNING id", [doc.id]);
        await publishLegacyDocumentProjection({ legacyDocId: doc.id, userId: user.id });
        const rows = await repository.readSourceChunks([chunk.id], user, { collectionIds: [collection.id] });
        assert.equal(rows.length, 1);
        assert.ok(rows[0].citation_key);
        assert.equal(await repository.validateCitationKeys([rows[0].citation_key], user), true);
        assert.equal((await repository.readSourceChunks([chunk.id], { id: Number(user.id) + 99999, role: 'user' })).length, 0);
        assert.equal(await repository.validateCitationKeys([rows[0].citation_key], { id: Number(user.id) + 99999, role: 'user' }), false);
        const result = await executeKnowledgeSearch({ query: '报销期限', collectionIds: [Number(collection.id)] }, user, {}, {
            debugRetrieveContext: async () => ({ matches: [{ chunkId: chunk.id, selected: true, score: .9 }] })
        });
        assert.equal(result.sources.length, 1);
        assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user), true);
        const batch = { type: 'tools_batch_read', count: 1, results: [{ toolName: 'rag.search', output: result }] };
        const observation = { tool: 'tools.batch_read', output: batch };
        const boundary = require('../server/services/agent-knowledge-boundary').assertAgentKnowledgeCurrent;
        await boundary({ run: {}, user, observations: [observation] });
        const presentSteps = require('../server/services/knowledge-tool-results').presentKnowledgeSteps;
        const step = { tool_name: 'rag.search', output: result, error_message: null };
        assert.equal((await presentSteps([step], user))[0].output.sources[0].title, '测试制度.txt');
        assert.doesNotMatch(JSON.stringify(await presentSteps([step], { id: Number(user.id) + 99999, role: 'user' })), /测试制度|报销应在/);
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'制度报告','根据制度生成文档','running','{}',NOW(),NOW())", [runId, user.id]);
        await execute("INSERT INTO agent_steps(run_id,step_index,type,tool_name,status,output,created_at) VALUES (?,1,'tool','tools.batch_read','success',?,NOW())", [runId, JSON.stringify(batch)]);
        const access = require('../server/services/knowledge-run-access').inspectRunKnowledgeAccess;
        assert.equal((await access(runId, user)).current, true);
        const delivery = await require('../server/services/agent-tools-artifacts').executeArtifactTool('artifact.render', {
            format: 'docx', ir: { ir_version: '1', doc_type: 'report', meta: { title: '制度报告' }, blocks: [{ type: 'paragraph', runs: [{ text: `${result.matches[0].content} [引用 1 | citation:${result.sources[0].citationKey}]` }] }] }
        }, user, { runId, stepId: `${runId}:1` });
        const contract = { deliverables: ['制度报告'], acceptance: { artifactRequired: true, requireSemanticVerification: true, requireEvidence: true } };
        const verify = require('../server/services/chat-task-verification').verifyAutomaticTask;
        const verification = await verify({ run: { id: runId }, user, contract, answer: '已生成制度报告', observations: [{ output: result }] }, {
            getModel: async () => ({}), callModelJson: async () => ({ passed: true, coveredDeliverables: ['制度报告'], missing: [] })
        });
        assert.equal(verification.passed, true);
        assert.equal(verification.verifiedArtifacts[0].id, delivery.renditionId);
        assert.equal(require('../server/services/agent-verification').verifyTaskOutcome({ taskContract: contract, answer: '已生成制度报告', observations: [{ output: result }], semanticVerification: verification }).outcomeStatus, 'verified');
        await execute('UPDATE knowledge_chunks SET content = ? WHERE id = ?', ['新内容', chunk.id]);
        assert.equal(await revalidateKnowledgeToolEvidence([{ output: result }], user), false);
        assert.equal(await revalidateKnowledgeToolEvidence([observation], user), false);
        await assert.rejects(boundary({ run: {}, user, observations: [observation] }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
        assert.equal((await access(runId, user)).current, false);
        assert.doesNotMatch(JSON.stringify(await presentSteps([step], user)), /测试制度|报销应在/);
        const stale = await verify({ run: { id: runId }, user, contract, answer: '已生成制度报告', observations: [{ output: result }] });
        assert.equal(stale.reason, 'source_revoked');
        assert.equal(stale.verifiedArtifacts.length, 1, '文件存在与来源失效是两个独立状态');
        await execute('UPDATE knowledge_docs SET is_enabled = 0 WHERE id = ?', [doc.id]);
        assert.equal(await repository.validateCitationKeys([rows[0].citation_key], user), false);
        assert.equal((await repository.readSourceChunks([chunk.id], user)).length, 0);
    } finally {
        if (runId) {
            try { await execute('DELETE FROM agent_verifications WHERE run_id = ?', [runId]); } catch (_) {}
            try { await execute('DELETE FROM agent_artifact_renditions WHERE run_id = ?', [runId]); } catch (_) {}
            try { await execute('DELETE FROM agent_artifacts WHERE run_id = ?', [runId]); } catch (_) {}
            try { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); } catch (_) {}
        }
        if (sessionId) {
            try { await execute('DELETE FROM chat_conversation_turns WHERE session_id = ?', [sessionId]); } catch (_) {}
            try { await execute('DELETE FROM messages WHERE session_id = ?', [sessionId]); } catch (_) {}
            try { await execute('DELETE FROM sessions WHERE id = ?', [sessionId]); } catch (_) {}
        }
        if (doc?.id) {
            try {
                await execute('DELETE FROM knowledge_citations WHERE document_id IN (SELECT id FROM knowledge_documents WHERE legacy_doc_id = ?)', [doc.id]);
                await execute('DELETE FROM knowledge_blocks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE legacy_doc_id = ?)', [doc.id]);
                await execute('DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE legacy_doc_id = ?)', [doc.id]);
                await execute('DELETE FROM knowledge_documents WHERE legacy_doc_id = ?', [doc.id]);
                await execute('DELETE FROM knowledge_chunks WHERE doc_id = ?', [doc.id]);
                await execute('DELETE FROM knowledge_docs WHERE id = ?', [doc.id]);
            } catch (_) {}
        }
        if (user?.id) {
            try { await execute('DELETE FROM knowledge_collections WHERE user_id = ?', [user.id]); } catch (_) {}
            try { await execute('DELETE FROM users WHERE id = ?', [user.id]); } catch (_) {}
        }
    }
});
