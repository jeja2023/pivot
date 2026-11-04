'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { captureToolApprovalBinding, assertToolApprovalCurrent } = require('../server/services/tool-approval-binding');
const { approvalInputHash } = require('../server/services/agent-approval-grants');
const { validateToolFile } = require('../server/services/tool-file-contract');
const { projectRunAudit } = require('../server/services/agent-audit-projection');
const { getToolChainMetrics } = require('../server/services/tool-chain-metrics');
const { evaluateRetrievalSample, aggregateRetrievalQuality } = require('../scripts/test_support/knowledge_quality_metrics');

test('审批绑定用户、任务、参数、目录版本、契约、端点和连接状态', async () => {
    let version = 1, address = 'https://service.local/a', state = 'active';
    const tool = { name: 'mcp.9.send', version: 1, input_schema: { type: 'object' }, side_effect: true };
    const run = { id: 'run', user_id: 7, metadata: {} }, user = { id: 7 }, input = { destination: 'group', connectionAccountId: 4 };
    const deps = { readServer: async () => ({ base_url: address, config: '{}', status: state }), activeRelease: async () => ({ id: version }),
        releaseItems: async () => [{ id: 5, tool_name: 'send', definition_digest: `v${version}` }], assertUsable: async () => ({ id: 4, auth_state: state }) };
    const binding = await captureToolApprovalBinding(run, tool, input, user, deps);
    run.metadata.approvalGrants = [{ tool: tool.name, key: 'key', inputHash: approvalInputHash(input), hashVersion: 2, binding }];
    await assertToolApprovalCurrent({ run, tool, input, user, key: 'key' }, deps);
    for (const change of [() => { version++; }, () => { address += '/changed'; }, () => { state = 'revoked'; }]) {
        change(); await assert.rejects(assertToolApprovalCurrent({ run, tool, input, user, key: 'key' }, deps), error => error.code === 'AGENT_APPROVAL_STALE');
    }
    assert.doesNotMatch(JSON.stringify(binding), /https:|service.local/);
    delete run.metadata.approvalGrants[0].binding;
    await assert.rejects(assertToolApprovalCurrent({ run, tool, input, user, key: 'key' }, deps), error => error.code === 'AGENT_APPROVAL_STALE');
});

test('工具文件契约验证 MIME、格式、大小、摘要和 SVG 外部资源', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const file = { format: 'svg', mimeType: 'image/svg+xml', encoding: 'base64', content: svg.toString('base64'), sha256: crypto.createHash('sha256').update(svg).digest('hex') };
    assert.equal(validateToolFile(file).format, 'svg');
    for (const patch of [{ mimeType: 'text/html' }, { format: 'exe' }, { sha256: 'a'.repeat(64) }, { content: '!!!' }]) assert.throws(() => validateToolFile({ ...file, ...patch }));
    const unsafe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://secret.local/a"/></svg>');
    assert.throws(() => validateToolFile({ ...file, content: unsafe.toString('base64'), sha256: crypto.createHash('sha256').update(unsafe).digest('hex') }));
});

test('审计导出省略 SQL 参数和正文，字符串密钥脱敏且来源只保留定位摘要', () => {
    const result = projectRunAudit({ run: { id: 'run', final_answer: 'Authorization: Bearer private-secret', metadata: { token: 'private' } },
        steps: [{ input: { sql: 'SELECT secret', parameters: ['private'] }, output: { content: '资料正文', sources: [] }, tool_name: 'db.query', status: 'success' }] });
    assert.doesNotMatch(JSON.stringify(result), /private-secret|SELECT secret|资料正文|parameters/);
    assert.equal(result.steps[0].input.omitted, true);
});

test('质量指标保留分母和样本量，业务失败、超时、拒绝与完成分开统计', async () => {
    const result = await getToolChainMetrics({ id: 7 }, {}, { readDeliveries: async () => [], read: async () => [{ total: '10', succeeded: '4', failed: '2', denied: '2', waiting_approval: '2', timeouts: '1', business_failures: '1', cancelled: 0, p50_ms: 20, p95_ms: 80, tokens: 30, estimated_cost: .2 }] });
    assert.equal(result.groups[0].invocationSuccessRate, .4);
    assert.equal(result.groups[0].denominator, 10);
    assert.equal(result.groups[0].businessFailures, 1);
    const sample = evaluateRetrievalSample({ expectedDocumentIds: [2, 3], expectedCitationKeys: ['ok'], reviewers: ['甲', '乙'] }, [{ document: { id: 1 }, citationKey: 'bad' }, { document: { id: 2 }, citationKey: 'ok' }]);
    assert.equal(sample.recallAtK, .5); assert.equal(sample.reciprocalRank, .5);
    const quality = aggregateRetrievalQuality([sample, { error: 'failed' }, evaluateRetrievalSample({ expectedNoAnswer: true }, [])]);
    assert.equal(quality.noAnswerAccuracy.value, 1);
    assert.equal(quality.citationAccuracy.value, .5);
    assert.equal(quality.factSupportRate.value, null);
});

test('大目录业务别名排序只评估授权子集，不把候选排名当作模型选用正确率', () => {
    const { evaluateToolDiscovery } = require('../scripts/benchmark_tool_discovery');
    const tools = Array.from({ length: 1000 }, (_, index) => ({ name: `mcp.1.unrelated_${index}`, title: `记录工具 ${index}` }));
    tools.push({ name: 'mcp.2.render_diagram', title: '图形渲染' }, { name: 'mcp.3.render_diagram', title: '无权工具' });
    const report = evaluateToolDiscovery({ tools, allowedToolNames: tools.filter(tool => tool.name !== 'mcp.3.render_diagram').map(tool => tool.name),
        cases: [{ query: '画流程图', expectedTools: ['mcp.2.render_diagram'] }, { query: '不存在的外部业务', expectedTools: [] }] });
    assert.equal(report.catalogSize, 1001);
    assert.equal(report.hitAt24, 1);
    assert.equal(report.modelSelectionAccuracy, null);
});

test('链路观测只记录发现、知识和文件状态，不复制业务正文', () => {
    const { toolResultReasonCodes } = require('../server/services/tool-chain-observation');
    assert.deepEqual(toolResultReasonCodes({ toolName: 'tools.search', output: { candidates: [] } }), ['TOOL_DISCOVERY_EMPTY']);
    assert.deepEqual(toolResultReasonCodes({ output: { knowledgeSourceVersion: 1, retrieval: { reasonCode: 'KNOWLEDGE_NO_RELIABLE_MATCH' }, context: '私有正文' } }), ['KNOWLEDGE_NO_RELIABLE_MATCH']);
    assert.deepEqual(toolResultReasonCodes({ output: { artifactId: 1, renditionId: 2 } }), ['ARTIFACT_REGISTERED']);
});
