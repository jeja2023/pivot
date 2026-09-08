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
        if (!String(req.url || '').includes('/chat/completions')) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
        if (payload.stream === false) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'e2e-completion', object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: '真实 E2E 回答' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
            }));
            return;
        }
        log(`streaming ${Buffer.concat(chunks).length} bytes`);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        res.write('data: {"id":"e2e-completion","choices":[{"index":0,"delta":{"role":"assistant","content":"真实 E2E 流式回答"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"e2e-completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}\n\n');
        res.end('data: [DONE]\n\n');
    });
});

server.listen(port, '127.0.0.1', () => {
    log(`ready ${port}`);
    process.stdout.write('ready\n');
});

function shutdown() { server.close(() => process.exit(0)); }
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
