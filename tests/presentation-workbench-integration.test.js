const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };
const {
    createPresentation,
    createPresentationExport,
    createPresentationTemplateImportJob,
    getPresentationTemplateImportJob,
    runPresentationTemplateImportJob,
    cancelPresentationTemplateImportJob,
    deletePresentation,
    getPresentation,
    listPresentationExports,
    listPresentationVersions,
    reviewPresentationSlide,
    savePresentationContent
} = require('../server/services/presentations/presentation-service');

function pool() {
    return require('../server/db/pg-connection').getPgPool();
}

async function createTenantScopedUser() {
    const suffix = crypto.randomBytes(6).toString('hex');
    const tenant = await pool().query(
        "INSERT INTO organizations (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
        ['PPT 集成测试组织 ' + suffix, 'ppt-integration-' + suffix]
    );
    const username = 'ppt_integration_' + suffix;
    const user = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', 'admin', 'active', NOW()) RETURNING id",
        [username]
    );
    return {
        tenantId: Number(tenant.rows[0].id),
        user: { id: Number(user.rows[0].id), username, role: 'admin', tenant_id: Number(tenant.rows[0].id) }
    };
}

test('PPT 文稿服务在 PostgreSQL 中保存版本、渲染受控产物并保持所有者隔离', skipWithoutDatabase, async () => {
    const { tenantId, user } = await createTenantScopedUser();
    let presentation;
    try {
        presentation = await createPresentation(user, {
            title: 'PPT 服务集成验证', templateId: 'business-blue',
            planApproval: { outline: { title: 'PPT 服务集成验证', outline: [{ section: '概览', slides: [{ title: '封面', purpose: '说明主题', layoutHint: 'cover', keyPoints: [], sourceRefs: [] }] }] } }
        });
        assert.equal(presentation.title, 'PPT 服务集成验证');
        assert.equal(presentation.version, 1);
        assert.ok(presentation.artifactId);
        assert.equal(presentation.content.metadata.planApproval.status, 'approved');
        assert.equal(presentation.content.metadata.planApproval.approvedBy, String(user.id));

        const changed = JSON.parse(JSON.stringify(presentation.content));
        const subtitleEl = changed.slides[0].elements.find(item => item.id === 'subtitle') || changed.slides[0].elements.find(item => item.type === 'text' && item.id !== 'title');
        assert.ok(subtitleEl && subtitleEl.content, '封面页应包含可编辑副标题或正文元素');
        subtitleEl.content.text = '已保存到 PostgreSQL 的结构化演示文稿，请填写发布范围';
        const saved = await savePresentationContent(user, presentation.id, {
            baseVersion: presentation.version,
            title: 'PPT 服务集成验证',
            content: changed,
            note: '集成测试保存版本'
        });
        assert.equal(saved.version, 2);

        const versions = await listPresentationVersions(user, presentation.id);
        assert.deepEqual(versions.map(item => item.version), [2, 1]);
        const loaded = await getPresentation(user, presentation.id);
        const loadedSubtitle = loaded.content.slides[0].elements.find(item => item.id === 'subtitle') || loaded.content.slides[0].elements.find(item => item.type === 'text' && item.id !== 'title');
        assert.equal(loadedSubtitle?.content?.text, '已保存到 PostgreSQL 的结构化演示文稿，请填写发布范围');
        assert.equal(loaded.content.metadata.planApproval.approvedBy, String(user.id));

        const slideId = loaded.content.slides[0].id;
        const reviewed = await reviewPresentationSlide(user, presentation.id, slideId, true);
        assert.equal(reviewed.content.slides[0].review.status, 'approved');
        const tampered = JSON.parse(JSON.stringify(reviewed.content));
        tampered.slides[0].review = { status: 'draft', approvedAt: '', approvedBy: '' };
        const resaved = await savePresentationContent(user, presentation.id, { baseVersion: reviewed.version, title: reviewed.title, content: tampered, note: '普通保存不得解除批准' });
        assert.equal(resaved.content.slides[0].review.status, 'approved');

        const exported = await createPresentationExport(user, presentation.id, 'pptx');
        assert.equal(exported.reused, false);
        assert.equal(exported.rendition.format, 'pptx');
        assert.equal(exported.rendition.status, 'ready');
        const exports = await listPresentationExports(user, presentation.id);
        assert.equal(exports.length, 1);
        assert.equal(exports[0].renditionId, Number(exported.rendition.id));

        const presentationRow = await pool().query('SELECT tenant_id, owner_user_id, current_version FROM presentation_documents WHERE client_id = $1', [presentation.id]);
        assert.equal(Number(presentationRow.rows[0].tenant_id), tenantId);
        assert.equal(Number(presentationRow.rows[0].owner_user_id), user.id);
        assert.equal(Number(presentationRow.rows[0].current_version), 3);
        const renditionRow = await pool().query('SELECT format, storage_ref, ir_ref FROM agent_artifact_renditions WHERE id = $1', [exported.rendition.id]);
        assert.equal(renditionRow.rows[0].format, 'pptx');
        assert.match(renditionRow.rows[0].storage_ref, /^artifact-cas:\/\/[0-9a-f]{16,64}$/);
        assert.match(renditionRow.rows[0].ir_ref, /^artifact-cas:\/\/[0-9a-f]{16,64}$/);
        const deliveryEvent = await pool().query('SELECT decision_reason FROM agent_artifact_delivery_events WHERE rendition_id = $1 AND event_type = $2', [exported.rendition.id, 'presentation_render']);
        assert.match(String(deliveryEvent.rows[0].decision_reason || ''), /建议修复项/);

        const packageBuffer = Buffer.from(JSON.stringify({
            schemaVersion: '2.0', kind: 'pivot-presentation-template',
            template: {
                name: '集成测试导入模板', aspectRatio: '16:9',
                definition: { schemaVersion: '2.0', theme: {}, masters: [{ id: 'master_1', background: { fill: '#FFFFFF' }, decorations: [] }], layouts: [{ id: 'layout_1', masterId: 'master_1', slots: ['title'], placeholders: [{ id: 'slot_title', role: 'title', kind: 'text', x: 80, y: 80, width: 1000, height: 100, style: { fontSize: 32, color: '#1F2937' }, required: true }] }] }
            }
        }));
        const importJob = await createPresentationTemplateImportJob(user, packageBuffer, { filename: '集成测试模板.json', mimeType: 'application/json', scope: 'private' });
        assert.equal(importJob.status, 'queued');
        const completedJob = await runPresentationTemplateImportJob(user, importJob.id);
        assert.equal(completedJob.status, 'completed');
        assert.ok(completedJob.templateId);
        assert.equal((await getPresentationTemplateImportJob(user, importJob.id)).template?.definition?.schemaVersion, '2.0');

        const cancelledJob = await createPresentationTemplateImportJob(user, packageBuffer, { filename: '取消导入模板.json', mimeType: 'application/json', scope: 'private' });
        assert.equal((await cancelPresentationTemplateImportJob(user, cancelledJob.id)).status, 'cancelled');

        const otherUser = { ...user, id: user.id + 999999 };
        assert.equal(await getPresentation(otherUser, presentation.id), null);
    } finally {
        // 业务删除是软删除；测试需要删除关联 export/version 行后再清理 Artifact，
        // 否则 rendition 的 RESTRICT 外键会刻意阻止直接删除审计产物。
        if (presentation?.id) {
            await deletePresentation(user, presentation.id).catch(() => {});
            await pool().query('DELETE FROM presentation_documents WHERE client_id = $1', [presentation.id]);
        }
        await pool().query('DELETE FROM presentation_template_import_jobs WHERE tenant_id = $1', [tenantId]);
        await pool().query('DELETE FROM presentation_templates WHERE tenant_id = $1', [tenantId]);
        await pool().query('DELETE FROM agent_artifacts WHERE user_id = $1', [user.id]);
        await pool().query('DELETE FROM agent_artifact_objects WHERE owner_user_id = $1', [user.id]);
        await pool().query('DELETE FROM users WHERE id = $1', [user.id]);
        await pool().query('DELETE FROM organizations WHERE id = $1', [tenantId]);
    }
});
