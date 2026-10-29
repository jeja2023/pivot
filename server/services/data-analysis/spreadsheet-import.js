'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

function importSpreadsheetInWorker(filePath, originalName, parquetPath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'spreadsheet-import-worker.js'), {
            workerData: { filePath, originalName, parquetPath }
        });
        let settled = false;
        function finish(error, result) {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(result);
        }
        worker.once('message', message => {
            if (message.error) {
                const error = new Error(message.error.message);
                if (message.error.status) error.status = message.error.status;
                finish(error);
            } else finish(null, message.result);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => {
            if (!settled) finish(new Error(`表格导入工作线程提前退出（${code}）。`));
        });
    });
}
module.exports = { importSpreadsheetInWorker };
