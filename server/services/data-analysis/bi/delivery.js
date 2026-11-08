'use strict';

const { transaction } = require('../../../db/client');
const authorization = require('../../../repositories/analysis-authorization');
const { asyncHandler } = require('../../../http');

const protections = new WeakMap();

function protect(value, descriptor) {
    const entries = protections.get(value) || [];
    protections.set(value, [...entries, descriptor]);
    return value;
}

function inherit(value, source) {
    for (const descriptor of descriptors(source)) protect(value, descriptor);
    return value;
}

function descriptors(value) {
    const pending = [value], seen = new WeakSet(), found = new Set();
    while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        seen.add(item);
        for (const entry of protections.get(item) || []) found.add(entry);
        for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
    }
    return [...found];
}

async function consume(value, send) {
    const entries = descriptors(value);
    if (!entries.length) return send(value);
    return transaction(async trx => {
        // 多模型列表先锁定全部主体，再统一锁模型与来源，发送期间不释放授权栅栏。
        await authorization.lockPrincipals(trx, entries.map(entry => entry.userId));
        const models = [...new Set(entries.flatMap(entry => [entry.modelId, ...(entry.modelIds || [])]).filter(Boolean))].sort();
        const datasets = [...new Set(entries.flatMap(entry => entry.definition.nodes.map(node => node.datasetId)))].sort();
        await authorization.lockReadResources(trx, { modelIds: models, datasetIds: datasets });
        for (const entry of entries) {
            const current = await authorization.authorize(trx, entry);
            if (entry.beforeSend) await entry.beforeSend(trx, current);
        }
        // 回调必须同步调度响应字节；异步准备工作必须在进入交付栅栏之前完成。
        return send(value);
    });
}

function handler(fn) {
    return asyncHandler(async (req, res, next) => {
        const original = res.json;
        let pending = false, value;
        res.json = function capture(body) { pending = true; value = body; return this; };
        try { await fn(req, res, next); }
        catch (error) { if (res.locals) res.locals.analysisErrorCode = error.code; throw error; }
        finally { res.json = original; }
        if (pending && !res.headersSent) {
            if (descriptors(value).length) res.setHeader('Cache-Control', 'private, no-store');
            try { await consume(value, body => original.call(res, body)); }
            catch (error) { if (res.locals) res.locals.analysisErrorCode = error.code; throw error; }
        }
    });
}

module.exports = { protect, inherit, consume, handler };
