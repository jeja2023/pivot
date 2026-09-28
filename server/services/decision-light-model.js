'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeLinearModel } = require('./decision-provider');

const MAX_MODEL_BYTES = 1_048_576;
const cache = new Map();

function safeModelFileName(value = '') {
    const file = String(value || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.json$/.test(file) ? file : '';
}

function resolveDecisionModelPath({ rootDir = '', modelFile = '' } = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '../../data/decision-models'));
    const file = safeModelFileName(modelFile);
    if (!file) throw new Error('invalid_light_model_file');
    const target = path.resolve(root, file);
    if (path.dirname(target) !== root) throw new Error('invalid_light_model_path');
    return { root, target, file };
}

function computeDecisionModelHash(model = {}) {
    const normalized = normalizeLinearModel(model);
    return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function cacheKey(target) {
    return path.normalize(target).toLowerCase();
}

async function loadLocalLinearDecisionModel(options = {}) {
    const { target } = resolveDecisionModelPath(options);
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MODEL_BYTES) throw new Error('invalid_light_model_size');
    const key = cacheKey(target);
    const cached = cache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.model;
    const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    const model = normalizeLinearModel(parsed);
    if (!Object.keys(model.actionWeights).length) throw new Error('invalid_light_model_content');
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, model });
    return model;
}

async function writeLocalLinearDecisionModel(model, options = {}) {
    const { root, target } = resolveDecisionModelPath(options);
    const normalized = normalizeLinearModel(model);
    if (!Object.keys(normalized.actionWeights).length) throw new Error('invalid_light_model_content');
    await fs.promises.mkdir(root, { recursive: true });
    const temporary = target + '.tmp-' + process.pid;
    await fs.promises.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, target);
    cache.delete(cacheKey(target));
    return { path: target, model: normalized, weightsHash: computeDecisionModelHash(normalized) };
}


module.exports = {
    computeDecisionModelHash,
    loadLocalLinearDecisionModel,
    writeLocalLinearDecisionModel
};
