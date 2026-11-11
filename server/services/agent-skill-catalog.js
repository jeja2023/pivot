'use strict';

// LIMIT 仅限制单次读取；权限、灰度和名称折叠后的结果才消耗目录名额。
async function scanSkillReleaseCatalog({ user, tenant, options = {}, filterPage, chooseRelease, teamIds = [], readPage }) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || (options.catalog ? 200 : 100), 500));
    const selected = [];
    const names = new Set();
    let cursor = null;
    for (;;) {
        const page = await readPage({ ownerKey: `user:${Number(user.id)}`, tenantId: tenant.resolvable ? tenant.tenantId : null,
            cursor, name: options.name || '', publishedOnly: options.catalog === true });
        if (!page.length) break;
        const accessible = await filterPage(page);
        for (const release of accessible) {
            if (options.catalog) {
                if (names.has(release.name) || !chooseRelease([release], user, { teamIds })) continue;
                names.add(release.name);
            }
            selected.push(release);
            if (!options.all && selected.length >= limit) return selected;
        }
        const last = page.at(-1);
        cursor = { publishedAt: last.catalog_cursor, id: last.id };
        if (page.length < 200) break;
    }
    return selected;
}

module.exports = { scanSkillReleaseCatalog };
