/**
 * server/services/agent-skill-authoring.js
 * SKILL.md 创作、预览、导出与版本对比
 *
 * 落地方案 v1.2 §5.1、阶段 4.1 / 4.2：
 * 1. 单文件 SKILL.md 是配方型技能的唯一创作入口，导入时按严格规范校验：
 *    未声明 capabilities / tools 的技能直接拒绝，不再落 legacy_unrestricted；
 * 2. 导入后 manifest 以规范化 JSON 为运行时事实来源，原始 Markdown 仅用于溯源与再编辑；
 * 3. 版本对比必须能直接看出能力与工具声明的变化（权限变更可见）。
 */
const { query, queryOne } = require('../db/client');
const { validateSkillManifest } = require('./agent-skills');
const { buildSkillSourceMarkdown, parseSkillSourceMarkdown } = require('./agent-skill-source');
const { createSkillVersion, getSkillVersion } = require('./agent-releases');
const { capabilitiesCoverTool, normalizeCapabilityList } = require('./agent-capability-registry');
const { isRegisteredToolName, resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');

function authoringError(message, code = 'AGENT_SKILL_SOURCE_INVALID', status = 422) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function allowedPermissionsFromEnv(env = process.env) {
    const list = String(env.AGENT_SKILL_ALLOWED_PERMISSIONS || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    return list.length ? list : undefined;
}

/**
 * 预览 SKILL.md：只做解析与严格校验，不落库。
 * 供编辑器在保存前给出可操作的中文错误清单（阶段 4.2）。
 */
function previewSkillSource(markdown, options = {}) {
    const parsed = parseSkillSourceMarkdown(markdown);
    const checked = validateSkillManifest(parsed.manifest, {
        allowedPermissions: options.allowedPermissions ?? allowedPermissionsFromEnv(),
        allowedTools: options.allowedTools,
        strictSpec: true
    });
    const toolAssertions = checked.tools.map(name => {
        const registered = isRegisteredToolName(name);
        const requiredCapabilities = registered ? resolveRegisteredToolCapabilities(name) : [];
        const covered = registered && capabilitiesCoverTool(checked.capabilities, requiredCapabilities);
        return { tool: name, registered, requiredCapabilities, covered };
    });
    return {
        valid: checked.valid && toolAssertions.every(item => item.registered && item.covered),
        errors: [
            ...checked.errors,
            ...toolAssertions.filter(item => !item.registered).map(item => `技能声明的工具未在平台登记：${item.tool}`),
            ...toolAssertions.filter(item => item.registered && !item.covered)
                .map(item => `技能声明的能力未覆盖工具 ${item.tool} 所需能力（${item.requiredCapabilities.join('、')}）。`)
        ],
        manifest: checked.manifest,
        capabilities: checked.capabilities,
        tools: checked.tools,
        instructions: parsed.instructions,
        contentDigest: checked.computedDigest,
        toolAssertions
    };
}

/**
 * 从 SKILL.md 创建技能版本草稿。
 * 严格模式：schemaVersion / id / name / version / capabilities / tools / inputs / outputs 全部必填，
 * 且 manifest.scope 一律拒绝（作用域由发布动作决定）。
 */
async function createSkillVersionFromMarkdown(user, input = {}) {
    const markdown = String(input.markdown || input.source || '');
    if (!markdown.trim()) throw authoringError('请提供 SKILL.md 内容。');
    const preview = previewSkillSource(markdown, input);
    if (!preview.valid) throw authoringError(`SKILL.md 校验失败：${preview.errors.join('；')}`);
    const version = await createSkillVersion(user, {
        manifest: preview.manifest,
        instructions: preview.instructions,
        strictSpec: true,
        // 个人配方草稿可直接创建；组织签名只在管理员批准共享时生成。
        requireSignature: false,
        allowedPermissions: input.allowedPermissions ?? allowedPermissionsFromEnv(),
        allowedTools: input.allowedTools,
        packageSignature: input.packageSignature,
        packageDigest: input.packageDigest,
        keyId: input.keyId,
        algorithm: input.algorithm,
        sourceRunId: input.sourceRunId
    });
    return { version, preview };
}

/** 把已存版本导出回 SKILL.md，保证「导入 → 编辑 → 再导入」可往返。 */
async function exportSkillVersionMarkdown(user, versionId) {
    const version = await getSkillVersion(versionId, user);
    if (!version) return null;
    let manifest = {};
    try {
        manifest = JSON.parse(version.manifest_json || version.manifest_yaml || '{}') || {};
    } catch (_) {
        manifest = {};
    }
    return {
        version,
        markdown: buildSkillSourceMarkdown(manifest, version.instructions_md || '')
    };
}

function diffStringLists(before = [], after = []) {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
        added: after.filter(item => !beforeSet.has(item)),
        removed: before.filter(item => !afterSet.has(item)),
        unchanged: after.filter(item => beforeSet.has(item))
    };
}

function readManifest(version) {
    try {
        return JSON.parse(version.manifest_json || version.manifest_yaml || '{}') || {};
    } catch (_) {
        return {};
    }
}

function diffScalarFields(beforeManifest, afterManifest) {
    const fields = ['id', 'name', 'version', 'title', 'description', 'publisher', 'schemaVersion'];
    return fields
        .map(field => ({ field, before: beforeManifest[field] ?? null, after: afterManifest[field] ?? null }))
        .filter(item => JSON.stringify(item.before) !== JSON.stringify(item.after));
}

/**
 * 版本对比。
 * 权限变更（capabilities / tools）单独成节，使评审能一眼看出授权面是否扩大（阶段 4.2 完成判据）。
 */
async function diffSkillVersions(user, fromId, toId) {
    const before = await getSkillVersion(fromId, user);
    const after = await getSkillVersion(toId, user);
    if (!before || !after) return null;
    const beforeManifest = readManifest(before);
    const afterManifest = readManifest(after);
    const beforeCapabilities = normalizeCapabilityList(beforeManifest.capabilities ?? beforeManifest.permissions);
    const afterCapabilities = normalizeCapabilityList(afterManifest.capabilities ?? afterManifest.permissions);
    const beforeTools = Array.isArray(beforeManifest.tools) ? beforeManifest.tools.map(String) : [];
    const afterTools = Array.isArray(afterManifest.tools) ? afterManifest.tools.map(String) : [];
    const capabilityDiff = diffStringLists(beforeCapabilities, afterCapabilities);
    const toolDiff = diffStringLists(beforeTools, afterTools);
    return {
        from: { id: before.id, version: before.version, status: before.status, contentDigest: before.content_digest },
        to: { id: after.id, version: after.version, status: after.status, contentDigest: after.content_digest },
        capabilities: capabilityDiff,
        tools: toolDiff,
        // 授权面是否扩大：新增了能力或工具即视为扩权，需要重新验证与签名。
        privilegeExpanded: capabilityDiff.added.length > 0 || toolDiff.added.length > 0,
        fields: diffScalarFields(beforeManifest, afterManifest),
        instructionsChanged: String(before.instructions_md || '') !== String(after.instructions_md || ''),
        digestChanged: String(before.content_digest || '') !== String(after.content_digest || '')
    };
}

/** 按技能名列出可对比的版本（同一 ownerKey 下）。 */
async function listSkillVersionHistory(user, versionId) {
    const version = await getSkillVersion(versionId, user);
    if (!version) return null;
    const rows = await query(`
        SELECT id, version, status, content_digest, created_at, updated_at
        FROM agent_skill_versions
        WHERE owner_key = ? AND name = ?
        ORDER BY created_at DESC
        LIMIT 100
    `, [version.owner_key, version.name]);
    return { version, history: rows };
}

/** 读取某个技能名当前的发布态版本，供预览页展示「线上版本」。 */
async function getPublishedVersionForName(user, name) {
    return await queryOne(`
        SELECT v.id, v.version, v.status, v.content_digest, r.rollout_scope, r.rollout_percent, r.status AS release_status
        FROM agent_skill_releases r
        JOIN agent_skill_versions v ON v.id = r.skill_version_id
        WHERE r.name = ? AND r.status = 'published' AND r.owner_key = ?
        ORDER BY r.published_at DESC
        LIMIT 1
    `, [String(name || ''), `user:${Number.parseInt(user?.id, 10) || 0}`]);
}

module.exports = {
    createSkillVersionFromMarkdown,
    diffSkillVersions,
    exportSkillVersionMarkdown,
    getPublishedVersionForName,
    listSkillVersionHistory,
    previewSkillSource
};
