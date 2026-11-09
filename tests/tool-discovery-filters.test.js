'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
const { rankTools, searchToolsForUser } = require('../server/services/tool-discovery');
const { executeToolDiscoveryMeta, getToolDiscoveryDefinitions } = require('../server/services/agent-tools-discovery');
const { createToolDiscoveryState } = require('../server/services/agent-tool-progressive-discovery');
const { recordDiscoverySearch } = require('../server/services/agent-discovery-progress');

const definition = getToolDiscoveryDefinitions((properties, required = []) => ({ type: 'object', properties, required }))[0];
const catalogTool = (risk, name = `mcp.1.read_${risk}`) => normalizeToolContract({
    name, description: '读取任务资料', source: 'mcp', risk,
    capabilities: ['network.request'], input_schema: { type: 'object', properties: {} }
});

test('搜索Schema中的文字风险等级能精确命中真实规范化目录，数字旧调用仍兼容', async () => {
    const tools = ['low', 'medium', 'high', 'critical'].map(risk => catalogTool(risk));
    for (const [index, riskLevel] of ['low', 'medium', 'high', 'critical'].entries()) {
        const input = { query: '读取', source: 'mcp', riskLevel };
        assert.deepEqual(validateToolInput(normalizeToolContract(definition), input), []);
        const result = await searchToolsForUser({ id: 1 }, input, { formatToolList: async () => tools });
        assert.deepEqual(result.candidates.map(item => item.toolRef.toolName), [tools[index].name]);
        assert.deepEqual(rankTools('读取', tools, { riskLevel: tools[index].risk_level }).map(item => item.tool.name), [tools[index].name]);
    }
    const zero = catalogTool(0);
    const zeroDeps = { formatToolList: async () => [zero, ...tools] };
    const cache = { discoveryCache: new Map() };
    await searchToolsForUser({ id: 1 }, { query: '读取' }, zeroDeps, cache);
    const result = await searchToolsForUser({ id: 1 }, { query: '读取', risk_level: 0 }, zeroDeps, cache);
    assert.deepEqual(result.candidates.map(item => item.riskLevel), [0]);
    for (const riskLevel of ['unknown', -1, 6, 1.9]) assert.deepEqual(rankTools('读取', tools, { riskLevel }), []);
});

test('空筛选反馈保留精确条件，提示能力标识及来源；缓存不能泄露已撤权目录', async () => {
    let tools = [catalogTool('low', 'mcp.1.workspace_read')];
    const deps = { formatToolList: async () => tools }, options = { discoveryCache: new Map() };
    const input = { query: '读取', capability: '读取文件内容', source: 'mcp', riskLevel: 'low' };
    const empty = await searchToolsForUser({ id: 1 }, input, deps, options);
    assert.deepEqual(empty.candidates, []);
    assert.equal(empty.searchFeedback.reason, 'filters_no_match');
    assert.deepEqual(empty.searchFeedback.availableFilters, { sources: ['mcp'], capabilities: ['network.request'], riskLevels: ['low'] });
    assert.equal(empty.searchFeedback.matchingFilterCount, 0);
    assert.match(empty.searchFeedback.message, /不会自动放宽/);
    assert.deepEqual(input, { query: '读取', capability: '读取文件内容', source: 'mcp', riskLevel: 'low' });
    const corrected = await searchToolsForUser({ id: 1 }, { ...input, capability: 'network.request' }, deps, options);
    assert.equal(corrected.candidates.length, 1);
    assert.deepEqual((await searchToolsForUser({ id: 1 }, { query: '读取', source: 'builtin' }, deps)).candidates, []);
    assert.deepEqual((await searchToolsForUser({ id: 1 }, { query: '读取', requireApproval: true }, deps)).candidates, []);
    const unmatched = await searchToolsForUser({ id: 1 }, { query: '不存在的业务名' }, deps);
    assert.equal(unmatched.searchFeedback.reason, 'query_no_match');
    tools = [];
    const revoked = await searchToolsForUser({ id: 1 }, input, deps, options);
    assert.equal(revoked.totalAuthorizedTools, 0);
    assert.deepEqual(revoked.searchFeedback, { reason: 'no_authorized_tools', message: '当前任务没有可用的授权工具，请检查工具是否启用并加入任务范围。' });
});

test('元工具空结果只公布当前任务授权范围中的筛选值，不执行或记忆被过滤工具', async () => {
    const allowed = catalogTool('low', 'mcp.1.workspace_read');
    const forbidden = normalizeToolContract({ name: 'hidden.write', source: 'builtin', capabilities: ['filesystem.write'], risk: 'high' });
    const state = createToolDiscoveryState();
    const result = await executeToolDiscoveryMeta('tools.search', { query: '读取', source: 'builtin' }, { id: 1, role: 'user' }, {
        run: { tool_allowlist: [allowed.name] }, toolDiscoveryState: state
    }, { toolDiscovery: { formatToolList: async () => [allowed, forbidden] } });
    assert.equal(result.value.totalAuthorizedTools, 1);
    assert.deepEqual(result.value.candidates, []);
    assert.deepEqual(result.value.searchFeedback.availableFilters.capabilities, ['network.request']);
    assert.deepEqual(result.value.searchFeedback.availableFilters.sources, ['mcp']);
    assert.equal(state.searched.size, 0);
});

test('重复空搜索仍有界停止，但已有授权工具时不会误报需要重新授权', () => {
    for (const totalAuthorizedTools of [0, 9]) {
        const state = {};
        const result = { catalogVersion: 'fixed', candidates: [], totalAuthorizedTools };
        for (let index = 0; index < 3; index++) recordDiscoverySearch(state, result);
        assert.throws(() => recordDiscoverySearch(state, result), error => {
            assert.equal(error.code, 'TOOL_DISCOVERY_NO_PROGRESS');
            if (totalAuthorizedTools) assert.match(error.message, /已有授权工具[\s\S]*未确认业务工具缺失/);
            else assert.match(error.message, /检查工具是否已启用/);
            return true;
        });
    }
});
