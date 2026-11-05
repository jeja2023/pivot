'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

function importSpreadsheetInWorker(filePath, originalName, parquetPath, { timeoutMs = 300000, signal = null, WorkerClass = Worker } = {}) {
    return new Promise((resolve, reject) => {
        const failure = (message, code, status) => Object.assign(new Error(message), { code, status });
        if (signal?.aborted) return reject(failure('表格导入已取消，请重新选择文件。', 'ANALYSIS_IMPORT_CANCELLED', 499));
        const worker = new WorkerClass(path.join(__dirname, 'spreadsheet-import-worker.js'), {
            workerData: { filePath, originalName, parquetPath }
        });
        let settled = false;
        const deadline = Math.max(1000, Math.min(Number(timeoutMs) || 300000, 1800000));
        const timer = setTimeout(() => { void finish(failure('表格导入超时，请减少工作表内容或转换为 CSV 后重试。', 'ANALYSIS_IMPORT_TIMEOUT', 504)); }, deadline);
        timer.unref?.();
        const abort = () => { void finish(failure('表格导入已取消，请重新选择文件。', 'ANALYSIS_IMPORT_CANCELLED', 499)); };
        signal?.addEventListener('abort', abort, { once: true });
        async function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            // 等待工作线程退出后才交还文件所有权，防止失败清理与仍在写入的线程竞争。
            try { await worker.terminate(); } catch (_) { /* 线程已退出时继续完成原始请求。 */ }
            if (error) reject(error);
            else resolve(result);
        }
        worker.once('message', message => {
            if (message.error) {
                const error = new Error(message.error.message);
                if (message.error.status) error.status = message.error.status;
                void finish(error);
            } else if (message.result) void finish(null, message.result);
            else void finish(failure('表格工作线程没有返回有效结果，请重试。', 'ANALYSIS_IMPORT_RESULT_INVALID', 500));
        });
        worker.once('error', error => { void finish(error); });
        worker.once('exit', code => {
            if (!settled) void finish(new Error(`表格导入工作线程提前退出（${code}）。`));
        });
    });
}
module.exports = { importSpreadsheetInWorker };
