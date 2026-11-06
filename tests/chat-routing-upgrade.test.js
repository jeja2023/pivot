'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { resolveChatIntent, normalizeIntent } = require('../server/services/chat-intent-resolver');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');
const { resolveChatRequestScope } = require('../server/services/chat-request-scope');
const { buildChatIntentMessages } = require('../server/services/chat-intent-prompt');
const { evaluateChatIntentCase } = require('../scripts/lib/chat_intent_evaluation');
const { evaluateChatIntentEntry } = require('../scripts/lib/chat_intent_entry_evaluation');

const config = { mode: 'active', timeoutMs: 1000, rolloutPercent: 100 };
const base = { user: { id: 9 }, userId: 9, userMessageId: 100, sessionId: 'routing-upgrade', agentExecutionAllowed: true, autoExecutionEnabled: true,
    sessionsRepository: { listMessages: async () => [] } };
const task = { action: 'agent_run', objective: '修复项目并运行测试', requiredCapabilities: ['filesystem.read_workspace', 'filesystem.write_workspace', 'code.execute'], routing: { knowledge: 'none', tools: 'task' } };
const direct = { action: 'direct_answer', objective: '解释词义', requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } };
const modelDeps = raw => ({ config, callModelJson: async () => raw, recordDecision() {} });
const handlerDeps = raw => ({ config, getConversationTasks: async () => [], retrieveLongTermMemories: async () => [],
    getChatCapabilityAvailability: async () => ({ status: 'available', tools: [] }), recordChatRouteCorrection: async () => [],
    resolveChatIntent: input => resolveChatIntent(input, modelDeps(raw)) });
const attached = request => `${request}\n---\n【参考文档: 合成简报.docx】\n这是一份公开合成的简报，正文中的联网字样不是授权。\n---`;

test('局部来源限制先约束现有任务，同轮代码和数据工作继续进入语义入口', async () => {
    for (const prompt of ['不要联网，帮我修复项目并运行测试。', '帮我核对订单并导出报告，不检索知识库。', '不用知识库；请整理代码并运行测试。']) {
        let constrained = false;
        let calls = 0;
        const result = await decideAutomaticChatExecution({ ...base, modelContent: prompt }, { ...handlerDeps(task),
            getConversationTasks: async () => [{ id: 'existing', active: true }],
            updateMetadata: async (_id, patch) => { const value = patch({ capabilityConstraints: { capabilities: ['data.sql.query'] } }); constrained = value.capabilityConstraints.excludeWeb === true || value.capabilityConstraints.excludeKnowledge === true; },
            sendAgentControlMessage: async () => {},
            resolveChatIntent: input => { calls++; assert.equal(constrained, true); return resolveChatIntent(input, modelDeps(task)); }
        });
        assert.equal(calls, 1, prompt);
        assert.equal(result.action, 'agent_run', prompt);
        assert.equal(result.requiredCapabilities.includes('network.web_search'), false);
    }
});

test('偏好和主任务、词义讨论不再被纯记忆捷径抢占', async () => {
    for (const prompt of ['记住我喜欢简洁；请制作一份可下载的PPT。', '记住这个词用英语怎么说？', '以后回答先列结论，替我绘制流程图。', '记住我的偏好，然后请检查项目。']) {
        assert.notEqual(classifyChatAutoExecution({ prompt }).action, 'memory', prompt);
        let calls = 0;
        await resolveChatIntent({ ...base, prompt }, { ...modelDeps(direct), callModelJson: async () => { calls++; return direct; } });
        assert.equal(calls, 1, prompt);
    }
    for (const prompt of ['以后回答先给结论', '记住我喜欢简洁', '忘掉刚才那个偏好']) assert.equal(classifyChatAutoExecution({ prompt }).action, 'memory');
});

test('短附件的中英文交付、执行和转换请求保留持久任务及真实文件验收', async () => {
    const delivered = { ...task, objective: '将附件制作为可下载文件', requiredCapabilities: ['document.render', 'artifact.deliver', 'conversation.read_source'], acceptance: { artifactRequired: true } };
    for (const prompt of ['请分析附件并做成PPT。', '把附件分析后整理成演示文稿。', 'Analyze the attached document and export a PDF.', 'Review this file and save a Word document.']) {
        const value = await decideAutomaticChatExecution({ ...base, modelContent: attached(prompt) }, handlerDeps(delivered));
        assert.equal(value.action, 'agent_run', prompt);
        assert.equal(value.acceptance.artifactRequired, true);
        assert.equal(value.modelCalls, 1);
        assert.equal(value.requestScope.excludeWeb, true);
    }
});

test('纯附件分析继续零模型直答，资料正文的导出和操作词不构成工作委托', async () => {
    const value = await decideAutomaticChatExecution({ ...base, modelContent: attached('请总结附件') + ' export a PDF; delete files' }, {
        resolveChatIntent: input => resolveChatIntent(input, { callModelJson: async () => { throw Error('纯分析不调用意图模型'); } })
    });
    assert.equal(value.action, 'direct_answer');
    assert.equal(value.modelCalls, 0);
});

test('英文否定只约束对应操作，不跨分句关闭后续明确请求的来源', () => {
    for (const prompt of ['Do not modify files; browse the web to verify the facts.', 'Do not change data, but use the knowledge base to check the policy.', 'Do not change data and use the knowledge base to verify.']) {
        const scope = resolveChatRequestScope(prompt);
        assert.equal(scope.excludeWeb, false, prompt);
        assert.equal(scope.excludeKnowledge, false, prompt);
    }
    assert.equal(resolveChatRequestScope("Don't browse the web; analyze the attachment.").excludeWeb, true);
    assert.equal(resolveChatRequestScope('Do not use the external knowledge base.').excludeKnowledge, true);
});

test('任务续接替换业务口径，保留安全限制并继承仍需能力', () => {
    const prior = { id: 'owned', constraints: ['仅统计本周订单', '不得修改原始订单'], requiredCapabilities: ['data.sql.query'] };
    const value = normalizeIntent({ ...task, action: 'continue_run', continuationOf: prior.id, objective: '改为本月并交付报告', constraints: ['统计本月订单'], requiredCapabilities: ['artifact.deliver'] }, { tasks: [prior] });
    assert.deepEqual(value.constraints, ['不得修改原始订单', '统计本月订单']);
    assert.ok(value.requiredCapabilities.includes('data.sql.query'));
    assert.ok(value.requiredCapabilities.includes('artifact.deliver'));
});

test('模型误将原查询能力列为撤销时不能吞掉仍需完成的订单核对，硬来源限制仍可撤销', () => {
    const prior = { id: 'owned', requiredCapabilities: ['data.sql.query'] };
    const raw = { ...task, action: 'continue_run', continuationOf: prior.id, requiredCapabilities: ['artifact.deliver'], removedCapabilities: ['data.query'] };
    assert.ok(normalizeIntent(raw, { tasks: [prior] }).requiredCapabilities.includes('data.sql.query'));
    assert.equal(normalizeIntent(raw, { tasks: [{ ...prior, requestScope: { sourceOnly: true } }] }).requiredCapabilities.includes('data.sql.query'), false);
    const restricted = normalizeIntent(raw, { prompt: '继续生成报告，不要查询数据库', tasks: [prior] });
    assert.equal(restricted.requiredCapabilities.includes('data.sql.query'), false);
    assert.equal(restricted.requestScope.excludeData, true);
    assert.equal(resolveChatRequestScope('Do not change data; query the database.').excludeData, undefined);
    assert.equal(resolveChatRequestScope("Don't query the database; summarize existing results.").excludeData, true);
    const { evaluateToolPolicy } = require('../server/services/agent-policy');
    const rejected = evaluateToolPolicy({ run: { metadata: { capabilityConstraints: { excludeData: true } } },
        tool: { name: 'db.query', source: 'mcp', capabilities: ['data.sql.query'], idempotent: true, risk: 'low', input_schema: { type: 'object' } }, allowApproval: true });
    assert.ok(rejected.reasonCodes.includes('conversation_data_excluded'));
});

test('结构化地区和格式更新不会撤销只读、来源和审批限制', () => {
    const prior = { id: 'owned', constraints: ['统计华东地区', '输出摘要格式', '禁止联网', '不得发送报告'], businessScope: { region: '华东', format: '摘要' }, requiredCapabilities: ['data.sql.query', 'network.web_search'] };
    const value = normalizeIntent({ ...task, action: 'continue_run', continuationOf: prior.id, requiredCapabilities: ['artifact.deliver'], removedCapabilities: ['network.request'],
        businessScope: { region: '华南', format: 'PDF' } }, { tasks: [prior] });
    assert.equal(value.constraints.includes('统计华东地区'), false);
    assert.equal(value.constraints.includes('输出摘要格式'), false);
    assert.ok(value.constraints.includes('禁止联网'));
    assert.ok(value.constraints.includes('不得发送报告'));
    assert.equal(value.requiredCapabilities.includes('network.web_search'), false);
    assert.equal(value.businessScope.region, '华南');
});

test('业务维度更新不能误删支付条件、收入定义或多维旧约束，兼容更新不保留过期字段', () => {
    const prior = { id: 'owned', constraints: ['仅统计本周订单', '按税前收入口径统计', '仅统计华东已付款订单', '输出摘要格式'],
        businessScope: { timeRange: '本周', region: '华东' }, requiredCapabilities: ['data.sql.query'] };
    const value = normalizeIntent({ ...task, action: 'continue_run', continuationOf: prior.id, requiredCapabilities: [], constraints: ['改为本月口径'], businessScope: { region: '华南' } }, { tasks: [prior] });
    assert.equal(value.constraints.includes('仅统计本周订单'), false);
    assert.ok(value.constraints.includes('按税前收入口径统计'));
    assert.ok(value.constraints.includes('仅统计华东已付款订单'));
    assert.equal(value.businessScope.timeRange, undefined);
    assert.equal(value.businessScope.region, '华南');
});

test('续接和已完成任务的后续修订继承原来源限制，后续约束步骤不能重新开放', async () => {
    const prior = { id: 'owned', status: 'completed', constraints: ['禁止联网'], requestScope: { excludeWeb: true, excludeKnowledge: true }, requiredCapabilities: ['network.web_search', 'knowledge.search'] };
    const value = await resolveChatIntent({ ...base, prompt: '把原报告改成摘要', tasks: [prior] }, modelDeps({ ...task, action: 'continue_run', continuationOf: prior.id,
        requiredCapabilities: ['artifact.deliver'], routing: { knowledge: 'required', tools: 'task' } }));
    assert.equal(value.requestScope.excludeWeb, true);
    assert.equal(value.requestScope.excludeKnowledge, true);
    assert.equal(value.requiredCapabilities.includes('network.web_search'), false);
    assert.equal(value.requiredCapabilities.includes('knowledge.search'), false);
});

test('模型缺少必填路由和错误字段类型时安全降级，不能伪装成已完成判断', async () => {
    for (const patch of [{ routing: undefined }, { routing: { tools: 'none' } }, { constraints: '只读' }, { acceptance: { requireEvidence: 'yes' } }, { businessScope: { permission: 'all' } }, { removedCapabilities: ['admin.all'] }]) {
        const value = await resolveChatIntent({ ...base, prompt: '请查询昨天订单。' }, modelDeps({ ...direct, ...patch }));
        assert.equal(value.failureCode, 'intent_invalid_contract', JSON.stringify(patch));
        assert.equal(value.textOnlyFallback, true);
    }
});

test('仅需内置知识依据时不误开外部只读规划，显式知识工具选择仍保留', () => {
    const raw = { ...direct, requiredCapabilities: ['knowledge.search'], routing: { knowledge: 'required', tools: 'read_only' } };
    const value = normalizeIntent(raw, { requireRouting: true });
    assert.equal(value.routing.knowledge, 'required');
    assert.equal(value.routing.tools, 'none');
    assert.equal(value.routing.allowAutomaticRead, false);
    const named = normalizeIntent({ ...raw, routing: { ...raw.routing, toolNames: ['mcp.1.knowledge.search'] } }, { requireRouting: true,
        availability: { tools: [{ name: 'mcp.1.knowledge.search', capabilities: ['knowledge.search'], readOnly: true, idempotent: true }] } });
    assert.equal(named.routing.tools, 'read_only');
    assert.equal(named.routing.allowAutomaticRead, true);
});

test('严格输出协议传给模型，明确不兼容时只在原预算内重试并记录兼容状态', async () => {
    let attempts = 0;
    const value = await resolveChatIntent({ ...base, modelCfg: { id: 'strict-unsupported-test' }, prompt: '请解释向量检索' }, { ...modelDeps(direct),
        callModelJson: async (_model, _messages, options) => {
            attempts++;
            if (attempts === 1) { assert.equal(options.responseFormat.json_schema.strict, true); throw Object.assign(new Error('response_format json_schema is unsupported'), { status: 400 }); }
            assert.equal(options.responseFormat, undefined);
            assert.ok(options.timeoutMs <= config.timeoutMs);
            return direct;
        }
    });
    assert.equal(value.action, 'direct_answer');
    assert.equal(value.modelCalls, 2);
    assert.equal(value.structuredOutput, 'validated_compatibility');
    let retry = 0;
    const failed = await resolveChatIntent({ ...base, modelCfg: { id: 'ordinary-400-test' }, prompt: '请解释向量检索' }, { ...modelDeps(direct), callModelJson: async () => { retry++; throw Object.assign(new Error('invalid input'), { status: 400 }); } });
    assert.equal(retry, 1);
    assert.equal(failed.failureCode, 'intent_provider_unavailable');
});

test('动作分支协议减少无关字段，保留旧格式兼容且不能通过包装跳过执行校验', async () => {
    const { CHAT_INTENT_RESPONSE_FORMAT, decodeChatIntentPayload } = require('../server/services/chat-intent-schema');
    const branches = CHAT_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.decision.anyOf;
    const directSchema = branches.find(branch => branch.properties.action.enum.includes('direct_answer'));
    assert.equal(directSchema.properties.continuationOf, undefined);
    assert.equal(directSchema.properties.businessScope, undefined);
    assert.equal(directSchema.properties.question, undefined);
    assert.equal(branches.find(branch => branch.properties.action.enum.includes('continue_run')).properties.routing.properties.tools.enum[0], 'task');
    const value = await resolveChatIntent({ ...base, prompt: '请解释向量检索' }, modelDeps({ decision: direct }));
    assert.equal(value.action, 'direct_answer');
    const question = await resolveChatIntent({ ...base, prompt: '请发送报告' }, modelDeps({ decision: { action: 'clarify', objective: '发送报告', question: '需要发送给哪位收件人？', missingFacts: ['收件人'] } }));
    assert.equal(question.action, 'clarify');
    assert.equal(question.routing.tools, 'none');
    assert.throws(() => decodeChatIntentPayload({ decision: direct, action: 'agent_run' }), /动作分支/);
    const invalid = await resolveChatIntent({ ...base, prompt: '请查询订单' }, modelDeps({ decision: { ...task, routing: { knowledge: 'none', tools: 'none' } } }));
    assert.equal(invalid.failureCode, 'intent_invalid_contract');
});

test('唯一活动任务的明确继续不受慢模型阻塞，歧义、暂停、新主题和灰度仍遵守边界', async () => {
    const running = { id: 'owned', active: true, status: 'planning', goal: '核对订单', requiredCapabilities: ['data.sql.query'], constraints: ['不得修改订单'] };
    const value = await resolveChatIntent({ ...base, prompt: '继续按刚才的方案处理。', tasks: [running] }, { ...modelDeps(task), callModelJson: async () => { throw Error('确定续接不应调用模型'); } });
    assert.equal(value.action, 'continue_run');
    assert.equal(value.continuationOf, 'owned');
    assert.equal(value.modelCalls, 0);
    assert.ok(value.requiredCapabilities.includes('data.sql.query'));
    assert.ok(value.constraints.includes('不得修改订单'));
    for (const patch of [{ tasks: [running, { ...running, id: 'other' }] }, { tasks: [{ ...running, status: 'needs_input' }] }, { prompt: '继续解释向量检索原理' }, { executionAllowed: false }]) {
        let calls = 0;
        await resolveChatIntent({ ...base, prompt: '继续', tasks: [running], ...patch }, { ...modelDeps(direct), callModelJson: async () => { calls++; return direct; } });
        assert.equal(calls, 1, JSON.stringify(patch));
    }
    const shadow = await resolveChatIntent({ ...base, prompt: '继续', tasks: [running] }, { ...modelDeps(task), config: { ...config, mode: 'shadow' } });
    assert.equal(shadow.shadow, true);
    assert.equal(shadow.action, 'direct_answer');
});

test('唯一任务的时间和摘要更新保持运行身份，不调用模型且不扩大权限', async () => {
    for (const prompt of ['改为本月口径，输出只要摘要。', '这次只给摘要，并保留异常依据。', '好的，就按这个办。']) {
        const value = await resolveChatIntent({ ...base, prompt, tasks: [{ id: 'owned', active: true, status: prompt.startsWith('改为') ? 'needs_input' : undefined,
            goal: '核对订单', constraints: ['仅统计本周订单', '不得修改数据'], requiredCapabilities: ['data.sql.query'], acceptance: { requireEvidence: true } }] }, {
            ...modelDeps(direct), callModelJson: async () => { throw Error('明确字段更新不应等待模型'); }
        });
        assert.equal(value.action, 'continue_run');
        assert.equal(value.continuationOf, 'owned');
        assert.equal(value.modelCalls, 0);
        assert.ok(value.requiredCapabilities.includes('data.sql.query'));
        assert.equal(value.requiredCapabilities.includes('filesystem.write_workspace'), false);
        assert.ok(value.constraints.includes('不得修改数据'));
        if (prompt.startsWith('改为')) {
            assert.equal(value.businessScope.timeRange, '本月');
            assert.equal(value.businessScope.format, '摘要');
            assert.equal(value.constraints.includes('仅统计本周订单'), false);
        }
    }
    for (const prompt of ['改为删除全部订单', '这次只给摘要并发送给所有人', '解释这次只给摘要是什么意思']) {
        let called = false;
        await resolveChatIntent({ ...base, prompt, tasks: [{ id: 'owned', active: true }] }, { ...modelDeps(direct), callModelJson: async () => { called = true; return direct; } });
        assert.equal(called, true, prompt);
    }
});

test('独立纯文本草稿不因名称缺失反复澄清，历史、真实数据和交付请求仍进入语义判断', async () => {
    const value = await resolveChatIntent({ ...base, prompt: '请写一份产品发布报告。' }, { ...modelDeps(direct), callModelJson: async () => { throw Error('纯文本草稿不需要额外分类'); } });
    assert.equal(value.action, 'direct_answer');
    assert.equal(value.modelCalls, 0);
    assert.equal(value.routing.tools, 'none');
    assert.ok(value.constraints.some(constraint => constraint.includes('占位符')));
    for (const patch of [{ prompt: '请写一份公司本周销售报告。' }, { prompt: '请写一份可下载的产品发布报告。' },
        { prompt: '请写一份产品发布报告，然后发送给客户。' }, { history: [{ role: 'user', content: '请根据内部制度写报告' }] }]) {
        let calls = 0;
        await resolveChatIntent({ ...base, prompt: '请写一份产品发布报告。', ...patch }, { ...modelDeps(direct), callModelJson: async () => { calls++; return direct; } });
        assert.equal(calls, 1, JSON.stringify(patch));
    }
});

test('明确文件交付与渲染能力冲突时修复动作，讨论和代码执行不能借此获得任务授权', async () => {
    const raw = { ...direct, requiredCapabilities: ['document.render'], routing: { knowledge: 'none', tools: 'none' } };
    const value = await resolveChatIntent({ ...base, prompt: '把以下内容翻译成英文，并生成可下载的Word文件：本周已完成。' }, modelDeps(raw));
    assert.equal(value.action, 'agent_run');
    assert.equal(value.acceptance.artifactRequired, true);
    assert.deepEqual(value.contractAdjustments, ['explicit_artifact_task']);
    assert.equal(value.providerAction, 'direct_answer');
    for (const [prompt, requiredCapabilities] of [['解释如何生成PDF文件', ['document.render']], ['请生成PDF文件', ['document.render', 'code.execute']]]) {
        const rejected = await resolveChatIntent({ ...base, prompt }, modelDeps({ ...raw, requiredCapabilities }));
        assert.equal(rejected.failureCode, 'intent_invalid_contract');
    }
});

test('明确多步委托出现动作能力冲突时保留工作目标，模型自行推测的能力仍拒绝', async () => {
    for (const [prompt, requiredCapabilities] of [
        ['请汇总本周订单，核对异常并生成风险报告。', ['data.sql.query', 'document.render']],
        ['按刚才给出的方案修改项目代码，并运行测试。', ['filesystem.read_workspace', 'filesystem.write_workspace', 'code.execute']]
    ]) {
        const value = await resolveChatIntent({ ...base, prompt }, modelDeps({ ...direct, requiredCapabilities }));
        assert.equal(value.action, 'agent_run');
        assert.deepEqual(value.contractAdjustments, ['explicit_delegated_task']);
    }
    const rejected = await resolveChatIntent({ ...base, prompt: '请汇总订单并生成报告。' }, modelDeps({ ...direct, requiredCapabilities: ['data.sql.query', 'desktop.control'] }));
    assert.equal(rejected.capabilityDecisionUnavailable, true);
});

test('路由瞬时服务故障仅在原预算内重试一次，认证、长Retry-After和取消不重试', async () => {
    let calls = 0;
    const recovered = await resolveChatIntent({ ...base, prompt: '请解释向量检索' }, { ...modelDeps(direct), config: { ...config, timeoutMs: 3000 }, callModelJson: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('暂时不可用'), { status: 503 });
        return { decision: direct };
    } });
    assert.equal(recovered.action, 'direct_answer');
    assert.equal(recovered.modelCalls, 2);
    assert.equal(recovered.providerRetries, 1);
    for (const failure of [{ status: 401 }, { status: 429, response: { status: 429, headers: { 'retry-after': '60' } } }, { code: 'AI_ENDPOINT_CIRCUIT_OPEN' }]) {
        let attempts = 0;
        const result = await resolveChatIntent({ ...base, prompt: '请解释向量检索' }, { ...modelDeps(direct), callModelJson: async () => { attempts++; throw Object.assign(new Error('合成上游错误'), failure); } });
        assert.equal(attempts, 1);
        assert.equal(result.capabilityDecisionUnavailable, true);
    }
});

test('裁剪后的目录真实标记 partial，显式选中的工具不会被第二次固定裁剪丢失', () => {
    const tools = Array.from({ length: 30 }, (_, index) => ({ name: `mcp.${index + 1}.db.query`, capabilities: ['data.sql.query'], readOnly: true, idempotent: true }));
    const context = JSON.parse(buildChatIntentMessages({ prompt: '查询数据', availability: { status: 'available', totalTools: 30, tools } })[1].content);
    assert.equal(context.availability.status, 'partial');
    assert.equal(context.availability.tools.length, 24);
    const selected = JSON.parse(buildChatIntentMessages({ prompt: '查询所选来源', availability: { status: 'available', totalTools: 30, selectedToolNames: tools.map(tool => tool.name), tools } })[1].content);
    assert.equal(selected.availability.tools.length, 30);
    assert.equal(selected.availability.status, 'available');
});

test('模型不能指定被上下文预算裁掉的工具名称', async () => {
    const tools = Array.from({ length: 30 }, (_, index) => ({ name: `mcp.${index + 1}.db.query`, capabilities: ['data.sql.query'], readOnly: true, idempotent: true }));
    const value = await resolveChatIntent({ ...base, prompt: '请查询订单', availability: { status: 'available', totalTools: 30, tools } }, modelDeps({ ...direct,
        requiredCapabilities: ['data.sql.query'], routing: { knowledge: 'none', tools: 'read_only', toolNames: [tools[29].name] } }));
    assert.equal(value.failureCode, 'intent_invalid_contract');
});

test('长请求保留中段范围片段并禁止未复核原文的直接业务查询', async () => {
    const prompt = '请查询订单。' + '背景'.repeat(5000) + '仅限华东分公司已付款订单' + '背景'.repeat(5000);
    const context = JSON.parse(buildChatIntentMessages({ prompt })[1].content);
    assert.equal(context.requestContext.complete, false);
    assert.ok(context.requestContext.constraintExcerpts.some(item => item.text.includes('仅限华东分公司已付款订单')));
    assert.ok(context.prompt.length <= 12000);
    const tool = { name: 'mcp.1.db.query', capabilities: ['data.sql.query'], readOnly: true, idempotent: true };
    const value = await resolveChatIntent({ ...base, prompt, availability: { tools: [tool] } }, modelDeps({ ...direct, requiredCapabilities: ['data.sql.query'], routing: { knowledge: 'none', tools: 'read_only' } }));
    assert.equal(value.failureCode, 'intent_context_incomplete');
    assert.equal(value.routing.allowAutomaticRead, false);
    const delegated = await resolveChatIntent({ ...base, prompt }, modelDeps(task));
    assert.equal(delegated.action, 'agent_run');
    assert.ok(delegated.requiredCapabilities.includes('conversation.read_source'));
});

test('长请求任务必须在实际工具执行前读全原文，审批不能跳过缺页和来源边界', () => {
    const { evaluateToolPolicy } = require('../server/services/agent-policy');
    const tool = { name: 'db.query', source: 'mcp', capabilities: ['data.sql.query'], idempotent: true, risk: 'low', input_schema: { type: 'object' } };
    const sourceTool = { name: 'chat.read_source', source: 'builtin', capabilities: ['conversation.read_source'], idempotent: true, risk: 'low', input_schema: { type: 'object' } };
    const metadata = { requiredSourceMessages: [100], capabilityConstraints: { present: true, requireSourceBeforeTools: true, capabilities: ['data.sql.query', 'conversation.read_source'] },
        sourceReadProgress: { 100: { totalChars: 20000, ranges: [[0, 8000], [12000, 20000]] } } };
    assert.ok(evaluateToolPolicy({ run: { metadata }, tool, allowApproval: true }).reasonCodes.includes('conversation_source_incomplete'));
    assert.equal(evaluateToolPolicy({ run: { metadata }, tool: sourceTool }).decision, 'allow');
    metadata.sourceReadProgress[100].ranges.push([8000, 12000]);
    assert.equal(evaluateToolPolicy({ run: { metadata }, tool }).decision, 'allow');
});

test('任务上下文卡住受总预算约束，迟到结果不再调用模型或改变决策', async () => {
    let release;
    let calls = 0;
    const value = await decideAutomaticChatExecution({ ...base, modelContent: '请修复项目并运行测试' }, { ...handlerDeps(task), config: { ...config, timeoutMs: 40 },
        getConversationTasks: () => new Promise(resolve => { release = resolve; }), resolveChatIntent: async () => { calls++; return task; }
    });
    assert.equal(value.failureCode, 'intent_timeout');
    assert.equal(value.textOnlyFallback, true);
    release([]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    const timedOutModel = await resolveChatIntent({ ...base, prompt: '请解释向量检索' }, { ...modelDeps(direct), config: { ...config, timeoutMs: 20 }, callModelJson: () => new Promise(() => {}) });
    assert.equal(timedOutModel.failureCode, 'intent_timeout');
    assert.equal(timedOutModel.timing.queueMs, null);
    assert.equal(timedOutModel.timing.providerMs, null);
});

test('取消覆盖消息读取阶段，可选记忆与目录超时后仍可理解明确目标', async () => {
    const controller = new AbortController();
    let ready;
    const began = new Promise(resolve => { ready = resolve; });
    const pending = decideAutomaticChatExecution({ ...base, signal: controller.signal, modelContent: '请修复项目并运行测试', sessionsRepository: { listMessages: () => { ready(); return new Promise(() => {}); } } }, handlerDeps(task));
    await began;
    controller.abort(new Error('用户取消理解'));
    await assert.rejects(pending, /用户取消理解/);
    const value = await decideAutomaticChatExecution({ ...base, modelContent: '请解释向量检索' }, { ...handlerDeps(direct), config: { ...config, timeoutMs: 120 },
        retrieveLongTermMemories: () => new Promise(() => {}), getChatCapabilityAvailability: () => new Promise(() => {}),
        resolveChatIntent: async input => { assert.equal(input.preferences.length, 0); assert.equal(input.availability.status, 'unavailable'); return direct; }
    });
    assert.equal(value.action, 'direct_answer');
    assert.equal(value.failureCode, undefined);
    assert.ok(value.timing.totalMs < 120);
});

test('评测同时拒绝多余能力、陌生工具、旧口径和禁止的任务副作用', () => {
    const item = { expected: ['direct_answer'], expectedRouting: { knowledge: 'none', tools: 'none' }, forbiddenCapabilities: ['filesystem.write_workspace'],
        forbiddenToolNames: ['mcp.999.invalid'], forbiddenConstraintIncludes: ['仅统计本周'], forbiddenEffects: ['pause_task'] };
    for (const patch of [{ requiredCapabilities: ['filesystem.write_workspace'] }, { routing: { ...direct.routing, toolNames: ['mcp.999.invalid'] } },
        { constraints: ['仅统计本周订单'] }, { evaluationEffects: ['pause_task'] }]) assert.equal(evaluateChatIntentCase(item, { ...direct, ...patch }).passed, false);
    assert.equal(evaluateChatIntentCase(item, direct).passed, true);
});

test('入口评测覆盖前置混合限制并隔离真实任务控制操作', async () => {
    const item = { prompt: '不要联网，帮我修复项目并运行测试', expected: ['agent_run'], tasks: [{ id: 'synthetic', active: true }] };
    const value = await evaluateChatIntentEntry(item, base, input => resolveChatIntent(input, modelDeps(task)));
    assert.equal(value.action, 'agent_run');
    assert.deepEqual(value.evaluationEffects, ['restrict_task', 'steer_task']);
});

test('续接契约通过真实 PostgreSQL 控制消息应用后仍保留新范围和原有安全限制', async () => {
    const { queryOne, execute } = require('../server/db/client');
    const { continueConversationTask } = require('../server/services/chat-task-continuation');
    const { claimAgentControlMessages, applyAgentControlMessages } = require('../server/services/agent-control');
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `routing-contract-${process.pid}-${Date.now()}`;
    const initial = { taskContract: { goal: '核对订单', constraints: ['仅统计本周订单', '不得修改原始订单'], businessScope: { timeRange: '本周' } },
        capabilityConstraints: { present: true, capabilities: ['data.sql.query'] } };
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,'running',?,NOW(),NOW())", [runId, user.id, '合成路由契约测试', '核对订单', JSON.stringify(initial)]);
    try {
        const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [runId]);
        const decision = normalizeIntent({ ...task, action: 'continue_run', continuationOf: runId, objective: '改为本月并交付报告', constraints: ['统计本月订单'],
            businessScope: { timeRange: '本月' }, requiredCapabilities: ['artifact.deliver'] }, { tasks: [{ id: runId, ...initial.taskContract, requiredCapabilities: ['data.sql.query'] }] });
        await continueConversationTask({ decision, user, sessionId: 'synthetic-contract', userMessageId: 101, instruction: '改为本月并生成报告' }, { listSessionTasks: async () => [run] });
        const messages = await claimAgentControlMessages(runId, user);
        assert.equal(messages.length, 1);
        await applyAgentControlMessages(runId, user, messages);
        const saved = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId]);
        const metadata = typeof saved.metadata === 'string' ? JSON.parse(saved.metadata) : saved.metadata;
        assert.equal(metadata.taskContract.businessScope.timeRange, '本月');
        assert.equal(metadata.taskContract.constraints.some(value => value.includes('仅统计本周')), false);
        assert.ok(metadata.taskContract.constraints.includes('不得修改原始订单'));
        assert.ok(metadata.capabilityConstraints.capabilities.includes('data.sql.query'));
        assert.ok(metadata.capabilityConstraints.capabilities.includes('artifact.deliver'));
        assert.equal(metadata.workingState.constraints.some(value => value.text.includes('仅统计本周')), false);
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE to_run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
