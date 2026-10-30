const fs = require('fs');
const http = require('http');

const port = Number.parseInt(process.env.E2E_FAKE_MODEL_PORT || '0', 10);
const logPath = String(process.env.E2E_FAKE_MODEL_LOG || '').trim();
function log(message) {
    if (logPath) fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

const server = http.createServer((req, res) => {
    log(`${req.method} ${req.url}`);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const isResponses = String(req.url || '').includes('/responses');
        if (!String(req.url || '').includes('/chat/completions') && !isResponses) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
        if (isResponses) {
            if (payload.model !== 'gpt-5.6-e2e-stream-snapshot') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: '未配置此模型的 Responses 测试场景' } }));
                return;
            }
            const text = 'Responses 流式回复只显示一次。';
            const response = { id: 'e2e-response-snapshot', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 6, output_tokens: 9, total_tokens: 15 } };
            if (payload.stream === false) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(response));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Responses 流式回复' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '只显示一次。' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
            res.end('data: [DONE]\n\n');
            return;
        }
        const semanticDelayMs = JSON.stringify(payload).includes('E2E_SEMANTIC_DELAY') ? 1_500 : 0;
        const respond = () => {
        if (payload.stream === false) {
            let content = '真实 E2E 回答';
            if (JSON.stringify(payload.messages || []).includes('E2E_KNOWLEDGE_刑事案件') && payload.messages?.some(message => String(message.content || '').includes('知识库证据蕴含核验器'))) {
                content = JSON.stringify({ claims: [{ index: 1, supported: true, sourceIds: [1] }] });
            }
            if (payload.messages?.some(message => message.role === 'system' && String(message.content || '').includes('你只解释已计算的资金交易统计'))) content = JSON.stringify({ observations: [{ factId: 'total-0', comment: '请核对原始交易记录并确认统计范围。' }] });
            if (payload.messages?.some(message => message.role === 'system' && String(message.content || '').includes('总结提供的思维导图分支'))) content = JSON.stringify({ summary: 'AI 分支总结验收' });
            if (payload.messages?.some(message => message.role === 'system' && String(message.content || '').includes('现有分支展开新的子分支'))) content = JSON.stringify({ id: 'root', text: '展开主题', children: [{ id: 'new-branch', text: 'AI 新增分支', children: [] }] });
            if (payload.messages?.some(message => message.role === 'system' && String(message.content || '').includes('生成中文思维导图'))) {
                content = JSON.stringify({ id: 'root', text: 'AI 验收主题', children: [{ id: 'node-1', text: '核对生成结果', children: [] }] });
            }
            if (payload.messages?.some(message => String(message.content || '').includes('你是对话下一步决策器'))) {
                const request = JSON.parse(payload.messages.find(message => message.role === 'user').content);
                const delegated = /汇总.*订单|分析.*附件|修改.*代码|生成.*风险报告/.test(request.prompt);
                content = JSON.stringify({ action: delegated ? 'agent_run' : 'direct_answer', intent: delegated ? 'delegate' : 'answer', objective: request.prompt,
                    constraints: [], deliverables: delegated ? ['风险报告'] : [], requiredCapabilities: delegated ? ['data.query','document.render'] : [],
                    routing: { knowledge: /公司.*婚假|知识库/.test(request.prompt) ? 'required' : 'none', tools: delegated ? 'task' : 'none', retrievalQuery: request.prompt },
                    missingFacts: [], evidenceRefs: ['current_message'], confidence: 0.9 });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'e2e-completion', object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
            }));
            return;
        }
        log(`streaming ${Buffer.concat(chunks).length} bytes`);
        const knowledgeFixture = payload.messages?.some(message => String(message.content || '').includes('E2E_KNOWLEDGE_刑事案件'));
        const attachmentFixture = JSON.stringify(payload.messages || []).includes('E2E_ATTACHMENT_独立样本文本');
        const streamContent = knowledgeFixture ? '刑事案件应依照法律规定办理。[引用 1]' : (attachmentFixture ? '已收到附件中的独立样本文本。' : '真实 E2E 流式回答');
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        if (payload.model === 'pivot-e2e-empty-response') { res.end('data: [DONE]\n\n'); return; }
        if (payload.model === 'pivot-e2e-slow-response') {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开始生成'.repeat(30) } }] })}\n\n`);
            const timer = setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"结束生成"}}]}\n\ndata: [DONE]\n\n'), 10000);
            res.on('close', () => clearTimeout(timer));
            return;
        }
        res.write(`data: ${JSON.stringify({ id: 'e2e-completion', choices: [{ index: 0, delta: { role: 'assistant', content: streamContent }, finish_reason: null }] })}\n\n`);
        res.write('data: {"id":"e2e-completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\n');
        res.end('data: [DONE]\n\n');
        };
        if (semanticDelayMs > 0) {
            setTimeout(respond, semanticDelayMs);
        } else {
            respond();
        }
    });
});

server.listen(port, '127.0.0.1', () => {
    log(`ready ${port}`);
    process.stdout.write('ready\n');
});

function shutdown() { server.close(() => process.exit(0)); }
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
