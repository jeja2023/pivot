'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('知识库 AI 审计迁移创建用户隔离的记录与查询索引', async () => {
    const [migration] = require('../server/db/migrations/knowledge-ai-answer-audit');
    let sql = '';
    await migration.upPg({ query: async statement => { sql = statement; } });
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_ai_answer_logs/);
    assert.match(sql, /user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(sql, /idx_knowledge_ai_answer_logs_user_created/);
});

test('知识库问答接口仅按当前用户读取审计指标和历史记录', () => {
    const routerSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/routes/knowledge.js'), 'utf8');
    assert.match(routerSource, /getKnowledgeAiQualityMetrics\(req\.user\.id/);
    assert.match(routerSource, /listKnowledgeAiAnswerLogs\(req\.user\.id/);
    assert.doesNotMatch(routerSource, /answers\/history[^\n]*isSuperAdmin/);
    assert.match(routerSource, /未检索到同时包含关键法律词/);
});

test('知识库 AI 审计服务对检索范围和模型用量做边界化持久化', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/services/knowledge-ai-audit.js'), 'utf8');
    assert.match(source, /function normalizeRetrieval/);
    assert.match(source, /function normalizeUsage/);
    assert.match(source, /selectedEvidence: normalizeEvidence\(matches\)/);
    assert.match(source, /retrievalQueries.*slice\(0, 3\)/s);
});
