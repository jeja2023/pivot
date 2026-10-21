'use strict';
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
function resolveSpeechRuntime(read, { platform = process.platform, root = PROJECT_ROOT, exists = fs.existsSync } = {}) {
    const packagedWorker = '/opt/pivot-speech/engine/embedded_worker.py';
    const packagedPython = '/opt/pivot-speech/engine-venv/bin/python';
    const developmentPython = path.join(root, '.venv-speech', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    let python = read('PIVOT_EMBEDDED_VOICE_PYTHON');
    if (python && /[\\/]/.test(python)) python = path.resolve(root, python);
    if (!python) python = exists(packagedPython) ? packagedPython : exists(developmentPython) ? developmentPython : platform === 'win32' ? 'python.exe' : 'python3';
    const worker = path.resolve(root, read('PIVOT_EMBEDDED_VOICE_WORKER') || (exists(packagedWorker) ? packagedWorker : 'docker/speech-service/embedded_worker.py'));
    const modelRoot = path.resolve(root, read('PIVOT_EMBEDDED_VOICE_MODEL_ROOT') || 'data/speech-models');
    return { python, worker, modelRoot };
}

module.exports = { resolveSpeechRuntime };
