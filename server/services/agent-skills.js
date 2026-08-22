const crypto = require('crypto');
const yaml = require('js-yaml');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

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

function validateSkillManifest(manifestValue, options = {}) {
    let manifest;
    try { manifest = parseSkillManifest(manifestValue); } catch (error) {
        return { valid: false, errors: [`SKILL.yaml 解析失败：${error.message}`], manifest: {}, permissions: [], tools: [], computedDigest: '' };
    }
    const errors = [];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/.test(String(manifest.id || ''))) errors.push('manifest.id 必须是稳定的技能标识。');
    if (!String(manifest.name || '').trim()) errors.push('manifest.name 不能为空。');
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))) errors.push('manifest.version 必须符合 SemVer。');
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
    const tools = Array.isArray(manifest.tools) ? manifest.tools.map(String) : [];
    if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) errors.push('manifest.permissions 必须是数组。');
    if (manifest.tools !== undefined && !Array.isArray(manifest.tools)) errors.push('manifest.tools 必须是数组。');
    const allowed = Array.isArray(options.allowedPermissions) ? new Set(options.allowedPermissions.map(String)) : null;
    if (allowed) permissions.filter(item => !allowed.has(item)).forEach(item => errors.push(`技能权限未获授权：${item}`));
    const allowedTools = Array.isArray(options.allowedTools) ? new Set(options.allowedTools.map(String)) : null;
    if (allowedTools) tools.filter(item => !allowedTools.has(item)).forEach(item => errors.push(`技能工具未获授权：${item}`));
    const digest = normalizeDigest(manifest.digest);
    const unsigned = { ...manifest }; delete unsigned.digest; delete unsigned.signature;
    const computedDigest = sha256(canonicalJson(unsigned));
    if (digest && digest !== computedDigest) errors.push('技能清单 digest 校验失败。');
    return { valid: errors.length === 0, errors, manifest, permissions, tools, computedDigest };
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
        skillPermissions: checked.permissions,
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

async function registerAgentSkill(user, manifestValue, instructions = '', options = {}) {
    const checked = validateSkillManifest(manifestValue, options);
    if (!checked.valid) {
        const error = new Error(`Skill 清单校验失败：${checked.errors.join('；')}`);
        error.code = 'AGENT_SKILL_INVALID';
        error.details = checked;
        throw error;
    }
    const signature = verifySkillSignature(checked.manifest, options);
    if (options.requireSignature === true && !signature.verified) {
        const error = new Error('Skill 必须提供有效的离线数字签名。');
        error.code = 'AGENT_SKILL_SIGNATURE_REQUIRED';
        throw error;
    }
    const manifest = checked.manifest;
    const now = getBeijingTimestamp();
    const id = String(manifest.id);
    const scope = String(manifest.scope || 'user').toLowerCase();
    if (!['user', 'shared', 'global'].includes(scope)) {
        const error = new Error('Skill scope 只能是 user、shared 或 global。');
        error.code = 'AGENT_SKILL_SCOPE_INVALID';
        throw error;
    }
    if (scope !== 'user' && !['admin', 'root'].includes(String(user?.role || '').toLowerCase())) {
        const error = new Error('只有管理员可以注册 shared/global Skill。');
        error.code = 'AGENT_SKILL_SCOPE_FORBIDDEN';
        throw error;
    }
    const ownerKey = scope === 'user' ? `user:${user?.id || 0}` : `scope:${scope}`;
    await execute(`
        INSERT INTO agent_skills (id, name, version, title, description, publisher, digest, manifest_yaml, instructions_md, scope, user_id, owner_key, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?)
        ON CONFLICT(owner_key, name) DO UPDATE SET
            version = excluded.version, title = excluded.title, description = excluded.description,
            publisher = excluded.publisher, digest = excluded.digest, manifest_yaml = excluded.manifest_yaml,
            instructions_md = excluded.instructions_md, scope = excluded.scope, user_id = excluded.user_id, owner_key = excluded.owner_key,
            status = 'enabled', updated_at = excluded.updated_at
    `, [
        id,
        String(manifest.name).slice(0, 128),
        String(manifest.version),
        String(manifest.title || manifest.name).slice(0, 255),
        String(manifest.description || '').slice(0, 2000),
        String(manifest.publisher || '').slice(0, 128),
        `sha256:${checked.computedDigest}`,
        typeof manifestValue === 'string' ? manifestValue : JSON.stringify(manifestValue),
        String(instructions || ''),
        scope,
        user?.id || null,
        ownerKey,
        now,
        now
    ]);
    return await queryOne('SELECT id, name, version, title, description, publisher, digest, scope, user_id, status, created_at, updated_at FROM agent_skills WHERE owner_key = ? AND name = ?', [ownerKey, String(manifest.name)]);
}

async function getAgentSkillExecutionContext(user, reference) {
    const value = String(reference || '').trim();
    if (!value) return null;
    const row = await queryOne(`
        SELECT id, name, version, manifest_yaml, scope, user_id, status
        FROM agent_skills
        WHERE (id = ? OR name = ?)
          AND (user_id = ? OR scope IN ('shared', 'global'))
          AND status = 'enabled'
        ORDER BY updated_at DESC
        LIMIT 1
    `, [value, value, user?.id || 0]);
    if (!row) {
        const error = new Error('Skill 不存在、已停用或当前用户无权使用。');
        error.code = 'AGENT_SKILL_FORBIDDEN';
        error.status = 403;
        throw error;
    }
    const context = buildSkillExecutionContext(row.manifest_yaml);
    return { ...context, skillName: row.name, skillScope: row.scope };
}

async function listAgentSkillsForUser(user, options = {}) {
    const includeDisabled = options.includeDisabled === true;
    const statusClause = includeDisabled ? '' : "AND status = 'enabled'";
    return query(`
        SELECT id, name, version, title, description, publisher, digest, scope, user_id, status, created_at, updated_at
        FROM agent_skills
        WHERE (user_id = ? OR scope = 'shared' OR scope = 'global') ${statusClause}
        ORDER BY updated_at DESC
    `, [user?.id || 0]);
}

async function disableAgentSkill(name, user) {
    return execute("UPDATE agent_skills SET status = 'disabled', updated_at = ? WHERE name = ? AND user_id = ?", [getBeijingTimestamp(), String(name || ''), user?.id || 0]);
}

module.exports = {
    canonicalJson,
    buildSkillExecutionContext,
    disableAgentSkill,
    listAgentSkillsForUser,
    getAgentSkillExecutionContext,
    parseSkillManifest,
    registerAgentSkill,
    sha256,
    validateSkillManifest,
    verifySkillSignature
};
