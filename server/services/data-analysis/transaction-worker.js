'use strict';
const { parentPort, workerData } = require('node:worker_threads');
try { parentPort.postMessage({ result: require('./transaction-engine').analyze(workerData.rows, workerData.config) }); }
catch (error) { parentPort.postMessage({ error: error.expose ? error.message : '交易规则计算失败，请检查数据。' }); }
