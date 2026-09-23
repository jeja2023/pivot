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
