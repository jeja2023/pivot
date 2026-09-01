const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };
const suffix = crypto.randomBytes(4).toString('hex');

const { approveSkillVersionForSharing, createSkillVersion, publishSkillVersion, resolvePublishedSkill, validateSkillVersion } = require('../server/services/agent-releases');
const { listAgentSkillsForUser } = require('../server/services/agent-skills');
const { createStandaloneArtifact } = require('../server/services/agent-artifacts');
const { deleteSkillReleasePermission, listSkillReleasePermissions, upsertSkillReleasePermission } = require('../server/services/agent-skill-access');
const { recordSigningEnvelope } = require('../server/services/agent-skill-signing');
const { claimConnectorTask, completeConnectorTask, createConnectorTask, heartbeatConnector, waitForConnectorTask } = require('../server/services/agent-local-connector');
const { listCachedMcpTools } = require('../server/services/mcp-client');
const { putBuffer, readBuffer, buildCasRef, incrementRefCount, deleteIfUnreferenced, openReadStream } = require('../server/services/agent-artifact-cas');
const { createRendition, issueDownloadToken, consumeDownloadToken, getRenditionForUser } = require('../server/services/agent-artifact-renditions');
const {
    claimDeliveryIntent,
    confirmDelivery,
    createDeliveryIntent,
    failDelivery,
    reclaimDeliveryIntents,
    traceDeliveryChain
} = require('../server/services/agent-artifact-delivery');
const {
    attestLocalDevice,
    issueDeviceChallenge,
    registerLocalDevice,
    registerOutputGrant,
    revokeLocalDevice,
    revokeOutputGrant
} = require('../server/services/agent-local-devices');

function pool() {
    return require('../server/db/pg-connection').getPgPool();
}

async function ensureTenant(name) {
    const existing = await pool().query('SELECT id FROM organizations WHERE slug = $1', [name]);
    if (existing.rows.length) return Number(existing.rows[0].id);
    const created = await pool().query(
        "INSERT INTO organizations (name, slug, status) VALUES ($1, $1, 'active') RETURNING id",
        [name]
    );
    return Number(created.rows[0].id);
}

async function ensureTeam(tenantId, slug) {
    const existing = await pool().query('SELECT id FROM teams WHERE organization_id = $1 AND slug = $2', [tenantId, slug]);
    if (existing.rows.length) return Number(existing.rows[0].id);
    const created = await pool().query(
        "INSERT INTO teams (organization_id, name, slug, status) VALUES ($1, $2, $2, 'active') RETURNING id",
        [tenantId, slug]
    );
    return Number(created.rows[0].id);
}

async function ensureUser(username, role = 'admin') {
    const existing = await pool().query('SELECT id, role FROM users WHERE username = $1', [username]);
    if (existing.rows.length) return { id: Number(existing.rows[0].id), username, role: existing.rows[0].role };
    const created = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', $2, 'active', NOW()) RETURNING id",
        [username, role]
    );
    return { id: Number(created.rows[0].id), username, role };
}

async function joinTeam(teamId, userId, role = 'admin') {
    await pool().query(
        "INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, $3, 'active') ON CONFLICT (team_id, user_id) DO UPDATE SET status = 'active', role = $3",
        [teamId, userId, role]
    );
}

async function createRunAndArtifact(user) {
    const runId = `run-${suffix}-${crypto.randomBytes(3).toString('hex')}`;
    await pool().query(
        "INSERT INTO agent_runs (id, user_id, goal, status, created_at, updated_at) VALUES ($1, $2, '交付链路集成测试', 'succeeded', NOW(), NOW())",
        [runId, user.id]
    );
    const artifact = await pool().query(
        "INSERT INTO agent_artifacts (run_id, user_id, type, title, content, note, created_at, updated_at) VALUES ($1, $2, 'summary', '年度核查通知', '正文', '', NOW(), NOW()) RETURNING id",
        [runId, user.id]
    );
    return { runId, artifactId: Number(artifact.rows[0].id) };
}

function documentIr(title = '关于开展年度核查的通知') {
    return {
        ir_version: '1',
        doc_type: 'official_document',
        meta: { title, issuer: '示例单位', issued_at: '2026-08-31' },
        blocks: [
            { type: 'heading', level: 1, text: '一、总体要求' },
            { type: 'paragraph', runs: [{ text: '正文示例。' }], style: { indent_chars: 2, line_height: 1.5 } }
        ],
        footer: { page_number: true, format: '— {page} —' }
    };
}

function signedManifest(name, privateKey, overrides = {}) {
    const { canonicalJson } = require('../server/services/agent-skills');
    const manifest = {
        schemaVersion: 1,
        id: `integration.${name}`,
        name,
        version: '1.0.0',
        title: '集成测试技能',
        capabilities: ['knowledge.search'],
        tools: ['rag.search'],
        inputs: {},
        outputs: {},
        ...overrides
    };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(manifest));
    signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64');
    return manifest;
}

function unsignedManifest(name, overrides = {}) {
    return {
        schemaVersion: 1,
        id: `integration.${name}`,
        name,
        version: '1.0.0',
        title: '集成测试技能',
        capabilities: ['knowledge.search'],
        tools: ['rag.search'],
        inputs: {},
        outputs: {},
        ...overrides
    };
}

async function cleanupSkill(name) {
    await pool().query('DELETE FROM agent_skill_releases WHERE name = $1', [name]);
    await pool().query('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = $1)', [name]);
    await pool().query('DELETE FROM agent_skills WHERE name = $1', [name]);
    await pool().query('DELETE FROM agent_skill_versions WHERE name = $1', [name]);
}

async function approveSharedVersion(versionId, user) {
    const previous = {
        publicKey: process.env.AGENT_SKILL_PUBLIC_KEY,
        privateKey: process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64,
        keyId: process.env.AGENT_SKILL_ORGANIZATION_KEY_ID
    };
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.AGENT_SKILL_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' });
    process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    process.env.AGENT_SKILL_ORGANIZATION_KEY_ID = `org-test-${suffix}`;
    const result = await approveSkillVersionForSharing(versionId, user);
    return {
        result,
        restore() {
            if (previous.publicKey === undefined) delete process.env.AGENT_SKILL_PUBLIC_KEY; else process.env.AGENT_SKILL_PUBLIC_KEY = previous.publicKey;
            if (previous.privateKey === undefined) delete process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64; else process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 = previous.privateKey;
            if (previous.keyId === undefined) delete process.env.AGENT_SKILL_ORGANIZATION_KEY_ID; else process.env.AGENT_SKILL_ORGANIZATION_KEY_ID = previous.keyId;
        }
    };
}

test('createSkillVersion 拒绝外部 ownerKey 并且关闭签名旁路', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const user = { ...(await ensureUser(`pivot_owner_${suffix}`)), tenant_id: tenantId };
    const name = `integration-owner-${suffix}`;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    try {
        await assert.rejects(
            () => createSkillVersion(user, { manifest: signedManifest(name, privateKey), ownerKey: 'scope:global', requireSignature: false }),
            error => error.code === 'SKILL_OWNER_KEY_FORBIDDEN'
        );
        // signatureVerified 由外部传入 true 时仍须实际校验签名。
        await assert.rejects(
            () => createSkillVersion(user, {
                manifest: { schemaVersion: 1, id: `integration.${name}`, name, version: '1.0.0', capabilities: [], tools: [], inputs: {}, outputs: {} },
                signatureVerified: true,
                requireSignature: true,
                publicKey: publicKeyPem
            }),
            error => error.code === 'SKILL_SIGNATURE_INVALID'
        );
        const version = await createSkillVersion(user, {
            manifest: signedManifest(name, privateKey),
            requireSignature: true,
            publicKey: publicKeyPem
        });
        assert.equal(version.owner_key, `user:${user.id}`);
        assert.equal(Number(version.tenant_id), tenantId);
        assert.match(String(version.content_digest), /^[0-9a-f]{64}$/);
        assert.ok(version.signing_envelope_id, '签名信封必须在导入期落库');
    } finally {
        await cleanupSkill(name);
    }
});

test('个人 SKILL 草稿与个人发布无需组织签名，管理员共享发布自动批准并组织签名', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-personal-skill-${suffix}`);
    const user = { ...(await ensureUser(`pivot_personal_skill_${suffix}`, 'admin')), tenant_id: tenantId };
    const name = `personal-skill-${suffix}`;
    const manifest = {
        schemaVersion: 1, id: `integration.${name}`, name, version: '1.0.0',
        title: '个人技能', capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {}
    };
    const previousPublic = process.env.AGENT_SKILL_PUBLIC_KEY;
    const previousPrivate = process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64;
    const previousKeyId = process.env.AGENT_SKILL_ORGANIZATION_KEY_ID;
    let envelopeId = 0;
    try {
        delete process.env.AGENT_SKILL_PUBLIC_KEY;
        delete process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64;
        const version = await createSkillVersion(user, { manifest, strictSpec: true, requireSignature: false });
        const personalValidation = await validateSkillVersion(version.id, user, { strictSpec: true, requireSignature: false });
        assert.equal(personalValidation.passed, true, '个人草稿验证不应被组织签名配置阻断');
        const personalRelease = await publishSkillVersion(version.id, user, { scope: 'personal' });
        assert.equal(personalRelease.rollout_scope, 'personal');

        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        process.env.AGENT_SKILL_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
        process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
        process.env.AGENT_SKILL_ORGANIZATION_KEY_ID = `org-test-${suffix}`;
        const organizationRelease = await publishSkillVersion(version.id, user, { scope: 'organization' });
        assert.equal(organizationRelease.rollout_scope, 'organization');
        assert.equal(organizationRelease.autoApproved, true, '管理员共享发布应自动完成批准');
        assert.match(String(organizationRelease.organizationSigningKeyId || ''), /^org-test-/);
        const signedVersion = await pool().query('SELECT signing_envelope_id FROM agent_skill_versions WHERE id = $1', [version.id]);
        envelopeId = Number(signedVersion.rows[0]?.signing_envelope_id || 0);
        assert.ok(envelopeId, '自动共享发布必须写入组织签名信封');
    } finally {
        if (previousPublic === undefined) delete process.env.AGENT_SKILL_PUBLIC_KEY; else process.env.AGENT_SKILL_PUBLIC_KEY = previousPublic;
        if (previousPrivate === undefined) delete process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64; else process.env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 = previousPrivate;
        if (previousKeyId === undefined) delete process.env.AGENT_SKILL_ORGANIZATION_KEY_ID; else process.env.AGENT_SKILL_ORGANIZATION_KEY_ID = previousKeyId;
        await cleanupSkill(name);
        if (envelopeId) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [envelopeId]);
    }
});

test('普通用户不能借共享发布路径自动批准或自签名', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-no-auto-approval-${suffix}`);
    const user = { ...(await ensureUser(`pivot_no_auto_approval_${suffix}`, 'user')), tenant_id: tenantId };
    const name = `no-auto-approval-${suffix}`;
    try {
        const version = await createSkillVersion(user, { manifest: unsignedManifest(name), strictSpec: true, requireSignature: false });
        assert.equal((await validateSkillVersion(version.id, user, { strictSpec: true, requireSignature: false })).passed, true);
        await assert.rejects(
            () => publishSkillVersion(version.id, user, { scope: 'organization' }),
            error => Number(error.status) === 409 && error.code === 'SKILL_SHARED_SIGNATURE_REQUIRED'
        );
    } finally {
        await cleanupSkill(name);
    }
});

test('签名信封按内容寻址复用且不允许原地覆盖', skipWithoutDatabase, async () => {
    const digest = crypto.randomBytes(32).toString('hex');
    const keyId = `test-key-${suffix}`;
    let envelopeId = 0;
    try {
        const first = await recordSigningEnvelope({ contentDigest: digest, keyId, signatureForm: 'detached', signature: 'first-signature' });
        envelopeId = Number(first.id);
        const second = await recordSigningEnvelope({ contentDigest: digest, keyId, signatureForm: 'detached', signature: 'replacement-signature' });
        assert.equal(Number(second.id), envelopeId);
        assert.equal(second.signature, 'first-signature', '已登记信封不得被后续调用原地覆盖');
    } finally {
        if (envelopeId) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [envelopeId]);
    }
});

test('分离式兼容包签名会随版本持久化，并在后续验证时复用包摘要', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-detached-${suffix}`);
    const user = { ...(await ensureUser(`pivot_detached_${suffix}`)), tenant_id: tenantId };
    const name = `detached-skill-${suffix}`;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const packageDigest = crypto.randomBytes(32).toString('hex');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(packageDigest);
    signer.end();
    const packageSignature = signer.sign(privateKey).toString('base64');
    try {
        const version = await createSkillVersion(user, {
            manifest: unsignedManifest(name),
            packageSignature,
            packageDigest,
            requireSignature: true,
            strictSpec: true,
            publicKey: publicKey.export({ type: 'spki', format: 'pem' })
        });
        assert.equal(String(version.digest), `sha256:${packageDigest}`);
        const validation = await validateSkillVersion(version.id, user, {
            requireSignature: true,
            strictSpec: true,
            publicKey: publicKey.export({ type: 'spki', format: 'pem' })
        });
        assert.equal(validation.passed, true, `分离式签名应能复验，实际错误：${validation.error_message || ''}`);
        assert.equal(validation.signature.signatureForm, 'detached');
    } finally {
        await cleanupSkill(name);
    }
});

test('技能验证不执行包内脚本，已验证版本的制品不可原地修改', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const user = { ...(await ensureUser(`pivot_owner_${suffix}`)), tenant_id: tenantId };
    const name = `integration-immutable-${suffix}`;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    try {
        const version = await createSkillVersion(user, { manifest: signedManifest(name, privateKey), requireSignature: true, publicKey: publicKeyPem });
        const validated = await validateSkillVersion(version.id, user, { publicKey: publicKeyPem });
        assert.equal(validated.passed, true, `验证应通过，实际错误：${JSON.stringify(validated.declarative?.errors || [])}`);
        assert.equal(validated.declarative.scriptsExecuted, false);
        assert.equal(validated.sandbox.packageScriptsExecuted, false);
        assert.equal(validated.signature.verified, true);
        await assert.rejects(
            () => pool().query('UPDATE agent_skill_versions SET instructions_md = $1 WHERE id = $2', ['被篡改', version.id]),
            /不可修改/
        );
    } finally {
        await cleanupSkill(name);
    }
});

test('技能目录与发布解析都以租户为首个访问条件，跨租户读取返回空', skipWithoutDatabase, async () => {
    const tenantA = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const tenantB = await ensureTenant(`pivot-tenant-b-${suffix}`);
    const teamA = await ensureTeam(tenantA, `team-a-${suffix}`);
    const publisher = { ...(await ensureUser(`pivot_pub_${suffix}`, 'admin')), tenant_id: tenantA };
    const outsider = { ...(await ensureUser(`pivot_out_${suffix}`, 'user')), tenant_id: tenantB };
    await joinTeam(teamA, publisher.id, 'admin');
    const name = `integration-tenant-${suffix}`;
    let signing = null;
    try {
        const version = await createSkillVersion(publisher, { manifest: unsignedManifest(name), strictSpec: true, requireSignature: false });
        const validated = await validateSkillVersion(version.id, publisher, { requireSignature: false });
        assert.equal(validated.passed, true);
        signing = await approveSharedVersion(version.id, publisher);
        assert.equal(signing.result.validation.passed, true);
        const release = await publishSkillVersion(version.id, publisher, { scope: 'organization' });
        assert.equal(release.status, 'published');
        assert.equal(release.owner_key, `org:${tenantA}`);
        assert.equal(Number(release.tenant_id), tenantA);

        const resolvedForPublisher = await resolvePublishedSkill(name, publisher);
        assert.ok(resolvedForPublisher, '同租户用户必须能解析到组织范围发布');
        const resolvedForOutsider = await resolvePublishedSkill(name, outsider);
        assert.equal(resolvedForOutsider, null, '跨租户用户必须解析不到');

        const catalogForPublisher = await listAgentSkillsForUser(publisher);
        assert.ok(catalogForPublisher.some(item => item.name === name));
        const catalogForOutsider = await listAgentSkillsForUser(outsider);
        assert.equal(catalogForOutsider.some(item => item.name === name), false, '技能目录不得跨租户可见');
    } finally {
        await cleanupSkill(name);
        if (signing?.result?.envelope?.id) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [signing.result.envelope.id]);
        signing?.restore();
    }
});

test('技能 release ACL 的显式 deny 同时拦截运行时解析与目录投影', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-acl-${suffix}`);
    const teamId = await ensureTeam(tenantId, `team-acl-${suffix}`);
    const publisher = { ...(await ensureUser(`pivot_acl_pub_${suffix}`, 'admin')), tenant_id: tenantId };
    const consumer = { ...(await ensureUser(`pivot_acl_user_${suffix}`, 'user')), tenant_id: tenantId };
    await joinTeam(teamId, publisher.id, 'admin');
    await joinTeam(teamId, consumer.id, 'member');
    const name = `integration-acl-${suffix}`;
    let releaseId = 0;
    let permissionId = 0;
    let signing = null;
    try {
        const version = await createSkillVersion(publisher, { manifest: unsignedManifest(name), strictSpec: true, requireSignature: false });
        assert.equal((await validateSkillVersion(version.id, publisher, { requireSignature: false })).passed, true);
        signing = await approveSharedVersion(version.id, publisher);
        assert.equal(signing.result.validation.passed, true);
        const release = await publishSkillVersion(version.id, publisher, { scope: 'organization' });
        releaseId = Number(release.id);
        assert.ok(await resolvePublishedSkill(name, consumer), '同租户组织成员默认可使用发布');
        const permission = await upsertSkillReleasePermission(releaseId, publisher, {
            subjectType: 'user', subjectId: consumer.id, action: 'use', effect: 'deny'
        });
        permissionId = Number(permission.id);
        const permissions = await listSkillReleasePermissions(releaseId, publisher);
        assert.ok(permissions.permissions.some(item => Number(item.id) === permissionId), '管理员必须能查看已写入的 release ACL');
        assert.equal(await resolvePublishedSkill(name, consumer), null, '显式 deny 必须在运行时解析处生效');
        const catalog = await listAgentSkillsForUser(consumer);
        assert.equal(catalog.some(item => item.name === name), false, '目录投影不得绕过 release ACL');
    } finally {
        if (releaseId && permissionId) await deleteSkillReleasePermission(releaseId, permissionId, publisher);
        await cleanupSkill(name);
        if (signing?.result?.envelope?.id) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [signing.result.envelope.id]);
        signing?.restore();
    }
});

test('二进制 CAS 支持小于与大于 64KB 的对象，跨租户与非属主读取一律拒绝', skipWithoutDatabase, async () => {
    const tenantA = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const tenantB = await ensureTenant(`pivot-tenant-b-${suffix}`);
    const owner = await ensureUser(`pivot_cas_owner_${suffix}`);
    const other = await ensureUser(`pivot_cas_other_${suffix}`);
    const small = Buffer.from(JSON.stringify({ ir: '小对象', at: suffix }), 'utf8');
    const large = Buffer.alloc(128 * 1024, 0x41);
    const objects = [];
    try {
        for (const payload of [small, large]) {
            const stored = await putBuffer({ buffer: payload, mimeType: 'application/octet-stream', tenantId: tenantA, ownerUserId: owner.id, kind: 'document_ir' });
            objects.push(stored.objectId);
            const loaded = await readBuffer({ ref: buildCasRef(stored.objectId), tenantId: tenantA, userId: owner.id });
            assert.equal(loaded.buffer.length, payload.length, '不同大小的对象都必须完整可恢复');
            assert.equal(loaded.buffer.equals(payload), true);
            const again = await putBuffer({ buffer: payload, mimeType: 'application/octet-stream', tenantId: tenantA, ownerUserId: owner.id, kind: 'document_ir' });
            assert.equal(again.reused, true, '同租户同内容必须复用');
            await assert.rejects(
                () => readBuffer({ objectId: stored.objectId, tenantId: tenantB, userId: owner.id }),
                error => Number(error.status) === 403 || Number(error.status) === 404
            );
            await assert.rejects(
                () => readBuffer({ objectId: stored.objectId, tenantId: tenantA, userId: other.id }),
                error => Number(error.status) === 403
            );
        }
        const [first] = objects;
        await incrementRefCount(first, 1);
        assert.equal((await deleteIfUnreferenced(first)).deleted, false, '仍被引用的对象不得删除');
        await incrementRefCount(first, -1);
        assert.equal((await deleteIfUnreferenced(first)).deleted, true);
        objects.shift();
    } finally {
        for (const objectId of objects) {
            await pool().query('UPDATE agent_artifact_objects SET ref_count = 0 WHERE id = $1', [objectId]);
            await deleteIfUnreferenced(objectId);
        }
    }
});

test('CAS 流式读取会在发送前复算摘要并拒绝同长度篡改', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-cas-integrity-${suffix}`);
    const owner = await ensureUser(`pivot_cas_integrity_${suffix}`);
    const payload = Buffer.from('原始二进制产物', 'utf8');
    let objectId = '';
    try {
        const stored = await putBuffer({ buffer: payload, mimeType: 'application/octet-stream', tenantId, ownerUserId: owner.id, kind: 'document_ir' });
        objectId = stored.objectId;
        const row = await pool().query('SELECT storage_key FROM agent_artifact_objects WHERE id = $1', [objectId]);
        const absolute = require('../server/services/agent-artifact-cas-store').resolveStoragePath(row.rows[0].storage_key);
        const tampered = Buffer.from(payload);
        tampered[0] ^= 0x01;
        require('node:fs').writeFileSync(absolute, tampered);
        await assert.rejects(
            () => openReadStream({ ref: buildCasRef(objectId), tenantId, userId: owner.id }),
            error => error.code === 'ARTIFACT_CAS_DIGEST_MISMATCH'
        );
    } finally {
        if (objectId) {
            await pool().query('UPDATE agent_artifact_objects SET ref_count = 0 WHERE id = $1', [objectId]);
            await deleteIfUnreferenced(objectId);
        }
    }
});

test('同 IR 同格式同渲染器版本的渲染幂等，缺少工具调用标识即拒绝渲染', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const user = { ...(await ensureUser(`pivot_render_${suffix}`)), tenant_id: tenantId };
    const { runId, artifactId } = await createRunAndArtifact(user);
    try {
        await assert.rejects(
            () => createRendition({ user, artifactId, runId, toolCallId: '', ir: documentIr(), format: 'docx' }),
            error => error.code === 'ARTIFACT_RENDITION_TOOL_CALL_REQUIRED'
        );
        const first = await createRendition({ user, artifactId, runId, toolCallId: `${runId}:1`, ir: documentIr(), format: 'docx' });
        assert.equal(first.reused, false);
        assert.match(first.rendition.content_digest, /^[0-9a-f]{64}$/);
        assert.match(first.rendition.ir_ref, /^artifact-cas:\/\//);
        const second = await createRendition({ user, artifactId, runId, toolCallId: `${runId}:2`, ir: documentIr(), format: 'docx' });
        assert.equal(second.reused, true, '同 IR 同格式重复渲染必须幂等');
        assert.equal(second.rendition.id, first.rendition.id);
        assert.equal(second.rendition.content_digest, first.rendition.content_digest);
        const md = await createRendition({ user, artifactId, runId, toolCallId: `${runId}:3`, ir: documentIr(), format: 'md' });
        assert.notEqual(md.rendition.id, first.rendition.id, '不同格式必须产生新行');

        const issued = await issueDownloadToken(user, first.rendition.id);
        assert.match(issued.token, /^[0-9a-f]{64}$/);
        const consumed = await consumeDownloadToken(user, issued.token);
        assert.equal(consumed.id, first.rendition.id);
        await assert.rejects(
            () => consumeDownloadToken(user, issued.token),
            error => error.code === 'ARTIFACT_DOWNLOAD_TOKEN_INVALID'
        );
    } finally {
        await pool().query('DELETE FROM agent_artifact_delivery_events WHERE run_id = $1', [runId]);
        await pool().query('DELETE FROM agent_artifact_renditions WHERE run_id = $1', [runId]);
        await pool().query('DELETE FROM agent_artifacts WHERE id = $1', [artifactId]);
        await pool().query('DELETE FROM agent_runs WHERE id = $1', [runId]);
    }
});

test('独立文档 Artifact 可渲染且删除 rendition 会释放二进制 CAS 引用', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-standalone-${suffix}`);
    const user = { ...(await ensureUser(`pivot_standalone_${suffix}`)), tenant_id: tenantId };
    let artifactId = 0;
    let renditionId = 0;
    try {
        const artifact = await createStandaloneArtifact(user, { type: 'official_writing', title: '独立公文', content: '独立公文正文' });
        artifactId = Number(artifact.id);
        assert.equal(artifact.run_id, null);
        const result = await createRendition({ user, artifactId, toolCallId: 'user:standalone:1', ir: documentIr('独立公文'), format: 'docx' });
        renditionId = Number(result.rendition.id);
        assert.equal(result.rendition.run_id, `standalone-artifact:${artifactId}`);
        const refs = [result.rendition.ir_ref, result.rendition.storage_ref].map(ref => ref.slice('artifact-cas://'.length));
        const before = await pool().query('SELECT id, ref_count FROM agent_artifact_objects WHERE id = ANY($1::text[]) ORDER BY id', [refs]);
        assert.equal(before.rows.length, 2);
        assert.ok(before.rows.every(row => Number(row.ref_count) >= 1));
        await pool().query('DELETE FROM agent_artifact_renditions WHERE id = $1', [renditionId]);
        renditionId = 0;
        const after = await pool().query('SELECT id, ref_count FROM agent_artifact_objects WHERE id = ANY($1::text[]) ORDER BY id', [refs]);
        assert.ok(after.rows.every(row => Number(row.ref_count) === 0), '级联前删除 rendition 必须释放两个 CAS 引用');
        for (const ref of refs) await deleteIfUnreferenced(ref);
    } finally {
        if (renditionId) await pool().query('DELETE FROM agent_artifact_renditions WHERE id = $1', [renditionId]);
        if (artifactId) await pool().query('DELETE FROM agent_artifacts WHERE id = $1', [artifactId]);
    }
});

async function registerTestDevice(user, deviceId) {
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const sign = payload => crypto.sign(null, Buffer.from(payload, 'utf8'), keys.privateKey).toString('base64');
    const challenge = await issueDeviceChallenge(user, { purpose: 'register', deviceId });
    const device = await registerLocalDevice(user, {
        deviceId,
        deviceName: '集成测试设备',
        publicKeyPem,
        nonce: challenge.nonce,
        signature: sign(`register:${challenge.nonce}:${deviceId}`)
    });
    return { device, sign, publicKeyPem, keys };
}

test('设备身份必须由私钥签名证明，冒用已注册 deviceId 的客户端一律被拒', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const user = { ...(await ensureUser(`pivot_device_${suffix}`)), tenant_id: tenantId };
    const deviceId = `device-${suffix}-attest`;
    try {
        const { sign } = await registerTestDevice(user, deviceId);
        const attestChallenge = await issueDeviceChallenge(user, { purpose: 'attest', deviceId });
        const attested = await attestLocalDevice(user, {
            deviceId,
            nonce: attestChallenge.nonce,
            signature: sign(`attest:${attestChallenge.nonce}:${deviceId}`)
        });
        assert.ok(attested.last_attested_at);
        // 同一用户会话但不持有设备私钥：签名由另一把密钥生成，必须拒绝。
        const impostor = crypto.generateKeyPairSync('ed25519');
        const forgedChallenge = await issueDeviceChallenge(user, { purpose: 'attest', deviceId });
        await assert.rejects(
            () => attestLocalDevice(user, {
                deviceId,
                nonce: forgedChallenge.nonce,
                signature: crypto.sign(null, Buffer.from(`attest:${forgedChallenge.nonce}:${deviceId}`, 'utf8'), impostor.privateKey).toString('base64')
            }),
            error => error.code === 'AGENT_DEVICE_ATTESTATION_FAILED'
        );
        // nonce 一次性：同一挑战值不可重放。
        const replayChallenge = await issueDeviceChallenge(user, { purpose: 'attest', deviceId });
        await attestLocalDevice(user, { deviceId, nonce: replayChallenge.nonce, signature: sign(`attest:${replayChallenge.nonce}:${deviceId}`) });
        await assert.rejects(
            () => attestLocalDevice(user, { deviceId, nonce: replayChallenge.nonce, signature: sign(`attest:${replayChallenge.nonce}:${deviceId}`) }),
            error => error.code === 'AGENT_DEVICE_NONCE_EXPIRED'
        );

        // 已存在设备的密钥轮换必须由旧私钥证明；仅持会话、拿新公钥的攻击者不能接管 deviceId。
        const attacker = crypto.generateKeyPairSync('ed25519');
        const rotationChallenge = await issueDeviceChallenge(user, { purpose: 'register', deviceId });
        await assert.rejects(
            () => registerLocalDevice(user, {
                deviceId,
                deviceName: '被冒用设备',
                publicKeyPem: attacker.publicKey.export({ type: 'spki', format: 'pem' }),
                nonce: rotationChallenge.nonce,
                signature: crypto.sign(null, Buffer.from(`register:${rotationChallenge.nonce}:${deviceId}`, 'utf8'), attacker.privateKey).toString('base64')
            }),
            error => error.code === 'AGENT_DEVICE_ATTESTATION_FAILED'
        );
    } finally {
        await pool().query('DELETE FROM agent_local_device_nonces WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_devices WHERE device_id = $1', [deviceId]);
    }
});

test('持久化桌面连接器按显式设备领取只读任务，服务端重查结果而非依赖内存 Promise', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-connector-${suffix}`);
    const user = { ...(await ensureUser(`pivot_connector_${suffix}`)), tenant_id: tenantId };
    const deviceId = `device-${suffix}-connector`;
    let taskId = '';
    try {
        await registerTestDevice(user, deviceId);
        await heartbeatConnector(user, { deviceId, grants: { local_report_dir: { authorized: true, pathHint: 'reports/out', label: '报表目录' } } });
        const created = await createConnectorTask('reports.list_files', { deviceId, limit: 10 }, user);
        taskId = created.id;
        const claimed = await claimConnectorTask(user, { deviceId });
        assert.equal(claimed.status, 'claimed');
        assert.equal(claimed.task.id, taskId);
        assert.equal(claimed.task.input.deviceId, undefined, '设备选择不应回传给本机工具输入');
        await completeConnectorTask(user, taskId, { deviceId, claimToken: claimed.claimToken, success: true, result: { files: ['a.xlsx'] } });
        assert.deepEqual(await waitForConnectorTask(taskId, user, 1000), { files: ['a.xlsx'] });
    } finally {
        if (taskId) await pool().query('DELETE FROM agent_local_connector_tasks WHERE id = $1', [taskId]);
        await pool().query('DELETE FROM agent_local_connector_grants WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_device_nonces WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_devices WHERE device_id = $1', [deviceId]);
    }
});

test('本机浏览器连接器要求设备、授权浏览器和精确站点白名单', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-local-browser-${suffix}`);
    const user = { ...(await ensureUser(`pivot_local_browser_${suffix}`)), tenant_id: tenantId };
    const deviceId = `device-${suffix}-browser`;
    let taskId = '';
    try {
        await registerTestDevice(user, deviceId);
        await heartbeatConnector(user, {
            deviceId,
            grants: {
                local_browser: {
                    authorized: true,
                    label: '2 个已授权浏览器',
                    browsers: [
                        { id: 'edge-local-test', label: 'Microsoft Edge', engine: 'chromium' },
                        { id: 'firefox-local-test', label: 'Firefox', engine: 'firefox' }
                    ],
                    allowedOrigins: ['http://10.12.0.20:8080']
                }
            }
        });
        await assert.rejects(
            () => createConnectorTask('browser.inspect', { deviceId, browserId: 'edge-local-test', url: 'http://10.12.0.21:8080/' }, user),
            error => error.code === 'LOCAL_BROWSER_ORIGIN_FORBIDDEN'
        );
        const created = await createConnectorTask('browser.inspect', { deviceId, browserId: 'firefox-local-test', url: 'http://10.12.0.20:8080/portal' }, user);
        taskId = created.id;
        const listedTools = await listCachedMcpTools(0, user);
        const browserTool = listedTools.find(tool => tool.fullName === 'mcp.0.browser.inspect' && tool.localDevice?.deviceId === deviceId);
        assert.ok(browserTool, '已授权设备必须在工具目录中公开本机浏览器工具');
        assert.deepEqual(browserTool.input_schema.properties.browserId.enum, ['edge-local-test', 'firefox-local-test']);
        const claimed = await claimConnectorTask(user, { deviceId });
        assert.equal(claimed.status, 'claimed');
        assert.equal(claimed.task.toolName, 'browser.inspect');
        assert.equal(claimed.task.input.browserId, 'firefox-local-test');
        assert.equal(claimed.task.input.deviceId, undefined, '设备选择不得下发给本机浏览器执行输入');
        assert.ok(new Date(claimed.leaseExpiresAt).getTime() - Date.now() > 8 * 60 * 1000, '本机浏览器登录任务需要长租约');
        await completeConnectorTask(user, taskId, { deviceId, claimToken: claimed.claimToken, success: true, result: { title: '内网门户', text: '已读取' } });
        assert.equal((await waitForConnectorTask(taskId, user, 1000)).title, '内网门户');
    } finally {
        if (taskId) await pool().query('DELETE FROM agent_local_connector_tasks WHERE id = $1', [taskId]);
        await pool().query('DELETE FROM agent_local_connector_grants WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_device_nonces WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_devices WHERE device_id = $1', [deviceId]);
    }
});

test('本机交付四条件缺一即拒，领取回执与摘要不一致处置符合状态机', skipWithoutDatabase, async () => {
    const tenantId = await ensureTenant(`pivot-tenant-a-${suffix}`);
    const user = { ...(await ensureUser(`pivot_delivery_${suffix}`)), tenant_id: tenantId };
    const { runId, artifactId } = await createRunAndArtifact(user);
    const deviceId = `device-${suffix}-delivery`;
    try {
        const { sign } = await registerTestDevice(user, deviceId);
        const rendered = await createRendition({ user, artifactId, runId, toolCallId: `${runId}:1`, ir: documentIr(), format: 'docx' });
        const renditionId = rendered.rendition.id;

        // 缺目录授权：拒绝。
        await assert.rejects(
            () => createDeliveryIntent(user, { renditionId, channel: 'local_device', deviceId }),
            error => error.code === 'ARTIFACT_DELIVERY_GRANT_REQUIRED'
        );
        // 缺设备：拒绝。
        await assert.rejects(
            () => createDeliveryIntent(user, { renditionId, channel: 'local_device' }),
            error => error.code === 'AGENT_DEVICE_ID_INVALID'
        );
        // Agent 不得创建交付意图。
        await assert.rejects(
            () => createDeliveryIntent(user, { renditionId, channel: 'web_download', actorType: 'agent' }),
            error => error.code === 'ARTIFACT_DELIVERY_ACTOR_FORBIDDEN'
        );

        const grantChallenge = await issueDeviceChallenge(user, { purpose: 'grant', deviceId });
        const pathHint = '交付测试目录';
        const grant = await registerOutputGrant(user, {
            deviceId,
            pathHint,
            allowedFormats: ['docx'],
            nonce: grantChallenge.nonce,
            signature: sign(`grant:${grantChallenge.nonce}:${deviceId}:${pathHint}`)
        });
        assert.ok(grant.id);

        const created = await createDeliveryIntent(user, {
            renditionId,
            channel: 'local_device',
            deviceId,
            targetDirGrant: grant.id,
            targetFilename: '年度核查通知'
        });
        assert.equal(created.reused, false);
        assert.equal(created.intent.state, 'pending');
        assert.equal(created.intent.target_filename, '年度核查通知.docx');
        const duplicated = await createDeliveryIntent(user, {
            renditionId,
            channel: 'local_device',
            deviceId,
            targetDirGrant: grant.id,
            targetFilename: '年度核查通知'
        });
        assert.equal(duplicated.reused, true, '服务端唯一键必须使重复创建返回既有意图');
        assert.equal(duplicated.intent.id, created.intent.id);

        const claimed = await claimDeliveryIntent(user, { deviceId, workerId: 'integration-worker' });
        assert.equal(claimed.status, 'claimed');
        assert.equal(claimed.intent.id, created.intent.id);
        assert.match(claimed.claimToken, /^[0-9a-f]{64}$/);
        assert.equal(claimed.rendition.contentDigest, rendered.rendition.content_digest);
        assert.ok(claimed.downloadToken, '领取时必须签发一次性下载令牌');

        // 旧 claim token 之外的凭据不能确认交付。
        await assert.rejects(
            () => confirmDelivery(user, { intentId: created.intent.id, claimToken: 'f'.repeat(64), confirmedDigest: rendered.rendition.content_digest }),
            error => error.code === 'ARTIFACT_DELIVERY_CLAIM_INVALID'
        );
        // 摘要不一致：记 failed 且不重试。
        await assert.rejects(
            () => confirmDelivery(user, { intentId: created.intent.id, claimToken: claimed.claimToken, confirmedDigest: 'a'.repeat(64) }),
            error => error.code === 'ARTIFACT_DELIVERY_DIGEST_MISMATCH'
        );
        const afterMismatch = await pool().query('SELECT state, failure_code FROM agent_artifact_delivery_intents WHERE id = $1', [created.intent.id]);
        assert.equal(afterMismatch.rows[0].state, 'failed');
        assert.equal(afterMismatch.rows[0].failure_code, 'digest_mismatch');

        // 重新发起一条意图完成正向交付。
        const second = await createDeliveryIntent(user, {
            renditionId,
            channel: 'local_device',
            deviceId,
            targetDirGrant: grant.id,
            targetFilename: '年度核查通知-第二次'
        });
        const secondClaim = await claimDeliveryIntent(user, { deviceId, workerId: 'integration-worker' });
        assert.equal(secondClaim.intent.id, second.intent.id);
        const confirmed = await confirmDelivery(user, {
            intentId: second.intent.id,
            claimToken: secondClaim.claimToken,
            confirmedDigest: rendered.rendition.content_digest,
            pathHint: '年度核查通知-第二次.docx'
        });
        assert.equal(confirmed.intent.state, 'delivered');
        // 已 delivered 的意图再次回执直接返回既有结果，不重复写文件。
        const replay = await confirmDelivery(user, { intentId: second.intent.id, claimToken: secondClaim.claimToken, confirmedDigest: rendered.rendition.content_digest });
        assert.equal(replay.reused, true);

        // 租约到期回收：把租约时间改到过去后回收，意图回到 pending 且 attempt_count 增加。
        const third = await createDeliveryIntent(user, {
            renditionId, channel: 'local_device', deviceId, targetDirGrant: grant.id, targetFilename: '年度核查通知-第三次'
        });
        const thirdClaim = await claimDeliveryIntent(user, { deviceId, workerId: 'integration-worker' });
        assert.equal(thirdClaim.intent.id, third.intent.id);
        await pool().query("UPDATE agent_artifact_delivery_intents SET lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [third.intent.id]);
        const reclaimed = await reclaimDeliveryIntents();
        assert.ok(reclaimed.reclaimed >= 1);
        const afterReclaim = await pool().query('SELECT state, attempt_count FROM agent_artifact_delivery_intents WHERE id = $1', [third.intent.id]);
        assert.equal(afterReclaim.rows[0].state, 'pending');
        assert.ok(Number(afterReclaim.rows[0].attempt_count) >= 2);
        // 旧 claim token 在重新回到 pending 后必须失效。
        await assert.rejects(
            () => failDelivery(user, { intentId: third.intent.id, claimToken: thirdClaim.claimToken, failureCode: 'stale' }),
            error => error.code === 'ARTIFACT_DELIVERY_STATE_CONFLICT'
        );

        // 撤销目录授权：该授权下的 pending 意图立即 cancelled。
        await revokeOutputGrant(user, grant.id);
        const afterGrantRevoke = await pool().query('SELECT state, failure_code FROM agent_artifact_delivery_intents WHERE id = $1', [third.intent.id]);
        assert.equal(afterGrantRevoke.rows[0].state, 'cancelled');
        assert.equal(afterGrantRevoke.rows[0].failure_code, 'grant_revoked');

        // 审计链可按摘要反查到 rendition 与格式。
        const admin = { ...user, role: 'admin' };
        const trace = await traceDeliveryChain(admin, { contentDigest: rendered.rendition.content_digest });
        assert.ok(trace.length >= 2);
        assert.ok(trace.some(item => item.event_type === 'delivered'));
        assert.ok(trace.every(item => !String(item.path_hint || '').includes(':')), '审计事件不得保存终端完整绝对路径');

        // 撤销设备：其名下在途意图立即 cancelled。
        const fourthGrantChallenge = await issueDeviceChallenge(user, { purpose: 'grant', deviceId });
        const secondGrant = await registerOutputGrant(user, {
            deviceId, pathHint: pathHint, allowedFormats: ['docx'],
            nonce: fourthGrantChallenge.nonce,
            signature: sign(`grant:${fourthGrantChallenge.nonce}:${deviceId}:${pathHint}`)
        });
        const fourth = await createDeliveryIntent(user, {
            renditionId, channel: 'local_device', deviceId, targetDirGrant: secondGrant.id, targetFilename: '年度核查通知-第四次'
        });
        await revokeLocalDevice(user, deviceId);
        const afterDeviceRevoke = await pool().query('SELECT state, failure_code FROM agent_artifact_delivery_intents WHERE id = $1', [fourth.intent.id]);
        assert.equal(afterDeviceRevoke.rows[0].state, 'cancelled');
        assert.equal(afterDeviceRevoke.rows[0].failure_code, 'device_revoked');
        // 设备撤销后不能再领取。
        await assert.rejects(
            () => claimDeliveryIntent(user, { deviceId }),
            error => error.code === 'AGENT_DEVICE_NOT_REGISTERED'
        );
    } finally {
        await pool().query('DELETE FROM agent_artifact_delivery_events WHERE run_id = $1', [runId]);
        await pool().query('DELETE FROM agent_artifact_delivery_intents WHERE run_id = $1', [runId]);
        await pool().query('DELETE FROM agent_artifact_renditions WHERE run_id = $1', [runId]);
        await pool().query('DELETE FROM agent_local_output_grants WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_device_nonces WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_local_devices WHERE device_id = $1', [deviceId]);
        await pool().query('DELETE FROM agent_artifacts WHERE id = $1', [artifactId]);
        await pool().query('DELETE FROM agent_runs WHERE id = $1', [runId]);
    }
});

test('企业访问开启且用户无租户归属时，共享解析与交付令牌全部拒绝', skipWithoutDatabase, async () => {
    const user = await ensureUser(`pivot_notenant_${suffix}`, 'user');
    const previous = process.env.PIVOT_ENTERPRISE_ACCESS;
    process.env.PIVOT_ENTERPRISE_ACCESS = 'true';
    try {
        const catalog = await listAgentSkillsForUser(user);
        assert.ok(Array.isArray(catalog), '目录查询必须降级为仅本人技能而不是抛错');
        assert.equal(catalog.some(item => item.scope === 'shared' || item.scope === 'global'), false);
        await assert.rejects(
            () => createSkillVersion(user, { manifest: { id: 'x.y', name: 'x', version: '1.0.0' }, requireSignature: false }),
            error => error.code === 'SKILL_TENANT_UNRESOLVED'
        );
        await assert.rejects(
            () => getRenditionForUser(1, user),
            error => error.code === 'SKILL_TENANT_UNRESOLVED'
        );
    } finally {
        if (previous === undefined) delete process.env.PIVOT_ENTERPRISE_ACCESS;
        else process.env.PIVOT_ENTERPRISE_ACCESS = previous;
    }
});
