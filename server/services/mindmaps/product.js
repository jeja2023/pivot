'use strict';
const schema = require('../../../client/common/mindmap-document');
const documents = require('./documents');
const repository = require('../../repositories/mindmap-product');
async function sharing(user, id) { return repository.sharing(user.id, documents.id(id)); }
async function shareTargets(user) {
    const targets = await require('../share-targets').listShareTargets(user);
    if (!require('../enterprise-access').isEnterpriseAccessEnabled()) return targets;
    const allowed = new Set((await repository.tenantTargetIds(user.id)).map(row => String(row.user_id)));
    return { ...targets, users: targets.users.filter(user => allowed.has(String(user.id))) };
}
async function setSharing(user, id, input = {}) {
    if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || !Array.isArray(input.members) || input.members.length > 50) throw schema.error('共享设置无效，最多授权 50 个账号。');
    const ids = new Set(); const members = input.members.map(member => {
        const userId = documents.id(member?.userId);
        if (ids.has(userId) || String(user.id) === userId || !['viewer','editor'].includes(member.role)) throw schema.error('共享账号或权限无效，请重新选择。'); ids.add(userId); return { userId, role: member.role };
    });
    if (members.length) await require('../share-targets').filterExistingShareUserIds(members.map(member => member.userId).join(','), { excludeUserId: user.id });
    if (input.enabled && require('../enterprise-access').isEnterpriseAccessEnabled()) {
        const ownerTenant = await require('../enterprise-access').getPrimaryTenantId(user.id);
        if (!ownerTenant) throw schema.error('当前账号未归属有效组织，不能开启团队协作。', 'MINDMAP_TENANT_REQUIRED', 403);
        for (const member of members) if (await require('../enterprise-access').getPrimaryTenantId(member.userId) !== ownerTenant) throw schema.error('只能向同一组织内的有效账号授权协作。', 'MINDMAP_TENANT_MISMATCH', 403);
    }
    const result = await repository.setSharing(user.id, documents.id(id), { ...input, expectedVersionId: documents.id(input.expectedVersionId), members });
    require('./events').changed(id); return result;
}
async function settings(user, id, input = {}) {
    if (typeof input.favorite !== 'boolean' || !Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 32 || /[\u0000-\u001f]/.test(tag))) throw schema.error('标签最多 20 个，每个 1–32 字符。');
    return repository.settings(user.id, documents.id(id), { favorite: input.favorite, tags: [...new Set(input.tags.map(tag => tag.trim()))] });
}
async function templates(user) { return repository.templates(user.id); }
async function template(user, id) { return schema.normalize((await repository.template(user.id, String(id))).content); }
async function saveTemplate(user, input = {}) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw schema.error('模板名称应为 1–80 个字符。');
    const document = await documents.get(user, input.artifactId);
    return repository.saveTemplate(user.id, name, document.document);
}
async function removeTemplate(user, id) { return repository.removeTemplate(user.id, String(id)); }
async function recover(user, id) {
    const row = await repository.recover(user.id, documents.id(id));
    if (row.copyRequired) return { ...await documents.save(user, { document: row.document, requestKey: `recover:${id}:copy`, note: '历史版本配额已满，从回收站恢复为个人副本' }), recoveredAsCopy: true };
    return documents.get(user, row.id);
}
async function themes(user) { return require('../../repositories/mindmap-themes').list(user.id); }
async function saveTheme(user, input) { return require('../../repositories/mindmap-themes').save(user.id, schema.themePack(input)); }
async function removeTheme(user, id) { if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw schema.error('主题标识无效。'); return require('../../repositories/mindmap-themes').remove(user.id, id); }
module.exports = { sharing, setSharing, settings, templates, template, saveTemplate, removeTemplate, recover, shareTargets, themes, saveTheme, removeTheme };
