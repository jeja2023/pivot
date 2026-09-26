'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('realtime voice client fails closed without device-local browser speech, serializes startup, and releases media resources', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'realtime-voice.js'), 'utf8');
    assert.match(source, /SpeechRecognition \|\| globalThis\.webkitSpeechRecognition/);
    assert.match(source, /processLocally/);
    assert.match(source, /localService === true/);
    assert.match(source, /voiceStart\?\.promise/);
    assert.match(source, /VOICE_HEARTBEAT_MS/);
    assert.match(source, /speechSynthesis\?\.cancel\?\./);
    assert.match(source, /barge_in/);
    assert.match(source, /stopTracks\(current\?\.stream\)/);
    assert.match(source, /chat\/voice-sessions/);
    assert.doesNotMatch(source, /MediaRecorder/);
    assert.doesNotMatch(source, /dataBase64|audioBlob|transcript:\s*/);
    const engine = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'engine.js'), 'utf8');
    assert.match(engine, /handleAssistantDelta/);
    assert.match(engine, /flushAssistantSpeech/);
});
