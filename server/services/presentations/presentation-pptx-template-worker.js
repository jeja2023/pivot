'use strict';

/** 受限 Worker：只解析 PPTX 二进制，不访问数据库、网络或宿主文件路径。 */
const { parentPort } = require('worker_threads');
const { importPptxTemplatePackage } = require('./presentation-pptx-template-import');

parentPort.on('message', async message => {
    try {
        const parsed = await importPptxTemplatePackage(Buffer.from(message?.buffer || []), message?.options || {});
        parentPort.postMessage({ ok: true, parsed });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: {
                message: String(error?.message || 'PPTX 模板解析失败。'),
                code: String(error?.code || 'PRESENTATION_PPTX_TEMPLATE_INVALID'),
                status: Number(error?.status || error?.statusCode || 400)
            }
        });
    }
});
