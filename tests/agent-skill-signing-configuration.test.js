const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };
const {
    ORGANIZATION_SIGNING_KEYRING_SETTING,
    disableManagedOrganizationSigning,
    generateManagedOrganizationSigningKey,
    getOrganizationSigningConfigStatus,
    getOrganizationSigningKey,
    getOrganizationSigningPublicKey
} = require('../server/services/agent-skill-signing-configuration');
const { deleteAppSettingAsync, getAppSettingRowAsync, setAppSettingAsync } = require('../server/services/app-settings');
const { signOrganizationEnvelope, verifyEnvelopeSignature } = require('../server/services/agent-skill-signing');
const { createSkillVersion, publishSkillVersion, validateSkillVersion } = require('../server/services/agent-releases');

function pool() {
    return require('../server/db/pg-connection').getPgPool();
}

const environmentKeys = [
    'AGENT_SKILL_PUBLIC_KEY',
    'AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64',
    'AGENT_SKILL_ORGANIZATION_PRIVATE_KEY',
    'AGENT_SKILL_ORGANIZATION_KEY_ID'
];

async function withManagedKeyring(callback) {
    const previousSetting = await getAppSettingRowAsync(ORGANIZATION_SIGNING_KEYRING_SETTING);
    const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    await deleteAppSettingAsync(ORGANIZATION_SIGNING_KEYRING_SETTING);
    try {
        return await callback();
    } finally {
        if (previousSetting) {
            await setAppSettingAsync(previousSetting.key, previousSetting.value, {
                updatedAt: previousSetting.updated_at,
                updatedBy: previousSetting.updated_by
            });
        } else {
            await deleteAppSettingAsync(ORGANIZATION_SIGNING_KEYRING_SETTING);
        }
        for (const key of environmentKeys) {
            if (previousEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnvironment[key];
        }
    }
}

async function createTenantAdmin() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const organization = await pool().query(
        "INSERT INTO organizations (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
        [`签名配置测试 ${suffix}`, `signing-config-${suffix}`]
    );
    const user = await pool().query(
        "INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, 'hash', $1, 'QA', 'admin', 'active', NOW()) RETURNING id, username, role",
        [`signing_config_admin_${suffix}`]
    );
    return { tenantId: Number(organization.rows[0].id), user: user.rows[0], suffix };
}

async function cleanupSkill(name) {
    await pool().query('DELETE FROM agent_skill_releases WHERE name = $1', [name]);
    await pool().query('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = $1)', [name]);
    await pool().query('DELETE FROM agent_skills WHERE name = $1', [name]);
    await pool().query('DELETE FROM agent_skill_versions WHERE name = $1', [name]);
}

test('托管组织签名密钥加密保存、轮换后仍可复验历史签名，并可安全停用', skipWithoutDatabase, async () => {
    let envelopeId = 0;
    await withManagedKeyring(async () => {
        assert.equal(getOrganizationSigningConfigStatus().configured, false);
        const generated = await generateManagedOrganizationSigningKey({ userId: 1 });
        assert.equal(generated.configured, true);
        assert.equal(generated.source, 'managed');
        assert.ok(generated.activeKeyId);
        assert.equal(JSON.stringify(generated).includes('PRIVATE KEY'), false, '状态接口不得包含私钥');

        const stored = await getAppSettingRowAsync(ORGANIZATION_SIGNING_KEYRING_SETTING);
        assert.match(String(stored?.value || ''), /^enc:v1:/, '托管私钥必须以加密形式保存');
        assert.equal(String(stored?.value || '').includes('PRIVATE KEY'), false, '数据库密文不得包含 PEM 明文');

        const active = getOrganizationSigningKey();
        assert.ok(active?.privateKey, '服务端应能解析活动私钥');
        assert.equal(getOrganizationSigningPublicKey(active.keyId), active.publicKey);

        const manifest = {
            schemaVersion: 1,
            id: 'integration.managed-signing',
            name: 'managed-signing',
            version: '1.0.0',
            capabilities: ['knowledge.search'],
            tools: ['rag.search'],
            inputs: {},
            outputs: {}
        };
        const envelope = await signOrganizationEnvelope({
            manifest,
            contentDigest: crypto.randomBytes(32).toString('hex')
        });
        envelopeId = Number(envelope.id);
        assert.equal(verifyEnvelopeSignature(envelope, { manifest }).verified, true);

        const rotated = await generateManagedOrganizationSigningKey({ userId: 1 });
        assert.notEqual(rotated.activeKeyId, active.keyId);
        assert.equal(rotated.keys.some(key => key.keyId === active.keyId && key.status === 'retired'), true);
        assert.equal(verifyEnvelopeSignature(envelope, { manifest }).verified, true, '轮换后必须仍能复验历史信封');

        const disabled = await disableManagedOrganizationSigning({ userId: 1 });
        assert.equal(disabled.configured, false);
        assert.equal(verifyEnvelopeSignature(envelope, { manifest }).verified, true, '停用新签名不应破坏历史复验');
    });
    if (envelopeId) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [envelopeId]);
});

test('管理员一键共享发布使用托管组织签名密钥，不依赖环境变量', skipWithoutDatabase, async () => {
    const { tenantId, user: persistedUser, suffix } = await createTenantAdmin();
    const user = { ...persistedUser, id: Number(persistedUser.id), tenant_id: tenantId };
    const name = `managed-publish-${suffix}`;
    let envelopeId = 0;
    await withManagedKeyring(async () => {
        const signing = await generateManagedOrganizationSigningKey({ userId: user.id });
        const version = await createSkillVersion(user, {
            manifest: {
                schemaVersion: 1,
                id: `integration.${name}`,
                name,
                version: '1.0.0',
                capabilities: ['knowledge.search'],
                tools: ['rag.search'],
                inputs: {},
                outputs: {}
            },
            strictSpec: true,
            requireSignature: false
        });
        assert.equal((await validateSkillVersion(version.id, user, { strictSpec: true, requireSignature: false })).passed, true);
        const release = await publishSkillVersion(version.id, user, { scope: 'organization' });
        assert.equal(release.autoApproved, true);
        assert.equal(release.organizationSigningKeyId, signing.activeKeyId);
        const row = await pool().query('SELECT signing_envelope_id FROM agent_skill_versions WHERE id = $1', [version.id]);
        envelopeId = Number(row.rows[0]?.signing_envelope_id || 0);
        assert.ok(envelopeId);
        await cleanupSkill(name);
    });
    if (envelopeId) await pool().query('DELETE FROM agent_skill_signing_envelopes WHERE id = $1', [envelopeId]);
});
