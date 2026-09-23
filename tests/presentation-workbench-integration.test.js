const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };
const {
    createPresentation,
    createPresentationExport,
    deletePresentation,
    getPresentation,
    listPresentationExports,
    listPresentationVersions,
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
        presentation = await createPresentation(user, { title: 'PPT 服务集成验证', templateId: 'business-blue' });
        assert.equal(presentation.title, 'PPT 服务集成验证');
        assert.equal(presentation.version, 1);
        assert.ok(presentation.artifactId);

        const changed = JSON.parse(JSON.stringify(presentation.content));
        changed.slides[0].elements[1].content.text = '已保存到 PostgreSQL 的结构化演示文稿，请填写发布范围';
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
        assert.equal(loaded.content.slides[0].elements[1].content.text, '已保存到 PostgreSQL 的结构化演示文稿，请填写发布范围');

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
        assert.equal(Number(presentationRow.rows[0].current_version), 2);
        const renditionRow = await pool().query('SELECT format, storage_ref, ir_ref FROM agent_artifact_renditions WHERE id = $1', [exported.rendition.id]);
        assert.equal(renditionRow.rows[0].format, 'pptx');
        assert.match(renditionRow.rows[0].storage_ref, /^artifact-cas:\/\/[0-9a-f]{16,64}$/);
        assert.match(renditionRow.rows[0].ir_ref, /^artifact-cas:\/\/[0-9a-f]{16,64}$/);
        const deliveryEvent = await pool().query('SELECT decision_reason FROM agent_artifact_delivery_events WHERE rendition_id = $1 AND event_type = $2', [exported.rendition.id, 'presentation_render']);
        assert.match(String(deliveryEvent.rows[0].decision_reason || ''), /建议修复项/);

        const otherUser = { ...user, id: user.id + 999999 };
        assert.equal(await getPresentation(otherUser, presentation.id), null);
    } finally {
        // 业务删除是软删除；测试需要删除关联 export/version 行后再清理 Artifact，
        // 否则 rendition 的 RESTRICT 外键会刻意阻止直接删除审计产物。
        if (presentation?.id) {
            await deletePresentation(user, presentation.id).catch(() => {});
            await pool().query('DELETE FROM presentation_documents WHERE client_id = $1', [presentation.id]);
        }
        await pool().query('DELETE FROM agent_artifacts WHERE user_id = $1', [user.id]);
        await pool().query('DELETE FROM agent_artifact_objects WHERE owner_user_id = $1', [user.id]);
        await pool().query('DELETE FROM users WHERE id = $1', [user.id]);
        await pool().query('DELETE FROM organizations WHERE id = $1', [tenantId]);
    }
});
