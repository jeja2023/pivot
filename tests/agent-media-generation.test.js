const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
    executeAgentImageGeneration,
    executeAgentTextToSpeech,
    extractMediaUrl,
    isAgentImageGenerationAvailable,
    isAgentTextToSpeechAvailable
} = require('../server/services/agent-media-generation');
const { detectUnsupportedCapability } = require('../server/capabilities');

function networkPolicy(port) {
    return {
        allowed_origins: [`http://127.0.0.1:${port}`],
        allowed_ports: [port],
        block_loopback: false,
        block_private_ranges: false,
        block_link_local: true
    };
}

test('controlled media providers return only allowlisted playable URLs and omit credentials', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
            const base = `http://127.0.0.1:${server.address().port}`;
            const response = req.url === '/image'
                ? { image: { url: `${base}/generated.png` } }
                : { audioUrl: `${base}/generated.mp3` };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(response));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const previous = {
        allow: process.env.ALLOW_SENSITIVE_OUTBOUND_URLS,
        imageEndpoint: process.env.AGENT_IMAGE_GENERATION_ENDPOINT,
        imageKey: process.env.AGENT_IMAGE_GENERATION_API_KEY,
        ttsEndpoint: process.env.AGENT_TTS_ENDPOINT,
        ttsKey: process.env.AGENT_TTS_API_KEY
    };
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    process.env.AGENT_IMAGE_GENERATION_ENDPOINT = `http://127.0.0.1:${port}/image`;
    process.env.AGENT_IMAGE_GENERATION_API_KEY = 'image-provider-secret';
    process.env.AGENT_TTS_ENDPOINT = `http://127.0.0.1:${port}/speech`;
    process.env.AGENT_TTS_API_KEY = 'speech-provider-secret';
    try {
        const context = { run: { network_policy: networkPolicy(port) } };
        const image = await executeAgentImageGeneration({ prompt: '绿色山谷的水彩插画' }, { id: 1, role: 'admin' }, context);
        const speech = await executeAgentTextToSpeech({ text: '这是受控语音合成。', voice: 'calm' }, { id: 1, role: 'admin' }, context);
        assert.equal(image.type, 'embedded_image');
        assert.equal(speech.type, 'embedded_audio');
        assert.match(image.url, /generated\.png$/);
        assert.match(speech.url, /generated\.mp3$/);
        assert.equal(received.length, 2);
        assert.equal(received[0].headers.authorization, 'Bearer image-provider-secret');
        assert.equal(received[1].headers.authorization, 'Bearer speech-provider-secret');
        assert.doesNotMatch(JSON.stringify({ image, speech }), /provider-secret/);
        assert.equal(isAgentImageGenerationAvailable(), true);
        assert.equal(isAgentTextToSpeechAvailable(), true);
        assert.equal(detectUnsupportedCapability('生成一张绿色山谷插画'), null);
        assert.equal(detectUnsupportedCapability('把这段文字朗读成语音'), null);
    } finally {
        process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous.allow;
        process.env.AGENT_IMAGE_GENERATION_ENDPOINT = previous.imageEndpoint;
        process.env.AGENT_IMAGE_GENERATION_API_KEY = previous.imageKey;
        process.env.AGENT_TTS_ENDPOINT = previous.ttsEndpoint;
        process.env.AGENT_TTS_API_KEY = previous.ttsKey;
        await new Promise(resolve => server.close(resolve));
    }
});

test('media generation rejects absent task network policy and malformed provider output', async () => {
    await assert.rejects(
        () => executeAgentImageGeneration({ prompt: 'test' }, { id: 1 }, { run: {} }, { env: { AGENT_IMAGE_GENERATION_ENDPOINT: 'https://media.example.test/image' } }),
        error => error.code === 'AGENT_MEDIA_NETWORK_POLICY_REQUIRED'
    );
    assert.equal(extractMediaUrl({ url: 'file:///private.png' }, 'image'), '');
    assert.equal(extractMediaUrl({ data: [{ url: 'https://media.example.test/a.png' }] }, 'image'), 'https://media.example.test/a.png');
});
