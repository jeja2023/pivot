const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const { createPresentationsRouter } = require('../server/routes/apps/presentations');

function source(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('PPT 应用在应用中心、按需脚本和受控模块 API 之间完整接线', () => {
    const registry = source('client/chat/apps-workbench-core.js');
    const scripts = source('client/chat/app-workspaces.js');
    const workspace = source('client/chat/partials/workspaces/apps.html');
    const editor = source('client/chat/apps-workbench-presentations.js');
    assert.match(registry, /id:\s*'presentations'/);
    assert.match(registry, /showPresentationsAppFromRegistry/);
    assert.match(scripts, /apps-workbench-presentations\.js/);
    assert.match(workspace, /id="presentations-view"/);
    assert.match(workspace, /id="presentation-export-pptx-btn"/);
    assert.match(workspace, /id="presentation-template-package-input"/);
    assert.match(editor, /exposeModule\?\.\('apps\.presentations'/);
    assert.doesNotMatch(editor, /window\.Pivot\.legacy\.showPresentationsApp\s*=/);
});

test('PPT API 提供文稿、版本、素材、模板包、AI、检查与导出端点', () => {
    const passthrough = (_req, _res, next) => next?.();
    const upload = { single: () => passthrough };
    const router = createPresentationsRouter({ authMiddleware: passthrough, logAction: () => {}, uploadLimiter: passthrough, upload });
    const routes = router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods).join(',')}:${layer.route.path}`);
    [
        'get:/apps/presentations',
        'post:/apps/presentations',
        'post:/apps/presentations/templates/import',
        'get:/apps/presentations/templates/:id/package',
        'post:/apps/presentations/ai/outline',
        'post:/apps/presentations/ai/slides',
        'post:/apps/presentations/data-chart',
        'put:/apps/presentations/:id/content',
        'post:/apps/presentations/:id/rollback',
        'post:/apps/presentations/:id/export'
    ].forEach(expected => assert.ok(routes.includes(expected), `missing ${expected}`));
});

test('PPT 迁移建立版本、模板、素材和导出审计业务表', () => {
    const migration = source('server/db/migrations/presentation-workbench.js');
    ['presentation_documents', 'presentation_versions', 'presentation_templates', 'presentation_assets', 'presentation_exports']
        .forEach(table => assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`)));
    assert.match(migration, /tenant_id BIGINT NOT NULL/);
    assert.match(migration, /owner_user_id BIGINT NOT NULL/);
    assert.match(migration, /202609220001_presentation_workbench_foundation/);
});
