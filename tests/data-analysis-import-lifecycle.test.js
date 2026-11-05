'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { importSpreadsheetInWorker } = require('../server/services/data-analysis/spreadsheet-import');

test('取消导入会等待线程停止后再返回，已经取消的请求不会创建线程', async () => {
    let created = 0; let stopped = false; let complete;
    class Worker extends EventEmitter {
        constructor() { super(); created += 1; }
        terminate() { return new Promise(resolve => { complete = () => { stopped = true; resolve(); }; }); }
    }
    const controller = new AbortController();
    const pending = importSpreadsheetInWorker('input.xlsx', 'input.xlsx', 'output.parquet', { signal: controller.signal, WorkerClass: Worker });
    const rejected = assert.rejects(pending, error => error.code === 'ANALYSIS_IMPORT_CANCELLED' && stopped);
    controller.abort(); assert.equal(stopped, false); complete(); await rejected;
    await assert.rejects(importSpreadsheetInWorker('input.xlsx', 'input.xlsx', 'output.parquet', { signal: controller.signal, WorkerClass: Worker }), error => error.code === 'ANALYSIS_IMPORT_CANCELLED');
    assert.equal(created, 1);
});

test('超时导入终止线程并返回可操作提示，不无限占用导入资源', async () => {
    let stopped = false;
    class Worker extends EventEmitter { async terminate() { stopped = true; } }
    const alive = setTimeout(() => {}, 2000);
    try {
        await assert.rejects(importSpreadsheetInWorker('input.xlsx', 'input.xlsx', 'output.parquet', { timeoutMs: 1000, WorkerClass: Worker }), error => error.code === 'ANALYSIS_IMPORT_TIMEOUT' && /CSV/.test(error.message));
        assert.equal(stopped, true);
    } finally { clearTimeout(alive); }
});
