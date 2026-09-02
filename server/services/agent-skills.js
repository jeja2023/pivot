const crypto = require('crypto');
const yaml = require('js-yaml');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { assertRegisteredCapabilities, normalizeCapabilityList } = require('./agent-capability-registry');
const { toLegacyScope } = require('./agent-skill-scope');
const { withControlPlaneFallback } = require('./agent-control-plane-state');

function parseSkillManifest(value) {
    if (value && typeof value === 'object') return JSON.parse(JSON.stringify(value));
    const text = String(value || '').trim();
    if (!text) return {};
    try {
        const parsed = yaml.load(text, { json: false });
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        error.code = error.code || 'AGENT_SKILL_MANIFEST_PARSE_ERROR';
        throw error;
    }
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function normalizeDigest(value) { return String(value || '').replace(/^sha256:/i, '').toLowerCase(); }

/**
 * 校验 Skill 清单。
 * 落地方案 v1.2 §5.1：字段名由 permissions 收敛为 capabilities，取值必须是能力注册表中的
 * 真实 capability；permissions 作为历史字段仍被接受，但同样要过注册表校验。
 * strictSpec=true 时按 §5.1 第 2 条施加完整必填校验（SKILL.md 导入与发布门禁使用）。
 */
function validateSkillManifest(manifestValue, options = {}) {
    let manifest;
    try { manifest = parseSkillManifest(manifestValue); } catch (error) {
        return { valid: false, errors: [`SKILL.yaml 解析失败：${error.message}`], manifest: {}, permissions: [], capabilities: [], tools: [], computedDigest: '' };
    }
    const errors = [];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/.test(String(manifest.id || ''))) errors.push('manifest.id 必须是稳定的技能标识。');
    if (!String(manifest.name || '').trim()) errors.push('manifest.name 不能为空。');
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))) errors.push('manifest.version 必须符合 SemVer。');
    if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) errors.push('manifest.capabilities 必须是数组。');
    if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) errors.push('manifest.permissions 必须是数组。');
    if (manifest.tools !== undefined && !Array.isArray(manifest.tools)) errors.push('manifest.tools 必须是数组。');
    const declared = Array.isArray(manifest.capabilities)
        ? manifest.capabilities.map(String)
        : Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
    const capabilities = normalizeCapabilityList(declared);
    const tools = Array.isArray(manifest.tools) ? manifest.tools.map(String) : [];
    const registryCheck = assertRegisteredCapabilities(capabilities);
    registryCheck.unknown.forEach(item => errors.push(`技能声明了未登记的能力：${item}`));
    const allowed = Array.isArray(options.allowedPermissions) ? new Set(options.allowedPermissions.map(String)) : null;
    if (allowed) capabilities.filter(item => !allowed.has(item)).forEach(item => errors.push(`技能权限未获授权：${item}`));
    const allowedTools = Array.isArray(options.allowedTools) ? new Set(options.allowedTools.map(String)) : null;
    if (allowedTools) tools.filter(item => !allowedTools.has(item)).forEach(item => errors.push(`技能工具未获授权：${item}`));
    if (options.strictSpec === true) {
        if (Number.parseInt(manifest.schemaVersion, 10) !== 1) errors.push('manifest.schemaVersion 必须为 1。');
        if (!capabilities.length) errors.push('manifest.capabilities 不能为空，未声明能力的技能没有任何工具调用权。');
        if (!tools.length) errors.push('manifest.tools 不能为空，未声明工具的技能没有任何工具调用权。');
        if (!manifest.inputs || typeof manifest.inputs !== 'object' || Array.isArray(manifest.inputs)) errors.push('manifest.inputs 必须是对象。');
        if (!manifest.outputs || typeof manifest.outputs !== 'object' || Array.isArray(manifest.outputs)) errors.push('manifest.outputs 必须是对象。');
        if (manifest.scope !== undefined) errors.push('manifest.scope 不再被接受，作用域由发布动作决定。');
    }
    const digest = normalizeDigest(manifest.digest);
    const unsigned = { ...manifest }; delete unsigned.digest; delete unsigned.signature;
    const computedDigest = sha256(canonicalJson(unsigned));
    if (digest && digest !== computedDigest) errors.push('技能清单 digest 校验失败。');
    return { valid: errors.length === 0, errors, manifest, permissions: capabilities, capabilities, tools, computedDigest };
}

function buildSkillExecutionContext(manifestValue) {
    const checked = validateSkillManifest(manifestValue);
    if (!checked.valid) {
        const error = new Error(`Skill 清单校验失败：${checked.errors.join('；')}`);
        error.code = 'AGENT_SKILL_INVALID';
        error.details = checked;
        throw error;
    }
    return {
        skillId: String(checked.manifest.id),
        skillVersion: String(checked.manifest.version),
        skillCapabilities: checked.capabilities,
        skillPermissions: checked.capabilities,
        skillTools: checked.tools
    };
}

function verifySkillSignature(manifestValue, options = {}) {
    const manifest = parseSkillManifest(manifestValue);
    if (!manifest.signature || !options.publicKey) return { verified: false, reason: 'unsigned' };
    try {
        const verifier = crypto.createVerify(options.algorithm || 'RSA-SHA256');
        const unsigned = { ...manifest }; delete unsigned.signature;
        verifier.update(canonicalJson(unsigned)); verifier.end();
        return { verified: verifier.verify(options.publicKey, Buffer.from(String(manifest.signature), 'base64')) };
    } catch (error) { return { verified: false, reason: error.message }; }
}

/**
 * 直接注册 Skill 的写入路径已关闭。
 * 落地方案 v1.2 §2.4：agent_skills 降级为只读投影（read model），
 * 只能由 release 投影写入，否则会绕过发布门禁（validated → published）。
 */
async function registerAgentSkill() {
    const error = new Error('技能不能直接注册。请创建技能版本、通过验证后再发布，由发布流程写入技能目录。');
    error.status = 409;
    error.statusCode = 409;
    error.expose = true;
    error.code = 'AGENT_SKILL_DIRECT_REGISTER_CLOSED';
    throw error;
}

/**
 * 由 release 单向重建 agent_skills 只读投影。
 * 这是 agent_skills 唯一允许的写入入口，回滚时同样经此重建，避免双表状态分叉（§2.4）。
 */
async function projectSkillReadModel({ version, release, ownerKey = '', tenantId = null, actorUserId = null, status = 'enabled' } = {}) {
    if (!version) return null;
    const manifest = (() => {
        try { return parseSkillManifest(version.manifest_json || version.manifest_yaml || '{}') || {}; } catch (_) { return {}; }
    })();
    const now = getBeijingTimestamp();
    const scope = toLegacyScope(release?.rollout_scope || 'personal');
    const effectiveOwnerKey = String(ownerKey || release?.owner_key || version.owner_key || '').trim();
    if (!effectiveOwnerKey) throw new Error('Skill 投影缺少权威 ownerKey。');
    // 一个个人版本可在后续被批准发布到组织/团队；投影表按 ownerKey 分行，
    // 因此不能继续复用 source skill_id 作为全局主键，否则个人与共享投影互相冲突。
    const sourceSkillId = String(version.skill_id || manifest.id || version.name);
    const projectionId = `skill:${sha256(`${sourceSkillId}:${effectiveOwnerKey}`).slice(0, 56)}`;
    await execute(`
        INSERT INTO agent_skills (id, name, version, title, description, publisher, digest, manifest_yaml, instructions_md, scope, user_id, owner_key, tenant_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_key, name) DO UPDATE SET
            id = excluded.id, version = excluded.version, title = excluded.title, description = excluded.description,
            publisher = excluded.publisher, digest = excluded.digest, manifest_yaml = excluded.manifest_yaml,
            instructions_md = excluded.instructions_md, scope = excluded.scope, tenant_id = excluded.tenant_id,
            status = excluded.status, updated_at = excluded.updated_at
    `, [
        projectionId,
        String(version.name).slice(0, 128),
        String(version.version),
        String(manifest.title || version.name).slice(0, 255),
        String(manifest.description || '').slice(0, 2000),
        String(manifest.publisher || '').slice(0, 128),
        String(version.digest || ''),
        version.manifest_yaml,
        version.instructions_md || '',
        scope,
        Number.parseInt(version.created_by ?? actorUserId, 10) || null,
        effectiveOwnerKey,
        tenantId ?? version.tenant_id ?? null,
        status === 'disabled' ? 'disabled' : 'enabled',
        now,
        now
    ]);
    return await queryOne('SELECT * FROM agent_skills WHERE owner_key = ? AND name = ?', [effectiveOwnerKey, String(version.name)]);
}

/**
 * 解析 Skill 执行上下文并生成 PEP 可用的约束结构。
 * skillConstraints 是 PEP 认可的唯一权威结构，必须由服务端写入 run metadata，
 * 调用方自报的同名键会在 run 创建时被剥离（见 agent-runtime/run-creation.js）。
 */
async function getAgentSkillExecutionContext(user, reference) {
    const value = String(reference || '').trim();
    if (!value) return null;
    const { resolvePublishedSkill } = require('./agent-releases');
    const release = await resolvePublishedSkill(value, user);
    if (release) {
        const context = buildSkillExecutionContext(release.manifest_yaml);
        const legacyUnrestricted = release.legacy_unrestricted === true || release.legacy_unrestricted === 1;
        return {
            ...context,
            skillName: release.name,
            skillVersion: release.version,
            skillTitle: release.title || context.skillId,
            skillInstructions: String(release.instructions_md || '').slice(0, 16000),
            skillScope: release.rollout_scope,
            releaseId: release.id,
            skillVersionId: release.skill_version_id,
            tenantId: release.tenant_id ?? null,
            rolloutPercent: Number(release.rollout_percent || 100),
            skillConstraints: {
                present: true,
                reference: context.skillId,
                capabilities: context.skillCapabilities,
                tools: context.skillTools,
                legacyUnrestricted,
                legacyUnrestrictedUntil: legacyUnrestricted ? String(release.legacy_unrestricted_until || '') : ''
            }
        };
    }
    const configured = await withControlPlaneFallback(
        () => queryOne("SELECT id FROM agent_skill_releases WHERE name = ? AND status = 'published' LIMIT 1", [value]),
        null
    );
    if (configured) {
        const error = new Error('Skill 当前未命中灰度范围或没有可用发布版本。');
        error.code = 'AGENT_SKILL_ROLLOUT_EXCLUDED';
        error.status = 403;
        throw error;
    }
    const error = new Error('Skill 不存在、未发布或当前用户未命中灰度范围。');
    error.code = 'AGENT_SKILL_FORBIDDEN';
    error.status = 403;
    throw error;
}

/**
 * 技能目录列表。
 * 落地方案 v1.2 阶段 1.3：共享范围（shared/global 投影值）必须叠加租户过滤，
 * 否则普通用户自建技能会出现在全平台所有用户的列表中（A2 越权链的一环）。
 * 企业访问开启且租户不可解析时，只返回本人技能，不返回任何共享技能。
 */
async function listAgentSkillsForUser(user, options = {}) {
    const includeDisabled = options.includeDisabled === true;
    const columns = 'id, name, version, title, description, publisher, digest, scope, user_id, tenant_id, status, created_at, updated_at';
    // agent_skills 只是 read model，不能以它自身的 scope/status 独立做授权。
    // 先由权威 release 控制面完成租户、团队、ACL 与灰度判定，再回查投影补齐展示字段。
    const { listSkillCatalogForUser, listSkillReleasesForUser } = require('./agent-releases');
    const releases = includeDisabled
        ? await listSkillReleasesForUser(user, { limit: 500 })
        : await listSkillCatalogForUser(user, { limit: 500 });
    const rows = await Promise.all((releases || []).map(release => withControlPlaneFallback(() => queryOne(`
        SELECT ${columns}
        FROM agent_skills
        WHERE owner_key = ? AND name = ? AND tenant_id = ?
        ${includeDisabled ? '' : "AND status = 'enabled'"}
        ORDER BY updated_at DESC
        LIMIT 1
    `, [release.owner_key, release.name, release.tenant_id]), null)));
    return rows.filter(Boolean).slice(0, 500);
}

/** Select the user's best learned personal Skill for a goal without widening permissions. */
async function findBestPersonalSkill(user, goal, options = {}) {
    const text = String(goal || '').trim().toLowerCase();
    if (!text || !user?.id) return null;
    const { listSkillReleasesForUser } = require('./agent-releases');
    const releases = await listSkillReleasesForUser(user, { limit: 200 });
    const ownerKey = `user:${Number(user.id)}`;
    const terms = text.split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter(item => item.length > 1).slice(0, 40);
    const chineseBigrams = [...text.replace(/[^\u4e00-\u9fa5]/g, '')].flatMap((character, index, chars) => index < chars.length - 1 ? [`${character}${chars[index + 1]}`] : []).slice(0, 60);
    const candidates = (releases || []).filter(release => release.owner_key === ownerKey && release.rollout_scope === 'personal' && release.status === 'published').map(release => {
        let manifest = {};
        try { manifest = parseSkillManifest(release.manifest_json || release.manifest_yaml || '{}'); } catch (_) {}
        const haystack = [release.name, manifest.title, manifest.description, ...(Array.isArray(manifest.tags) ? manifest.tags : [])].join(' ').toLowerCase();
        const matched = terms.filter(term => haystack.includes(term));
        const bigramHits = [...new Set(chineseBigrams.filter(term => haystack.includes(term)))];
        const score = matched.length * 2 + Math.min(bigramHits.length, 6) + (manifest.tags || []).filter(tag => text.includes(String(tag).toLowerCase())).length;
        return { release, manifest, matched, score };
    }).filter(item => item.score >= Number(options.minScore || 2)).sort((a, b) => b.score - a.score || String(b.release.published_at || '').localeCompare(String(a.release.published_at || '')));
    return candidates[0]?.release || null;
}

async function disableAgentSkill(name, user) {
    // agent_skills 已降级为 release 投影，停用必须通过权威 release 状态变更，
    // 禁止直接写投影造成“目录已停用、运行时仍可解析”的双表分叉。
    const safeName = String(name || '').trim();
    if (!safeName || !user?.id) return null;
    const { getSkillReleaseForUser, pauseSkillRelease } = require('./agent-releases');
    const releases = await query(
        "SELECT id FROM agent_skill_releases WHERE name = ? AND status = 'published' ORDER BY published_at DESC",
        [safeName]
    );
    for (const candidate of releases || []) {
        const release = await getSkillReleaseForUser(candidate.id, user, 'manage');
        if (release) return pauseSkillRelease(release.id, user, 'user_disabled');
    }
    return null;
}

module.exports = {
    canonicalJson,
    buildSkillExecutionContext,
    disableAgentSkill,
    findBestPersonalSkill,
    listAgentSkillsForUser,
    getAgentSkillExecutionContext,
    parseSkillManifest,
    projectSkillReadModel,
    registerAgentSkill,
    sha256,
    validateSkillManifest,
    verifySkillSignature
};
