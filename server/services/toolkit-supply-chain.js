'use strict';

const crypto = require('crypto');
const { query: selectMany, queryOne: selectOne, execute: mutate } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const { assertRegisteredCapabilities } = require('./agent-capability-registry');
const { normalizeCatalogTools } = require('./tool-catalog-releases');
const { validateJsonSchemaDefinition } = require('./agent-dag-contracts');

const TOOLKIT_SLUG_RE = /^[a-z0-9][a-z0-9.-]{1,126}$/;
const SEMVER_RE = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PROTOCOL_TYPES = new Set(['mcp', 'builtin', 'api_operation']);

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((target, key) => { target[key] = stable(value[key]); return target; }, {});
}

function canonical(value) { return JSON.stringify(stable(value)); }
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
function parseJson(value, fallback = {}) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; } }
function toolkitError(message, code = 'TOOLKIT_MANIFEST_INVALID', status = 422) { const error = new Error(message); error.code = code; error.status = status; return error; }

function normalizedProtocol(manifest = {}) {
    const protocol = manifest.protocol && typeof manifest.protocol === 'object' && !Array.isArray(manifest.protocol) ? manifest.protocol : {};
    const type = String(protocol.type || manifest.protocolType || '').trim().toLowerCase();
    const versions = Array.isArray(protocol.versions) ? protocol.versions.map(item => String(item || '').trim()).filter(Boolean).slice(0, 10) : [];
    return { type, versions };
}

function validateToolkitManifest(raw = {}) {
    const manifest = raw && typeof raw === 'object' && !Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : {};
    const errors = [];
    const schemaVersion = String(manifest.schemaVersion || manifest.schema_version || '').trim();
    if (schemaVersion !== '1.0') errors.push('schemaVersion 必须为 1.0。');
    const slug = String(manifest.slug || '').trim().toLowerCase();
    if (!TOOLKIT_SLUG_RE.test(slug)) errors.push('slug 只能使用小写字母、数字、点和短横线，长度 2–127。');
    const version = String(manifest.version || '').trim();
    if (!SEMVER_RE.test(version)) errors.push('version 必须为语义化版本，例如 1.2.3。');
    const displayName = String(manifest.displayName || manifest.display_name || '').trim().slice(0, 255);
    if (!displayName) errors.push('displayName 为必填项。');
    const publisher = String(manifest.publisher || '').trim().slice(0, 255);
    if (!publisher) errors.push('publisher 为必填项。');
    const protocol = normalizedProtocol(manifest);
    if (!PROTOCOL_TYPES.has(protocol.type)) errors.push('protocol.type 必须为 mcp、builtin 或 api_operation。');
    if (protocol.type === 'mcp' && !protocol.versions.length) errors.push('MCP 工具包必须声明支持的协议版本。');
    const tools = [...new Set((Array.isArray(manifest.tools) ? manifest.tools : []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!tools.length || tools.length > 2_000) errors.push('tools 必须包含 1–2000 个稳定工具名。');
    if (tools.some(name => !/^[A-Za-z0-9_.-]{1,128}$/.test(name))) errors.push('tools 中存在不合法的工具名。');
    const capabilityResult = assertRegisteredCapabilities(manifest.requiredCapabilities || manifest.required_capabilities || []);
    if (!capabilityResult.valid) errors.push(`requiredCapabilities 包含未登记能力：${capabilityResult.unknown.join('、')}。`);
    const scopes = [...new Set((Array.isArray(manifest.requiredScopes || manifest.required_scopes) ? (manifest.requiredScopes || manifest.required_scopes) : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 100);
    const dataClassification = String(manifest.dataClassification || manifest.data_classification || 'internal').trim();
    if (!['public', 'internal', 'confidential', 'restricted'].includes(dataClassification)) errors.push('dataClassification 必须为 public、internal、confidential 或 restricted。');
    const privacyUrl = String(manifest.privacyUrl || manifest.privacy_url || '').trim();
    if (privacyUrl) {
        try { if (new URL(privacyUrl).protocol !== 'https:') errors.push('privacyUrl 必须使用 HTTPS。'); } catch (_) { errors.push('privacyUrl 不是有效 URL。'); }
    }
    const signature = String(manifest.signature || '').trim();
    const keyId = String(manifest.keyId || manifest.key_id || '').trim();
    if (signature && !keyId) errors.push('签名工具包必须声明 keyId。');
    return {
        valid: errors.length === 0,
        errors,
        manifest: {
            schemaVersion, slug, version, displayName, publisher,
            protocol: { type: protocol.type, versions: protocol.versions }, tools,
            requiredCapabilities: capabilityResult.capabilities,
            requiredScopes: scopes,
            dataClassification,
            privacyUrl,
            docsUrl: String(manifest.docsUrl || manifest.docs_url || '').trim(),
            healthcheck: manifest.healthcheck === true,
            signature,
            keyId
        }
    };
}

function verifyToolkitSignature(manifest, key = null) {
    const signature = String(manifest?.signature || '').trim();
    if (!signature) return { verified: false, reason: 'unsigned' };
    if (!key || key.status !== 'active' || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) return { verified: false, reason: 'key_unavailable' };
    try {
        const payload = { ...manifest, signature: undefined, keyId: undefined };
        delete payload.signature;
        delete payload.keyId;
        const verified = crypto.verify('RSA-SHA256', Buffer.from(canonical(payload)), key.public_key_pem, Buffer.from(signature, 'base64'));
        return { verified, reason: verified ? 'verified' : 'signature_invalid', keyId: key.key_id };
    } catch (_) { return { verified: false, reason: 'signature_invalid' }; }
}

function validateToolkitTools(manifest, tools = [], serverId = 1) {
    const errors = [];
    let normalized = [];
    try { normalized = normalizeCatalogTools(tools, { serverId }); } catch (error) { errors.push(...(error.details || [error.message])); }
    const declared = new Set(manifest.tools || []);
    const found = new Set(normalized.map(item => item.toolName));
    const missing = [...declared].filter(name => !found.has(name));
    if (missing.length) errors.push(`Manifest 声明的工具未在目录中发现：${missing.slice(0, 10).join('、')}。`);
    normalized.forEach(tool => {
        if (tool.outputSchema && Object.keys(tool.outputSchema).length) validateJsonSchemaDefinition(tool.outputSchema, `${tool.toolName}.output_schema`, errors);
    });
    return { passed: errors.length === 0, errors, toolCount: normalized.length, normalized };
}

async function registerToolkitSigningKey(user, input = {}) {
    if (!isSuperAdmin(user)) throw toolkitError('只有系统管理员可以登记工具包签名密钥。', 'TOOLKIT_SIGNING_KEY_FORBIDDEN', 403);
    const keyId = String(input.keyId || input.key_id || '').trim().slice(0, 128);
    const publisher = String(input.publisher || '').trim().slice(0, 255);
    const publicKey = String(input.publicKeyPem || input.public_key_pem || '').trim();
    if (!keyId || !publisher || !publicKey.includes('BEGIN PUBLIC KEY')) throw toolkitError('请提供 keyId、publisher 和 PEM 公钥。');
    const now = getBeijingTimestamp();
    return await selectOne(`
        INSERT INTO toolkit_signing_keys (key_id, publisher, algorithm, public_key_pem, status, expires_at, created_by, created_at, updated_at)
        VALUES (?, ?, 'RSA-SHA256', ?, 'active', ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET publisher = excluded.publisher, public_key_pem = excluded.public_key_pem,
            status = 'active', expires_at = excluded.expires_at, revoked_at = NULL, updated_at = excluded.updated_at
        RETURNING *
    `, [keyId, publisher, publicKey, input.expiresAt || input.expires_at || null, user.id, now, now]);
}

async function createToolkitRelease(user, input = {}) {
    const checked = validateToolkitManifest(input.manifest || input);
    if (!checked.valid) throw toolkitError(`工具包 Manifest 校验失败：${checked.errors.join('；')}`);
    const manifest = checked.manifest;
    const key = manifest.keyId ? await selectOne('SELECT * FROM toolkit_signing_keys WHERE key_id = ?', [manifest.keyId]) : null;
    const signature = verifyToolkitSignature(manifest, key);
    const now = getBeijingTimestamp();
    const validation = { manifest: { passed: true, errors: [] }, signature, tools: { passed: false, errors: ['待连接工具目录后校验。'] } };
    const status = signature.verified ? 'validated' : 'draft';
    return await selectOne(`
        INSERT INTO toolkit_releases (slug, version, display_name, publisher, protocol_type, protocol_versions, manifest, content_digest, signature, signing_key_id, signature_verified, validation, server_id, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
        RETURNING *
    `, [manifest.slug, manifest.version, manifest.displayName, manifest.publisher, manifest.protocol.type, JSON.stringify(manifest.protocol.versions), JSON.stringify(manifest), digest({ ...manifest, signature: undefined }), manifest.signature, manifest.keyId || null, signature.verified, JSON.stringify(validation), Number(input.serverId || input.server_id) || null, status, user.id, now, now]);
}

async function validateToolkitRelease(id, user, options = {}) {
    const release = await selectOne('SELECT * FROM toolkit_releases WHERE id = ? AND (created_by = ? OR ? = 1)', [id, user.id, isSuperAdmin(user) ? 1 : 0]);
    if (!release) return null;
    const manifest = parseJson(release.manifest, {});
    const checked = validateToolkitManifest(manifest);
    const key = manifest.keyId ? await selectOne('SELECT * FROM toolkit_signing_keys WHERE key_id = ?', [manifest.keyId]) : null;
    const signature = verifyToolkitSignature(manifest, key);
    let toolResult = { passed: false, errors: ['工具包尚未绑定工具服务。'], toolCount: 0 };
    if (release.server_id) {
        const { activeRelease, releaseItems } = require('./tool-catalog-releases');
        const active = await activeRelease(release.server_id);
        const items = active?.id ? await releaseItems(active.id) : [];
        toolResult = validateToolkitTools(checked.manifest, items.map(item => ({ name: item.toolName, title: item.title, description: item.description, inputSchema: item.inputSchema, outputSchema: item.outputSchema, capabilities: item.capabilities, side_effect: item.side_effect, idempotent: item.idempotent })), release.server_id);
    }
    let evaluation = { passed: false, errors: ['请先运行并关联工具选择评测。'] };
    const evaluationRunId = String(options.evaluationRunId || options.evaluation_run_id || '').trim();
    if (evaluationRunId) {
        const run = await selectOne(`
            SELECT r.*, s.owner_user_id FROM tool_eval_runs r
            JOIN tool_eval_suites s ON s.id = r.suite_id
            WHERE r.id = ? AND r.status = 'completed' AND (s.owner_user_id = ? OR s.owner_user_id IS NULL)
        `, [evaluationRunId, user.id]);
        const summary = parseJson(run?.summary, {});
        const top3Rate = Number(summary.top3Rate || 0);
        const caseCount = Number(summary.caseCount || 0);
        evaluation = {
            runId: run?.id || '', caseCount, top1Rate: Number(summary.top1Rate || 0), top3Rate,
            passed: Boolean(run && caseCount >= 1 && top3Rate >= Number(options.minTop3Rate || 80)),
            errors: run ? (caseCount < 1 ? ['评测运行未包含用例。'] : top3Rate < Number(options.minTop3Rate || 80) ? ['工具选择 Top-3 召回率未达到发布阈值。'] : []) : ['指定的工具评测运行不存在、未完成或无权访问。']
        };
    }
    const validation = { manifest: { passed: checked.valid, errors: checked.errors }, signature, tools: { passed: toolResult.passed, errors: toolResult.errors, toolCount: toolResult.toolCount }, evaluation };
    const passed = checked.valid && signature.verified && toolResult.passed && evaluation.passed;
    const status = passed ? 'pending_review' : 'blocked';
    await mutate('UPDATE toolkit_releases SET signature_verified = ?, validation = ?::jsonb, status = ?, updated_at = ? WHERE id = ?', [signature.verified, JSON.stringify(validation), status, getBeijingTimestamp(), id]);
    return await selectOne('SELECT * FROM toolkit_releases WHERE id = ?', [id]);
}

async function reviewToolkitRelease(id, user, input = {}) {
    if (!isSuperAdmin(user)) throw toolkitError('只有系统管理员可以审核工具包发布。', 'TOOLKIT_REVIEW_FORBIDDEN', 403);
    const status = String(input.status || '').trim();
    if (!['published', 'blocked'].includes(status)) throw toolkitError('审核状态只能为 published 或 blocked。');
    const release = await selectOne('SELECT * FROM toolkit_releases WHERE id = ?', [id]);
    if (!release) return null;
    const validation = parseJson(release.validation, {});
    if (status === 'published' && !(validation.manifest?.passed && validation.signature?.verified && validation.tools?.passed && validation.evaluation?.passed)) {
        throw toolkitError('工具包未通过 Manifest、签名、工具目录或工具选择评测，不能发布。', 'TOOLKIT_RELEASE_GATE_FAILED', 409);
    }
    const note = String(input.note || input.reviewNote || '').trim().slice(0, 2000);
    return await selectOne('UPDATE toolkit_releases SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? RETURNING *', [status, note, user.id, getBeijingTimestamp(), getBeijingTimestamp(), id]);
}

async function listToolkitReleases(user, options = {}) {
    const includeAll = isSuperAdmin(user) && options.includeAll === true;
    const rows = await selectMany(`
        SELECT id, slug, version, display_name, publisher, protocol_type, protocol_versions, content_digest,
               signing_key_id, signature_verified, validation, server_id, status, review_note, reviewed_by, reviewed_at,
               created_by, created_at, updated_at
        FROM toolkit_releases WHERE (? = 1 OR created_by = ? OR status = 'published')
        ORDER BY updated_at DESC, id DESC LIMIT 200
    `, [includeAll ? 1 : 0, user.id]);
    return rows.map(row => ({ ...row, protocol_versions: parseJson(row.protocol_versions, []), validation: parseJson(row.validation, {}) }));
}

module.exports = {
    createToolkitRelease,
    listToolkitReleases,
    registerToolkitSigningKey,
    reviewToolkitRelease,
    validateToolkitManifest,
    validateToolkitRelease,
    validateToolkitTools,
    verifyToolkitSignature
};
