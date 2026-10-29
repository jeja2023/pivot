'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { readSpreadsheet } = require('./datasets');
const { createParquetFromRows } = require('./shared');

async function run() {
    const parsed = await readSpreadsheet(workerData.filePath, workerData.originalName);
    await createParquetFromRows(parsed.columns, parsed.rows, workerData.parquetPath);
    const { rows, ...metadata } = parsed;
    return { ...metadata, rowCount: rows.length };
}
run().then(result => parentPort.postMessage({ result })).catch(error => {
    parentPort.postMessage({ error: { message: String(error.message || '表格导入失败。'), status: error.status } });
});
