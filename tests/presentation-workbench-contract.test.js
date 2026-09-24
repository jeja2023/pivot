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
    const presenter = source('client/chat/apps-workbench-presentations-presenter.js');
    assert.match(registry, /id:\s*'presentations'/);
    assert.match(registry, /showPresentationsAppFromRegistry/);
    assert.match(scripts, /apps-workbench-presentations\.js/);
    assert.match(workspace, /id="presentations-view"/);
    assert.match(workspace, /id="presentation-export-pptx-btn"/);
    assert.match(workspace, /id="presentation-template-package-input"/);
    assert.match(workspace, /.pptx/);
    assert.match(workspace, /id="presentation-submit-template-review-btn"/);
    assert.match(workspace, /id="presentation-review-template-btn"/);
    assert.match(workspace, /id="presentation-ai-continue-btn"/);
    assert.match(workspace, /id="presentation-ai-validate-btn"/);
    assert.match(workspace, /id="presentation-ai-stop-btn"/);
    assert.match(workspace, /id="presentation-create-stop-btn"/);
    assert.match(workspace, /id="presentation-outline-stop-btn"/);
    assert.match(workspace, /id="presentation-speaker-notes"/);
    assert.match(workspace, /id="presentation-presenter-modal"/);
    assert.match(workspace, /id="presentation-presenter-btn"/);
    assert.match(workspace, /id="presentation-assets-panel"/);
    assert.match(workspace, /id="presentation-rich-asset-input"/);
    assert.match(workspace, /id="presentation-transition-select"/);
    assert.match(workspace, /id="presentation-remote-start-btn"/);
    assert.match(workspace, /id="presentation-create-from-artifact-btn"/);
    assert.match(workspace, /id="presentation-set-cover-btn"/);
    assert.match(workspace, /id="presentation-element-animation"/);
    assert.match(workspace, /id="presentation-sync-btn"/);
    assert.match(workspace, /id="presentation-outline-markdown"/);
    assert.match(workspace, /演示大纲预览/);
    assert.doesNotMatch(workspace, /id="presentation-outline-editor"/);
    assert.doesNotMatch(workspace, /id="presentation-outline-title-input"/);
    assert.doesNotMatch(workspace, /id="presentation-outline-sections"/);
    assert.match(presenter, /function renderOutlineDocument/);
    assert.match(presenter, /presentation-outline-document-section-title/);
    assert.doesNotMatch(presenter, /function outlineMarkdown/);
    assert.doesNotMatch(presenter, /createElement\('ul'\)/);
    assert.doesNotMatch(presenter, /presentation-outline-page-number/);
    assert.match(editor, /function renderOutlineReview/);
    assert.match(editor, /function collectOutlineFromReview/);
    assert.doesNotMatch(editor, /JSON\.parse\(byId\('presentation-outline-editor'\)/);
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
        'post:/apps/presentations/templates/:id/submit-review',
        'post:/apps/presentations/templates/:id/review',
        'get:/apps/presentations/templates/statistics',
        'get:/apps/presentations/templates/:id/package',
        'post:/apps/presentations/assets/publish',
        'post:/apps/presentations/ai/outline',
        'post:/apps/presentations/ai/slides',
        'post:/apps/presentations/ai/continue',
        'post:/apps/presentations/ai/rewrite',
        'post:/apps/presentations/ai/validate',
        'post:/apps/presentations/data-chart',
        'put:/apps/presentations/:id/content',
        'post:/apps/presentations/:id/rollback',
        'post:/apps/presentations/:id/export',
        'put:/apps/presentations/:id/favorite',
        'get:/apps/presentations/metrics',
        'get:/apps/presentations/remote/:token/state',
        'get:/apps/presentations/remote/:token/assets',
        'post:/apps/presentations/:id/remote-sessions',
        'put:/apps/presentations/remote-sessions/:sessionId/slide',
        'delete:/apps/presentations/remote-sessions/:sessionId',
        'get:/apps/presentations/assets',
        'post:/apps/presentations/from-artifact/:artifactId'
    ].forEach(expected => assert.ok(routes.includes(expected), `missing ${expected}`));
});

test('PPT 迁移建立版本、模板、素材和导出审计业务表', () => {
    const migration = source('server/db/migrations/presentation-workbench.js');
    ['presentation_documents', 'presentation_versions', 'presentation_templates', 'presentation_assets', 'presentation_exports']
        .forEach(table => assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`)));
    assert.match(migration, /tenant_id BIGINT NOT NULL/);
    assert.match(migration, /owner_user_id BIGINT NOT NULL/);
    assert.match(migration, /202609220001_presentation_workbench_foundation/);
    const library = source('server/db/migrations/presentation-library-features.js');
    assert.match(library, /presentation_document_favorites/);
    assert.match(library, /tags_json/);
    const governance = source('server/db/migrations/presentation-product-governance.js');
    assert.match(governance, /202609230002_presentation_product_governance/);
    assert.match(governance, /presentation_ai_requests/);
    assert.match(governance, /pending_review/);
    const organizationControls = source('server/db/migrations/presentation-organization-controls.js');
    const brandAssets = source('server/db/migrations/presentation-brand-assets.js');
    assert.match(organizationControls, /department_name/);
    assert.match(organizationControls, /department/);
    assert.match(brandAssets, /presentation_asset_scope_check/);
    assert.match(brandAssets, /organization/);
    const presentationRoutes = source('server/routes/apps/presentations.js');
    const editor = source('client/chat/apps-workbench-presentations.js');
    assert.match(presentationRoutes, /Idempotency-Key/);
    assert.match(presentationRoutes, /AbortController/);
    assert.match(presentationRoutes, /PRESENTATION_AI_CANCELLED/);
    assert.match(presentationRoutes, /retryMalformedJson:\s*true/);
    assert.match(presentationRoutes, /PRESENTATION_AI_JSON_REPAIR_FAILED/);
    const service = source('server/services/presentations/presentation-service.js');
    assert.match(service, /owner_user_id = ?/);
    assert.match(service, /status IN \('draft', 'pending_review', 'unpublished'\)/);
    assert.match(presentationRoutes, /ON CONFLICT \(tenant_id, user_id, idempotency_key\) DO NOTHING/);
    assert.match(presentationRoutes, /PRESENTATION_AI_REQUEST_IN_PROGRESS/);
    assert.match(editor, /beginAiRequest/);
    assert.match(editor, /continuePresentation/);
    assert.match(editor, /runAiContentValidation/);
    assert.match(editor, /openPresenterMode/);
    assert.match(editor, /renderPresenterMode/);
    assert.match(editor, /movePresenterSlide/);
    assert.match(editor, /startPresentationSync/);
    assert.match(editor, /syncRemotePresentation/);
    assert.match(editor, /远端有更新/);
    const pptxImporter = source('server/services/presentations/presentation-pptx-template-import.js');
    assert.match(pptxImporter, /MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES/);
    assert.match(pptxImporter, /检测到动画或转场/);
    assert.match(presentationRoutes, /importPresentationTemplateFile/);
    assert.match(presentationRoutes, /setPresentationFavorite/);
    assert.match(editor, /presentation-library-search/);
    assert.match(editor, /toggleFavoriteDocument/);
    assert.match(editor, /startPresentationSync/);
    const presentationService = source('server/services/presentations/presentation-service.js');
    assert.match(presentationService, /PRESENTATION_EDIT_FORBIDDEN/);
    assert.match(presentationService, /PRESENTATION_COMMENT_FORBIDDEN/);
    assert.match(presentationService, /assertPresentationEditor\(user, (?:current|currentRow)\)/);
    assert.match(presentationService, /const artifactOwner = Number\(current\.owner_user_id\)/);
    assert.match(presentationService, /presentation_versions.created_by/);
    assert.match(presentationService, /presentation_document_favorites/);
    assert.match(presentationService, /createPresentationRemoteSession/);
    assert.match(presentationService, /PRESENTATION_ASSET_TYPE_MISMATCH/);
    assert.match(editor, /startRemotePresentation/);
    assert.match(editor, /loadPresentationMetrics/);
    const richMedia = source('server/db/migrations/presentation-rich-media.js');
    const remotePresenting = source('server/db/migrations/presentation-remote-presenting.js');
    assert.match(richMedia, /asset_type/);
    assert.match(remotePresenting, /presentation_remote_sessions/);
    assert.match(source('server/services/presentations/presentation-vba.js'), /VBA_RISK_DETECTED/);
    assert.match(presentationService, /createPresentationFromArtifact/);
    assert.match(presentationService, /createPresentationRemoteSession/);
    assert.match(presentationService, /inferPresentationAssetType/);
    assert.match(editor, /startPresentationRealtime/);
    assert.match(editor, /uploadRichAsset/);
    assert.match(editor, /setSelectedImageAsCover/);
});


test('PPT 产品级补齐覆盖完整文稿筛选、高级编辑、导出选项与质量元数据', () => {
    const workspace = source('client/chat/partials/workspaces/apps.html');
    const editor = source('client/chat/apps-workbench-presentations.js');
    const presenter = source('client/chat/apps-workbench-presentations-presenter.js');
    const service = source('server/services/presentations/presentation-service.js');
    const validation = source('server/services/presentations/presentation-validation.js');
    const exporter = source('server/services/presentations/presentation-export-service.js');
    const renderer = source('server/services/presentations/presentation-renderer.js');
    const qualityMigration = source('server/db/migrations/presentation-quality-metadata.js');
    ['presentation-library-created-by', 'presentation-library-template', 'presentation-library-status', 'presentation-library-updated-from', 'presentation-library-updated-to', 'presentation-create-duration', 'presentation-create-language', 'presentation-create-needs-charts', 'presentation-create-retain-sources', 'presentation-create-must-include', 'presentation-create-prohibited-content', 'presentation-copy-element-btn', 'presentation-group-elements-btn', 'presentation-replace-image-btn', 'presentation-table-add-row-btn', 'presentation-export-options-modal'].forEach(id => assert.ok(workspace.includes('id="' + id + '"'), id));
    ['syncLibraryFilters', 'copySelectedElements', 'pasteSelectedElements', 'groupSelectedElements', 'ungroupSelectedElements', 'alignSelectedElements', 'adjustTableStructure', 'replaceSelectedImage', 'saveExportOptions'].forEach(name => assert.ok(editor.includes('function ' + name), name));
    assert.ok(presenter.includes('aspectRatio: options.aspectRatio'));
    assert.match(source('server/routes/apps/presentations.js'), /aspectRatio: req\.body\?\.aspectRatio/);
    assert.ok(service.includes('pixel_width'));
    assert.ok(service.includes('owner.username ILIKE'));
    assert.ok(service.includes('updated_at >= ?::date'));
    ['SOURCE_ATTRIBUTION_MISSING', 'FONT_FALLBACK_RISK', 'IMAGE_LOW_RESOLUTION', 'DATA_SOURCE_MISSING'].forEach(code => assert.ok(validation.includes(code), code));
    assert.ok(exporter.includes('preparePresentationForExport'));
    assert.ok(exporter.includes('includePageNumbers'));
    assert.ok(renderer.includes('LAYOUT_4x3'));
    assert.ok(qualityMigration.includes('pixel_width'));
});
