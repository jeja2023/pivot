'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
function compute(rows, config) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'transaction-worker.js'), { workerData: { rows, config }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
        let settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timeout); void worker.terminate(); if (error) reject(error); else resolve(result); };
        const timeout = setTimeout(() => finish(Object.assign(new Error('交易规则计算超时，请缩小数据范围。'), { expose: true, status: 408 })), 60000).unref();
        worker.on('message', message => finish(message.error ? Object.assign(new Error(message.error), { expose: true, status: 422 }) : null, message.result));
        worker.on('error', () => finish(Object.assign(new Error('交易计算工作进程不可用或资源不足，请缩小数据范围。'), { expose: true, status: 503 })));
        worker.on('exit', () => { if (!settled) finish(new Error('交易计算工作进程提前退出。')); });
    });
}
module.exports = { compute };
