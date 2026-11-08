'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const service = require('../server/services/presentations/presentation-service');
const catalog = require('../server/services/presentations/presentation-template-catalog');
const { assertTenantContext } = require('../server/services/agent-tenant-context');

test('统一目录沿用单位模板授权，下架后不用于新制作，历史版本继续可解析', { skip: !process.env.DATABASE_URL }, async () => {
    const owner = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const tenant = await assertTenantContext(owner), suffix = crypto.randomBytes(6).toString('hex');
    const row = await queryOne("INSERT INTO users(username,password_hash,role,status,unit) VALUES(?,'hash','user','active','验收') RETURNING *", ['catalog_' + suffix]);
    const user = { ...row, tenant_id: tenant.tenantId };
    const definition = require('../server/services/presentations/presentation-templates').getBuiltInTemplate('executive-clean');
    let template;
    try {
        assert.equal((await catalog.list(owner)).canManageTemplates, true); assert.equal((await catalog.list(user)).canManageTemplates, false);
        template = await service.createPresentationTemplate(owner, { name: '单位模板验收-' + suffix, scope: 'organization', definition });
        assert.ok(!(await catalog.list(user)).templates.some(item => item.id === template.id));
        await execute("UPDATE presentation_templates SET status='published' WHERE client_id=? AND owner_user_id=?", [template.id, owner.id]);
        assert.ok((await catalog.list(user)).templates.some(item => item.id === template.id && item.catalogGroup === 'organization'));
        const allowed = await service.resolveTemplateVersionForUser(user, template.id, 1, { forCreation: true }); assert.equal(allowed.version, 1);
        await execute("UPDATE presentation_templates SET status='unpublished' WHERE client_id=? AND owner_user_id=?", [template.id, owner.id]);
        assert.equal(await service.resolveTemplateVersionForUser(user, template.id, 1, { forCreation: true }), null);
        assert.ok(await service.resolveTemplateVersionForUser(user, template.id, 1, { historical: true }));
        assert.ok(!(await catalog.list(user)).templates.some(item => item.id === template.id));
        await execute("UPDATE presentation_templates SET scope='private',status='published' WHERE client_id=? AND owner_user_id=?", [template.id, owner.id]);
        assert.equal(await service.resolveTemplateVersionForUser(user, template.id, 1, { forCreation: true }), null);
        assert.ok((await catalog.list(owner)).templates.some(item => item.id === template.id));
    } finally {
        if (template) await execute('DELETE FROM presentation_templates WHERE client_id=? AND owner_user_id=?', [template.id, owner.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
});
