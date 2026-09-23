'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildStructuredTaskState,
    normalizeTaskState
} = require('../server/services/structured-task-state');
const {
    rejectLowConfidenceResults,
    rerankHybridCandidates
} = require('../server/services/rag-index/ranking');
const {
    normalizeRelativeEntryPath
} = require('../server/services/agent-path-safety');
const { listReportTools } = require('../server/services/builtin-mcp-reports');
const { pruneChatToolCandidates } = require('../server/services/chat-context-assembler');
const { validateToolInput, normalizeToolContract } = require('../server/services/agent-contracts');

test('结构化任务状态只保留当前问题、证据需求和工具意图', () => {
    const state = buildStructuredTaskState({ prompt: '依据销售制度，从本机报表目录统计 2025 年销售额' });
    assert.equal(state.retrievalQuery, state.currentQuestion);
    assert.ok(state.evidenceNeeds.includes('knowledge_base'));
    assert.ok(state.evidenceNeeds.includes('local_document'));
    assert.equal(state.toolIntent.requiresLocalFiles, true);
    assert.match(state.hash, /^[a-f0-9]{64}$/);
    const next = normalizeTaskState({ currentQuestion: '只回答已发布制度', retrievalQuery: '只回答已发布制度' }, state);
    assert.equal(next.retrievalQuery, '只回答已发布制度');
    assert.equal(next.schemaVersion, 1);
});

test('RAG rerank 提升短语、标题和词覆盖命中的候选', () => {
    const ranked = rerankHybridCandidates([
        { chunkId: 1, text: '完全不同的通用内容', headingPath: '', denseScore: 0.8, fused: 0.9 },
        { chunkId: 2, text: '销售制度规定 2025 年销售额按月份统计', headingPath: '销售制度', denseScore: 0.65, fused: 0.75 }
    ], '销售制度 2025 年销售额', { scoreThreshold: 0.4 });
    assert.equal(ranked[0].chunkId, 2);
    assert.ok(ranked[0].rerankScore > ranked[1].rerankScore);
});

test('RAG 低置信度或模糊并列结果直接拒答', () => {
    const low = rejectLowConfidenceResults([{ chunkId: 1, text: '弱相关', denseScore: 0.41, fused: 0.01 }], { scoreThreshold: 0.4, minRerankScore: 0.3, minCitationConfidence: 0.42 });
    assert.equal(low.rejected, true);
    const ambiguous = rejectLowConfidenceResults([
        { chunkId: 1, text: '相关片段一', denseScore: 0.48, fused: 0.4 },
        { chunkId: 2, text: '相关片段二', denseScore: 0.47, fused: 0.399 }
    ], { scoreThreshold: 0.4, minRerankScore: 0.2, minCitationConfidence: 0.2, minMargin: 0.02 });
    assert.equal(ambiguous.rejected, true);
});

test('本机目录路径只接受白名单根目录下的相对候选路径', () => {
    assert.equal(normalizeRelativeEntryPath('reports/2025.csv'), 'reports/2025.csv');
    for (const value of ['../secret.csv', '/etc/passwd', 'C:\\secret.csv', 'reports\\..\\secret.csv', 'reports/file.txt:stream']) {
        assert.throws(() => normalizeRelativeEntryPath(value), /路径|绝对|越权|备用数据流/);
    }
});



test('工具回退路径也限制候选数量并优先本机文件能力', () => {
    const tools = Array.from({ length: 20 }, (_, index) => ({
        name: index === 19 ? 'reports.list_files' : 'db.tool_' + index,
        fullName: index === 19 ? 'mcp.0.reports.list_files' : 'mcp.1.db.tool_' + index
    }));
    const picked = pruneChatToolCandidates(tools, { toolIntent: { requiresLocalFiles: true, requestedCapabilities: ['filesystem.read_workspace'] } });
    assert.equal(picked.length, 8);
    assert.equal(picked[0].name, 'reports.list_files');
});



test('严格 Schema 不会破坏明确声明的动态 Map 字段', () => {
    const tool = normalizeToolContract({
        name: 'demo.dynamic', source: 'builtin',
        input_schema: { type: 'object', properties: { fields: { type: 'object' }, name: { type: 'string' } } }
    });
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.equal(Object.prototype.hasOwnProperty.call(tool.input_schema.properties.fields, 'additionalProperties'), false);
});

test('报表工具 Schema 拒绝未知输入字段', () => {
    const tool = normalizeToolContract({ ...listReportTools().find(item => item.name === 'reports.read_file_summary'), source: 'mcp' });
    const issues = validateToolInput(tool, { path: '0:2025.csv', unexpected: true });
    assert.ok(issues.length > 0);
});
