const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const { createPdfToolsRouter } = require('../server/routes/apps/pdf-tools');

test('PDF 工具路由提供能力、预检、版本处理、分发与受控资源端点', () => {
    const passthrough = (_req, _res, next) => next?.();
    const router = createPdfToolsRouter({
        authMiddleware: passthrough,
        uploadLimiter: passthrough,
        upload: { array: () => passthrough },
        logAction: () => {}
    });
    const routes = router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods).join(',')}:${layer.route.path}`);
    [
        'get:/capabilities',
        'get:/jobs',
        'post:/jobs',
        'get:/jobs/:id',
        'get:/jobs/:id/preflight',
        'post:/jobs/:id/retry',
        'post:/jobs/:id/reprocess',
        'post:/jobs/:id/dispatch',
        'post:/jobs/:id/cancel',
        'delete:/jobs/:id',
        'get:/jobs/:id/outputs/download',
        'get:/outputs/:id/download',
        'get:/pages/:id/image'
    ].forEach(expected => assert.ok(routes.includes(expected), `缺少 ${expected}`));
});

test('PDF 产品升级包含隔离凭据、严格校验和工作区接线', () => {
    const jobs = fs.readFileSync(path.join(root, 'server/services/document-processing/jobs.js'), 'utf8');
    const validation = fs.readFileSync(path.join(root, 'server/services/document-processing/pdf/validation.js'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'client/chat/apps-workbench-pdf-tools.js'), 'utf8');
    const migration = fs.readFileSync(path.join(root, 'server/db/migrations/pdf-tool-product-upgrade.js'), 'utf8');
    assert.match(jobs, /storeJobPassword/);
    assert.match(jobs, /dispatchPdfJobResult/);
    assert.match(jobs, /document_job_items/);
    assert.match(validation, /INVALID_PAGE_ORDER/);
    assert.match(validation, /UNSUPPORTED_INPUT_COUNT/);
    assert.match(client, /pdf-preset-select/);
    assert.match(client, /pdf-page-preview-panel/);
    assert.match(client, /data-pdf-output-dispatch/);
    ['document_job_items', 'document_job_secrets', 'document_artifact_refs'].forEach(table => assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`)));
});
