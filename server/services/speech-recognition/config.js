'use strict';

function configuredSpeechProvider(read) {
    return { kind: read('PIVOT_VOICE_PROVIDER'), endpoint: read('PIVOT_VOICE_ENDPOINT').trim(), apiKey: read('PIVOT_VOICE_API_KEY'),
        streamEndpoint: read('PIVOT_VOICE_STREAM_ENDPOINT').trim(), model: read('PIVOT_VOICE_MODEL').trim(),
        allowExternal: read('PIVOT_VOICE_ALLOW_EXTERNAL'), timeoutMs: read('PIVOT_VOICE_TIMEOUT_MS'), minConfidence: read('PIVOT_VOICE_MIN_CONFIDENCE') };
}

async function resolveSpeechProvider(read, embedded, { signal } = {}) {
    const config = configuredSpeechProvider(read);
    if (config.kind !== 'embedded') return config;
    return { ...config, ...await embedded.ensureReady({ signal }), kind: 'gateway', allowExternal: false };
}

module.exports = { configuredSpeechProvider, resolveSpeechProvider };
