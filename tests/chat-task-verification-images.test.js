'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const http = require('node:http');
const { queryOne, execute } = require('../server/db/client');
const { resolveChatVerificationImages } = require('../server/services/chat-verification-images');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
const { verifyTaskOutcome } = require('../server/services/agent-verification');
const { getMaxImagesPerMessage } = require('../server/image-safety');

const model = { url: 'http://127.0.0.1:1', model_name: '图片核验夹具', supports_vision: true, max_input_tokens: 32000 };

async function fixture(t) {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const suffix = `verification-images-${process.pid}-${Date.now()}`;
    const sessionId = suffix, runId = `${suffix}-run`;
    const directory = path.resolve(process.env.PIVOT_UPLOAD_DIR, String(user.id), sessionId);
    const file = path.join(directory, 'image.png');
    await fs.mkdir(directory, { recursive: true });
    t.after(async () => {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        await execute('DELETE FROM attachments WHERE session_id = ?', [sessionId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await fs.rm(file, { force: true });
        await fs.rmdir(directory);
    });
    await sharp({ create: { width: 5, height: 5, channels: 3, background: '#fff' } }).png().toFile(file);
    await execute("INSERT INTO sessions(id,user_id,title) VALUES (?,?,'图片核验')", [sessionId, user.id]);
    const imageMarkdown = `![原图](/uploads/${user.id}/${sessionId}/image.png)`;
    const message = await queryOne("INSERT INTO messages(session_id,user_id,role,content) VALUES (?,?,'user',?) RETURNING id", [sessionId, user.id, `提取图片中的文字。${imageMarkdown}`]);
    const attachment = await queryOne("INSERT INTO attachments(user_id,session_id,file_name,file_path,file_type,file_size) VALUES (?,?,'image.png',?,'image/png',100) RETURNING id", [user.id, sessionId, `uploads/${user.id}/${sessionId}/image.png`]);
    const metadata = { chatBridge: { userMessageId: message.id }, conversationMessageIds: [message.id] };
    await execute("INSERT INTO agent_runs(id,user_id,session_id,goal,status,metadata) VALUES (?,?,?,'提取图片文字','verifying',?::jsonb)", [runId, user.id, sessionId, JSON.stringify(metadata)]);
    const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    return { user, run, attachment, message, imageMarkdown, file };
}

function verificationInput(current) {
    return { run: current.run, user: current.user, contract: { deliverables: ['图片文字'], acceptance: { requireEvidence: true, requireSemanticVerification: true } }, answer: '合成识别结果', observations: [] };
}

const verifierDeps = callModelJson => ({ getModel: async () => model, resolveMemoryEvidence: async () => ({ current: true, memories: [] }), callModelJson });
const passed = { passed: true, needsInput: false, coveredDeliverables: ['图片文字'], missing: [] };

test('独立核验读取真实上传原图，没有OCR工具和文件产物也能核对图片内容', async t => {
    const current = await fixture(t);
    let received;
    const input = verificationInput(current);
    const semanticVerification = await verifyAutomaticTask(input, verifierDeps(async (_model, messages) => {
        received = messages;
        assert.match(messages[0].content, /无须额外调用OCR工具/);
        assert.deepEqual(JSON.parse(messages[1].content).verifiedArtifacts, []);
        return passed;
    }));
    assert.equal(semanticVerification.passed, true);
    assert(received.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))));
    assert.equal(semanticVerification.verifiedSourceImages[0].messageId, current.message.id);
    assert.doesNotMatch(JSON.stringify(semanticVerification), /base64|\/uploads\//);
    assert.equal(verifyTaskOutcome({ ...input, taskContract: input.contract, semanticVerification }).outcomeStatus, 'verified');
});

test('原图权限、删除和过期在核验时重新检查，不能复用模型自报图像', async t => {
    const current = await fixture(t);
    await assert.rejects(() => resolveChatVerificationImages(current.run, { id: current.user.id + 100000 }, model), error => error.code === 'CHAT_SOURCE_REVOKED');
    for (const assignment of ['deleted_at=NOW()', "deleted_at=NULL,expires_at=NOW()-INTERVAL '1 second'"]) {
        await execute(`UPDATE attachments SET ${assignment} WHERE id=?`, [current.attachment.id]);
        const result = await verifyAutomaticTask(verificationInput(current), verifierDeps(async () => { throw Error('失效图像不得进入模型'); }));
        assert.equal(result.reason, 'verification_evidence_incomplete');
        assert.match(result.missing[0], /图片/);
    }
});

test('核验期间原图被替换或来源消息撤销，迟到的通过结果无效', async t => {
    const current = await fixture(t);
    const changed = await verifyAutomaticTask(verificationInput(current), verifierDeps(async () => {
        await sharp({ create: { width: 5, height: 5, channels: 3, background: '#000' } }).png().toFile(current.file);
        return passed;
    }));
    assert.equal(changed.reason, 'source_revoked');
    const revoked = await verifyAutomaticTask(verificationInput(current), verifierDeps(async () => {
        await execute('UPDATE messages SET deleted_at=NOW() WHERE id=?', [current.message.id]);
        return passed;
    }));
    assert.equal(revoked.reason, 'source_revoked');
});

test('图片过多和无视觉模型明确保留核验缺口，不能静默跳图', async t => {
    const current = await fixture(t);
    const unsupported = await verifyAutomaticTask(verificationInput(current), { ...verifierDeps(async () => { throw Error('不支持视觉时不得请求模型'); }), getModel: async () => ({ ...model, supports_vision: false }) });
    assert.equal(unsupported.reason, 'verification_evidence_incomplete');
    assert.match(unsupported.missing[0], /视觉/);
    await execute('UPDATE messages SET content=? WHERE id=?', [current.imageMarkdown.repeat(getMaxImagesPerMessage() + 1), current.message.id]);
    const overLimit = await verifyAutomaticTask(verificationInput(current), verifierDeps(async () => { throw Error('图片不完整时不得请求模型'); }));
    assert.equal(overLimit.reason, 'verification_context_limit');
});

test('核验使用持久授权消息，元数据中的远程图像不能引入额外来源', async t => {
    const current = await fixture(t);
    await execute('UPDATE messages SET content=? WHERE id=?', ['纯文本消息', current.message.id]);
    current.run.metadata.chatBridge.currentMessage = { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/untrusted.png' } }] };
    const result = await resolveChatVerificationImages(current.run, current.user, model);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.sources, []);
});

test('真实核验模型HTTP请求携带原生图片，结果持久化前再次检查当前图片', async t => {
    const current = await fixture(t);
    let received;
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            received = JSON.parse(body);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(passed) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const result = await verifyAutomaticTask(verificationInput(current), {
        getModel: async () => ({ ...model, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }),
        resolveMemoryEvidence: async () => ({ current: true, memories: [] })
    });
    assert.equal(result.passed, true);
    assert(received.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))));
});
