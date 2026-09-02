const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { validateSkillManifest, parseSkillManifest, projectSkillReadModel } = require('./agent-skills');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');
const { publishAgentWorkflowVersion, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { getAgentEvalRun } = require('./agent-evaluations');
const { createAgentInboxEvent } = require('./agent-inbox');
const { getPrimaryTenantId, getUserEnterpriseContext } = require('./enterprise-access');
const { assertTenantContext, resolveTenantContext } = require('./agent-tenant-context');
const { RELEASE_SCOPES, deriveOwnerKey, normalizeReleaseScope } = require('./agent-skill-scope');
const {
    evaluateSkillReleaseAccess,
    evaluateSkillVersionAccess,
    isTenantAdmin,
    resolveAccessSubjects
} = require('./agent-skill-access');
const {
    chooseRolloutRelease,
    normalizeBreakerThresholds
} = require('./agent-skill-rollout');
const {
    registerVerifiedEnvelope,
    signOrganizationEnvelope,
    verifyEnvelopeForVersion
} = require('./agent-skill-signing');
const { scanSkillPackageEntries } = require('./agent-skill-supply-chain');
const { capabilitiesCoverTool } = require('./agent-capability-registry');
const { isRegisteredToolName, resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');
const { recordSkillReleaseResolveMiss } = require('./agent-governance-metrics');
const { withControlPlaneFallback } = require('./agent-control-plane-state');

const MAX_SCANNED_PACKAGE_FILES = 256;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

function invalid(message, status = 400, code = 'AGENT_RELEASE_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function allowedSkillPermissionsFromEnv(env = process.env) {
    const permissions = String(env.AGENT_SKILL_ALLOWED_PERMISSIONS || '').split(',').map(item => item.trim()).filter(Boolean);
    return permissions.length ? permissions : undefined;
}

/** 对数据库候选执行统一 Release ACL/成员/角色判定，避免仅靠 SQL scope 造成 ACL 旁路。 */
async function filterAccessibleReleases(releases, user, action = 'use') {
    const rows = Array.isArray(releases) ? releases : [];
    if (!rows.length) return [];
    const subjects = await resolveAccessSubjects(user);
    const decisions = await Promise.all(rows.map(release => evaluateSkillReleaseAccess({ user, release, action, subjects })));
    return rows.filter((_release, index) => decisions[index]?.allowed === true);
}

async function filterAccessibleReleasesAny(releases, user, actions = ['use']) {
    const rows = Array.isArray(releases) ? releases : [];
    if (!rows.length) return [];
    const subjects = await resolveAccessSubjects(user);
    const requiredActions = Array.isArray(actions) && actions.length ? actions : ['use'];
    const decisions = await Promise.all(rows.map(release => Promise.all(
        requiredActions.map(action => evaluateSkillReleaseAccess({ user, release, action, subjects }))
    )));
    return rows.filter((_release, index) => decisions[index].some(item => item?.allowed === true));
}

function normalizeScope(value) {
    try {
        return normalizeReleaseScope(value, 'personal');
    } catch (_) {
        throw invalid('发布范围只能是 personal、team 或 organization。');
    }
}

function normalizeIdList(value, limit) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))].slice(0, limit);
}

/**
 * 规范化灰度输入。
 * 落地方案 v1.2 §6.3：target_units 由「匹配 user.unit 字符串」迁移为 team_id 引用，
 * 并在运行时经 team_members 实时校验；熔断阈值在发布时冻结。
 */
function normalizeRollout(input = {}) {
    return {
        rolloutScope: normalizeScope(input.rolloutScope || input.rollout_scope || input.scope),
        rolloutPercent: Math.max(1, Math.min(Number.parseInt(input.rolloutPercent ?? input.rollout_percent, 10) || 100, 100)),
        targetUserIds: normalizeIdList(input.targetUserIds || input.target_user_ids, 500),
        targetUnits: normalizeIdList(input.targetTeamIds || input.target_team_ids || input.targetUnits || input.target_units, 100),
        teamId: Number.parseInt(input.teamId ?? input.team_id, 10) || null,
        breakerThresholds: normalizeBreakerThresholds(input.breakerThresholds || input.breaker_thresholds)
    };
}

/**
 * 读取已安装包目录的实际条目并执行供应链扫描。
 * 落地方案 v1.2 B7：扫描对象必须是实际文件，而不是 manifest.files 自报清单。
 */
function scanInstalledPackage(packageRoot, manifest) {
    const root = String(packageRoot || '').trim();
    if (!root || !fs.existsSync(root)) {
        return scanSkillPackageEntries([], manifest);
    }
    const entries = [];
    const walk = (directory, prefix = '') => {
        if (entries.length >= MAX_SCANNED_PACKAGE_FILES) return;
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entries.length >= MAX_SCANNED_PACKAGE_FILES) return;
            const absolute = path.join(directory, item.name);
            const relative = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isSymbolicLink()) {
                entries.push({ name: relative, data: Buffer.alloc(0), externalFileAttributes: 0xA1FF0000 });
                continue;
            }
            if (item.isDirectory()) { walk(absolute, relative); continue; }
            if (!item.isFile()) continue;
            const stat = fs.statSync(absolute);
            const data = stat.size <= MAX_SCANNED_FILE_BYTES ? fs.readFileSync(absolute) : Buffer.alloc(0);
            entries.push({
                name: relative,
                data,
                compressedSize: stat.size,
                uncompressedSize: stat.size,
                externalFileAttributes: 0
            });
        }
    };
    walk(root);
    return scanSkillPackageEntries(entries, manifest);
}

/**
 * 平台声明式验证（替换 manifest.tests[].script 执行）。
 * 落地方案 v1.2 B2、阶段 0.9：隔离 Worker 落地前不执行包内任何脚本，
 * 改为对声明本身做可验证的断言 —— 工具必须已登记，且技能声明的能力必须覆盖工具所需能力。
 */
function runDeclarativeSkillChecks(checked) {
    const errors = [];
    const toolAssertions = [];
    checked.tools.forEach(name => {
        if (!isRegisteredToolName(name)) {
            errors.push(`技能声明的工具未在平台登记：${name}`);
            toolAssertions.push({ tool: name, registered: false, covered: false });
            return;
        }
        const required = resolveRegisteredToolCapabilities(name);
        const covered = capabilitiesCoverTool(checked.capabilities, required);
        if (!covered) errors.push(`技能声明的能力未覆盖工具 ${name} 所需能力（${required.join('、')}）。`);
        toolAssertions.push({ tool: name, registered: true, covered, requiredCapabilities: required });
    });
    const manifest = checked.manifest || {};
    ['inputs', 'outputs'].forEach(field => {
        if (manifest[field] === undefined) return;
        if (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field])) {
            errors.push(`manifest.${field} 必须是对象。`);
        }
    });
    if (Array.isArray(manifest.tests) || Array.isArray(manifest.regressionTests)) {
        errors.push('manifest.tests 中的可执行脚本已被禁止，请改用平台声明式验证。');
    }
    return {
        passed: errors.length === 0,
        mode: 'platform-declarative',
        scriptsExecuted: false,
        skipReason: '隔离执行环境未启用，包内脚本一律不执行（落地方案 v1.2 阶段 0.9）。',
        toolAssertions,
        errors
    };
}

async function sandboxValidateSkill({ version, packageRoot = '', user, options = {} }) {
    const root = packageRoot && fs.existsSync(packageRoot) ? packageRoot : path.dirname(__filename);
    const jail = createWorkspaceJail(options.workspaceRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-release-sandbox'), `skill-${version.id}`);
    const staged = jail.resolve('package');
    fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
    fs.cpSync(root, staged, { recursive: true, force: false, errorOnExist: false });
    // 固定的平台静态脚本，内容不来自 manifest；仅确认制品目录可读，不执行包内代码。
    const staticScript = [
        'const fs=require("fs");',
        'const p=process.argv[1];',
        'if(!fs.existsSync(p)) process.exit(2);',
        'const s=fs.statSync(p);',
        'if(!s.isDirectory()) process.exit(3);',
        'process.stdout.write(JSON.stringify({ok:true,files:fs.readdirSync(p).length}));'
    ].join('');
    const result = await runSandboxedProcess(process.execPath, ['-e', staticScript, staged], {
        jail,
        strictIsolation: options.strictIsolation ?? (process.env.PIVOT_AGENT_STRICT_ISOLATION === '1' || process.env.PIVOT_AGENT_STRICT_ISOLATION === 'true'),
        networkDisabled: true,
        timeoutMs: Math.min(Math.max(Number(options.timeoutMs) || 30000, 1000), 120000),
        inheritEnv: false,
        user
    });
    return {
        passed: result.code === 0,
        mode: 'isolated-static-sandbox',
        sideEffects: false,
        packageScriptsExecuted: false,
        result: { code: result.code, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000), isolation: result.isolation }
    };
}

/**
 * 创建技能版本草稿。
 * 落地方案 v1.2 A2、B1、阶段 0.4：
 * 1. ownerKey 一律服务端推导，入参携带 ownerKey 视为越权尝试并直接拒绝；
 * 2. manifest.scope 不参与任何权限推导；
 * 3. 签名一律服务端校验并落成签名信封，input.signatureVerified 不再被读取（旁路关闭）。
 */
async function createSkillVersion(user, input = {}) {
    if (input.ownerKey !== undefined || input.owner_key !== undefined) {
        throw invalid('ownerKey 由服务端依据发布范围与发布者身份推导，不接受外部传入。', 403, 'SKILL_OWNER_KEY_FORBIDDEN');
    }
    const manifest = parseSkillManifest(input.manifest || input.manifestYaml || {});
    const checked = validateSkillManifest(manifest, {
        allowedPermissions: input.allowedPermissions,
        allowedTools: input.allowedTools,
        strictSpec: input.strictSpec === true
    });
    if (!checked.valid) throw invalid(`Skill Manifest 校验失败：${checked.errors.join('；')}`, 422, 'SKILL_MANIFEST_INVALID');
    const tenant = await assertTenantContext(user);
    const packageRoot = String(input.packageRoot || '').trim();
    const supplyChain = scanInstalledPackage(packageRoot, manifest);
    if (!supplyChain.passed) throw invalid(supplyChain.errors.join('；'), 422, 'SKILL_SUPPLY_CHAIN_INVALID');
    // 签名信封：detached 优先（包签名），否则使用 manifest 内嵌签名。两者都走同一校验实现。
    const detachedSignature = String(input.packageSignature || input.package_signature || '').trim();
    const signatureForm = detachedSignature ? 'detached' : 'embedded';
    const signedPackageDigest = detachedSignature
        ? String(input.packageDigest || manifest.package_digest || checked.computedDigest).replace(/^sha256:/i, '')
        : '';
    // 个人 SKILL.md 草稿可以无签名创建；签名门禁只适用于兼容包导入和后续共享发布。
    // 即便用户自带 signature，也只在有受信公钥时记录为可验证信封，绝不信任“已验证”入参。
    const registered = await registerVerifiedEnvelope({
        contentDigest: detachedSignature
            ? signedPackageDigest
            : checked.computedDigest,
        signature: detachedSignature || String(manifest.signature || ''),
        signatureForm,
        keyId: input.keyId || manifest.keyId || 'default',
        algorithm: input.algorithm,
        expiresAt: input.signatureExpiresAt || null
    }, { ...input, requireSignature: input.requireSignature === true, manifest: checked.manifest });
    const ownerKey = deriveOwnerKey({ scope: 'personal', userId: user.id, tenantId: tenant.tenantId });
    // 分离式签名覆盖整个包摘要；将其写入版本 digest，确保后续验证能将信封与版本权威摘要关联。
    const digest = detachedSignature
        ? `sha256:${signedPackageDigest}`
        : (manifest.package_digest ? String(manifest.package_digest) : `sha256:${checked.computedDigest}`);
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_skill_versions
            (skill_id, owner_key, name, version, digest, content_digest, manifest_yaml, manifest_json, instructions_md,
             package_path, source_run_id, tenant_id, signing_envelope_id, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
        RETURNING id
    `, [
        String(manifest.id), ownerKey, String(manifest.name), String(manifest.version), String(digest), checked.computedDigest,
        JSON.stringify(manifest), JSON.stringify(checked.manifest), String(input.instructions || ''),
        packageRoot, input.sourceRunId || null, tenant.tenantId, registered.envelope?.id || null, user.id, now, now
    ]);
    return getSkillVersion(row?.id, user);
}

/**
 * 读取技能版本。
 * 落地方案 v1.2 C5：由「created_by 硬绑定」改为角色、租户、团队与 ACL 组合判定；
 * 无权访问时返回 null，保持路由层 404 语义，避免泄露版本是否存在。
 */
async function getSkillVersion(id, user, options = {}) {
    const version = await withControlPlaneFallback(
        () => queryOne('SELECT * FROM agent_skill_versions WHERE id = ?', [id]),
        null
    );
    if (!version) return null;
    const decision = await evaluateSkillVersionAccess({ user, version, action: options.action || 'read' });
    return decision.allowed ? version : null;
}

async function validateSkillVersion(id, user, options = {}) {
    const version = await getSkillVersion(id, user, { action: 'write' });
    if (!version) return null;
    const manifest = parseJson(version.manifest_json || version.manifest_yaml, {});
    const checked = validateSkillManifest(manifest, {
        allowedPermissions: options.allowedPermissions,
        allowedTools: options.allowedTools,
        strictSpec: options.strictSpec === true
    });
    const signature = await verifyEnvelopeForVersion(version, { ...options, manifest: checked.manifest });
    const supplyChain = scanInstalledPackage(version.package_path, manifest);
    const dependencies = {
        passed: supplyChain.passed,
        dependencies: supplyChain.dependencies || {},
        lockFiles: supplyChain.lockFiles || [],
        errors: supplyChain.errors
    };
    // 普通个人验证不要求签名；共享批准流程和 .skill.zip 导入会显式传 requireSignature=true。
    const signatureRequired = options.requireSignature === true || Boolean(String(version.package_path || '').trim());
    const signatureAccepted = signature.verified || !signatureRequired;
    const declarative = runDeclarativeSkillChecks(checked);
    let sandbox = { passed: false, mode: 'not-run', sideEffects: true, packageScriptsExecuted: false };
    if (checked.valid && signatureAccepted && supplyChain.passed) {
        sandbox = await sandboxValidateSkill({ version, packageRoot: version.package_path, user, options });
    }
    const evaluation = options.evaluationRunId ? await getAgentEvalRun(options.evaluationRunId, user) : null;
    const evaluationResult = options.evaluationRunId
        ? { passed: Boolean(evaluation?.run && Number(evaluation.run.summary?.passRate || 0) >= Number(options.minPassRate || 80)), evalRunId: options.evaluationRunId, passRate: Number(evaluation?.run?.summary?.passRate || 0) }
        : { passed: true, fixedSuite: 'skill-platform-declarative' };
    const passed = checked.valid && signatureAccepted && supplyChain.passed && sandbox.passed && declarative.passed && evaluationResult.passed;
    const now = getBeijingTimestamp();
    const finalEvaluation = { ...evaluationResult, declarative };
    const evidence = {
        contentDigest: version.content_digest || '',
        packageDigest: String(version.digest || ''),
        signingEnvelopeId: version.signing_envelope_id || null,
        signatureForm: signature.signatureForm || '',
        supplyChainScope: supplyChain.scope,
        scannedEntries: supplyChain.scannedEntries
    };
    await execute(`
        INSERT INTO agent_skill_validations
            (skill_version_id, user_id, status, manifest_result, signature_result, dependency_result, supply_chain_result,
             sandbox_result, evaluation_result, evidence_ref, risk_level, error_code, error_message, version, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        version.id, user.id, passed ? 'passed' : 'failed',
        JSON.stringify(checked), JSON.stringify(signature), JSON.stringify(dependencies), JSON.stringify(supplyChain),
        JSON.stringify(sandbox), JSON.stringify(finalEvaluation), JSON.stringify(evidence),
        passed ? 'low' : 'high',
        passed ? '' : 'SKILL_VALIDATION_FAILED',
        passed ? '' : [
            ...checked.errors,
            ...supplyChain.errors,
            ...declarative.errors,
            signatureRequired && !signature.verified ? `签名校验未通过（${signature.reason || '未签名'}）` : '',
            sandbox.result?.stderr || '',
            evaluationResult.passed ? '' : '固定评测集未通过'
        ].filter(Boolean).join('；').slice(0, 4000),
        Number(options.version || 1), now, now
    ]);
    await execute('UPDATE agent_skill_versions SET status = ?, updated_at = ? WHERE id = ?', [passed ? 'validated' : 'draft', now, version.id]);
    return {
        version: await getSkillVersion(id, user),
        passed,
        manifest: checked,
        signature,
        dependencies,
        supplyChain,
        sandbox,
        declarative,
        evaluation: finalEvaluation
    };
}

/** 解析并校验团队归属：团队必须属于当前租户，且发布者是成员或租户管理员。 */
async function resolveReleaseTeam(user, tenantId, teamId) {
    const safeTeamId = Number.parseInt(teamId, 10) || 0;
    if (!safeTeamId) throw invalid('团队范围发布必须指定 teamId。', 409, 'SKILL_TENANT_UNRESOLVED');
    const context = await getUserEnterpriseContext(user.id);
    const membership = (context.teams || []).find(team => Number(team.id) === safeTeamId);
    if (membership) {
        if (Number(membership.organizationId) !== Number(tenantId)) {
            throw invalid('指定团队不属于当前租户。', 409, 'SKILL_TENANT_UNRESOLVED');
        }
        return safeTeamId;
    }
    if (!isTenantAdmin(user)) throw invalid('只能向本人所属团队发布技能。', 403, 'SKILL_ROLLOUT_SCOPE_FORBIDDEN');
    const team = await queryOne('SELECT id, organization_id FROM teams WHERE id = ? AND status = ?', [safeTeamId, 'active']);
    if (!team || Number(team.organization_id) !== Number(tenantId)) {
        throw invalid('指定团队不属于当前租户。', 409, 'SKILL_TENANT_UNRESOLVED');
    }
    return safeTeamId;
}

async function publishSkillVersion(id, user, input = {}) {
    let version = await getSkillVersion(id, user, { action: 'write' });
    if (!version) return null;
    const validation = await queryOne('SELECT status FROM agent_skill_validations WHERE skill_version_id = ? ORDER BY version DESC, created_at DESC LIMIT 1', [version.id]);
    // 同一版本可以先发布给个人、再由管理员共享；个人发布会将版本状态标为 published，
    // 但不能因此丢失已通过的验证资格。仍以最近一次验证通过作为硬门禁。
    if (!['validated', 'published'].includes(String(version.status || '')) || validation?.status !== 'passed') {
        throw invalid('Skill 必须通过完整验证后才能发布。', 409, 'SKILL_RELEASE_GATE_FAILED');
    }
    const rollout = normalizeRollout(input);
    const tenant = await assertTenantContext(user);
    if (rollout.rolloutScope !== 'personal') {
        const candidate = await queryOne("SELECT status FROM agent_evolution_proposals WHERE artifact_version_id = ? AND tenant_id = ? AND scope = 'organization_candidate' ORDER BY created_at DESC LIMIT 1", [String(version.id), tenant.tenantId]);
        if (candidate && candidate.status !== 'versioned_draft') {
            throw invalid('该 Skill 是组织共享候选，必须先在候选治理流程中完成审批与验证。', 409, 'EVOLUTION_CANDIDATE_GATE_REQUIRED');
        }
    }
    const teamId = rollout.rolloutScope === 'team' ? await resolveReleaseTeam(user, tenant.tenantId, rollout.teamId) : null;
    const ownerKey = deriveOwnerKey({ scope: rollout.rolloutScope, userId: user.id, tenantId: tenant.tenantId, teamId });
    let automaticApproval = null;
    if (rollout.rolloutScope !== 'personal') {
        // 管理员可在共享发布操作中一并完成批准和组织签名；个人发布不需要组织签名。
        // 普通用户仍不能借此路径自签名，必须使用已获管理员批准的版本。
        const manifest = parseJson(version.manifest_json || version.manifest_yaml, {});
        const signature = await verifyEnvelopeForVersion(version, { manifest, requireSignature: true });
        if (!signature.verified) {
            if (!isTenantAdmin(user)) {
                throw invalid('团队或组织共享前必须由管理员批准并完成组织签名。', 409, 'SKILL_SHARED_SIGNATURE_REQUIRED');
            }
            automaticApproval = await approveSkillVersionForSharing(version.id, user);
            if (!automaticApproval) return null;
            version = await getSkillVersion(version.id, user, { action: 'write' });
            if (!version) return null;
        }
        const decision = await evaluateSkillReleaseAccess({
            user,
            release: { id: 0, tenant_id: tenant.tenantId, team_id: teamId, rollout_scope: rollout.rolloutScope, owner_key: ownerKey },
            action: 'publish'
        });
        if (!decision.allowed) throw invalid(decision.reason || '团队或组织 Skill 发布需要相应发布权限。', 403, 'SKILL_ROLLOUT_SCOPE_FORBIDDEN');
    }
    const previous = await queryOne("SELECT * FROM agent_skill_releases WHERE owner_key = ? AND name = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1", [ownerKey, version.name]);
    const now = getBeijingTimestamp();
    const release = await queryOne(`
        INSERT INTO agent_skill_releases
            (skill_version_id, owner_key, name, tenant_id, team_id, rollout_scope, rollout_percent, rollout_secret_version,
             target_user_ids, target_units, breaker_thresholds, status, previous_release_id, published_by, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
        RETURNING *
    `, [
        version.id, ownerKey, version.name, tenant.tenantId, teamId, rollout.rolloutScope, rollout.rolloutPercent,
        Number.parseInt(input.rolloutSecretVersion, 10) || 1,
        JSON.stringify(rollout.targetUserIds), JSON.stringify(rollout.targetUnits), JSON.stringify(rollout.breakerThresholds),
        previous?.id || null, user.id, now
    ]);
    await projectSkillReadModel({ version, release, ownerKey, tenantId: tenant.tenantId, actorUserId: user.id });
    await execute("UPDATE agent_skill_versions SET status = 'published', updated_at = ? WHERE id = ?", [now, version.id]);
    try {
        await createAgentInboxEvent(user, {
            eventKey: `skill.release:${release.id}`,
            eventType: 'release.published',
            sourceId: String(release.id),
            title: 'Skill 版本已发布',
            body: `${version.name}@${version.version} 已进入 ${rollout.rolloutScope} 灰度。`,
            risk: 'medium',
            payload: { releaseId: release.id, rollout }
        });
    } catch (_) {
        // 收件箱不可用不影响发布结果，发布事件仍在审计与 release 表中。
    }
    // 这是 API 返回元数据，不会写入 release 表；用于审计与界面提示一次操作完成了批准、签名和发布。
    release.autoApproved = Boolean(automaticApproval);
    release.organizationSigningKeyId = automaticApproval?.envelope?.keyId || null;
    return release;
}

/**
 * 管理员批准个人草稿进入共享候选池：服务器用组织私钥写入不可变信封，并重新跑签名门禁验证。
 * 用户只提交配方，不接触私钥；批准者与验证记录均保留审计。
 */
async function approveSkillVersionForSharing(id, user, _input = {}) {
    const version = await getSkillVersion(id, user, { action: 'manage' });
    if (!version) return null;
    if (!isTenantAdmin(user)) throw invalid('只有管理员可以批准并签名共享 Skill。', 403, 'SKILL_SHARED_APPROVAL_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    if (Number(version.tenant_id) !== Number(tenant.tenantId)) {
        throw invalid('不能用当前组织的签名批准其他租户的 Skill。', 403, 'SKILL_TENANT_MISMATCH');
    }
    const manifest = parseJson(version.manifest_json || version.manifest_yaml, {});
    const checked = validateSkillManifest(manifest, { strictSpec: true });
    if (!checked.valid) throw invalid(`Skill Manifest 校验失败：${checked.errors.join('；')}`, 422, 'SKILL_MANIFEST_INVALID');
    const envelope = await signOrganizationEnvelope({
        manifest: checked.manifest,
        contentDigest: version.content_digest || checked.computedDigest
    });
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_skill_versions SET signing_envelope_id = ?, updated_at = ? WHERE id = ?', [envelope.id, now, version.id]);
    const validation = await validateSkillVersion(version.id, user, {
        requireSignature: true,
        allowedPermissions: allowedSkillPermissionsFromEnv(),
        strictSpec: true
    });
    if (!validation?.passed) {
        const reason = validation?.signature?.reason || validation?.manifest?.errors?.[0] || validation?.declarative?.errors?.[0] || validation?.supplyChain?.errors?.[0]
            || validation?.sandbox?.result?.stderr || (validation ? '策略或评测未通过' : '签名后版本访问被拒绝');
        throw invalid(`组织签名已写入，但共享前验证未通过：${reason}`, 422, 'SKILL_SHARED_APPROVAL_VALIDATION_FAILED');
    }
    return { version: validation.version, envelope: { id: envelope.id, keyId: envelope.key_id, algorithm: envelope.algorithm, expiresAt: envelope.expires_at || null }, validation };
}

/** 读取 release 并做访问判定。无权访问返回 null，保持 404 语义。 */
async function getSkillReleaseForUser(id, user, action = 'manage') {
    const release = await withControlPlaneFallback(
        () => queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [id]),
        null
    );
    if (!release) return null;
    const decision = await evaluateSkillReleaseAccess({ user, release, action });
    return decision.allowed ? release : null;
}

/**
 * 回滚发布。
 * 落地方案 v1.2 §2.4：agent_skills 是只读投影，回滚必须同步重建投影，
 * 否则目录仍显示已回滚版本的 manifest 与 version（双表状态分叉）。
 */
async function rollbackSkillRelease(id, user) {
    const release = await getSkillReleaseForUser(id, user, 'manage');
    if (!release || release.status !== 'published') return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_skill_releases SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?", [now, id]);
    let restored = null;
    if (release.previous_release_id) {
        await execute("UPDATE agent_skill_releases SET status = 'published' WHERE id = ?", [release.previous_release_id]);
        restored = await queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [release.previous_release_id]);
    }
    if (restored) {
        const restoredVersion = await queryOne('SELECT * FROM agent_skill_versions WHERE id = ?', [restored.skill_version_id]);
        if (restoredVersion) {
            await projectSkillReadModel({
                version: restoredVersion,
                release: restored,
                ownerKey: restored.owner_key,
                tenantId: restored.tenant_id,
                actorUserId: user.id
            });
        }
    } else {
        // 没有可恢复的上一版：投影置为 disabled，避免目录继续展示已回滚内容。
        await execute("UPDATE agent_skills SET status = 'disabled', updated_at = ? WHERE owner_key = ? AND name = ?", [now, release.owner_key, release.name]);
    }
    return queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [id]);
}

/** 熔断暂停：Published → Paused。阈值由发布时冻结的 breaker_thresholds 决定。 */
async function pauseSkillRelease(id, user, reason = '') {
    const release = await getSkillReleaseForUser(id, user, 'manage');
    if (!release || release.status !== 'published') return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_skill_releases SET status = 'paused', rolled_back_at = ? WHERE id = ?", [now, id]);
    await execute("UPDATE agent_skills SET status = 'disabled', updated_at = ? WHERE owner_key = ? AND name = ?", [now, release.owner_key, release.name]);
    try {
        await createAgentInboxEvent(user, {
            eventKey: `skill.release.paused:${release.id}`,
            eventType: 'release.paused',
            sourceId: String(release.id),
            title: 'Skill 发布已自动暂停',
            body: `${release.name} 触发熔断阈值：${reason || '未说明'}。`,
            risk: 'high',
            payload: { releaseId: release.id, reason }
        });
    } catch (_) {
        // 通知失败不影响暂停结果。
    }
    return queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [id]);
}

/** 恢复暂停的发布：Paused → Published，并重建目录投影。 */
async function resumeSkillRelease(id, user) {
    const release = await getSkillReleaseForUser(id, user, 'manage');
    if (!release || release.status !== 'paused') return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_skill_releases SET status = 'published', rolled_back_at = NULL WHERE id = ?", [id]);
    const version = await queryOne('SELECT * FROM agent_skill_versions WHERE id = ?', [release.skill_version_id]);
    if (version) {
        await projectSkillReadModel({ version, release, ownerKey: release.owner_key, tenantId: release.tenant_id, actorUserId: user.id });
    }
    await execute('UPDATE agent_skills SET updated_at = ? WHERE owner_key = ? AND name = ?', [now, release.owner_key, release.name]);
    return queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [id]);
}

/**
 * 运行时解析已发布技能。
 * 落地方案 v1.2 §6.1 第 5 条与阶段 1.3：
 * 1. 租户是首个访问条件；企业访问开启且租户不可解析时只允许个人范围；
 * 2. team 范围叠加 team_members 实时校验；
 * 3. 灰度分桶对每个候选独立计算（修复 B8）。
 */
async function resolvePublishedSkill(name, user) {
    const tenant = await resolveTenantContext(user);
    const context = tenant.resolvable ? await getUserEnterpriseContext(user.id) : { teams: [] };
    const teamIds = (context.teams || []).map(team => Number.parseInt(team.id, 10)).filter(Boolean);
    const columns = `r.*, v.version, v.manifest_yaml, v.manifest_json, v.instructions_md, v.digest,
        v.content_digest, v.legacy_unrestricted, v.legacy_unrestricted_until`;
    const personalOwnerKey = `user:${Number.parseInt(user.id, 10) || 0}`;
    const rows = await withControlPlaneFallback(async () => {
        if (!tenant.resolvable) {
            return await query(`
                SELECT ${columns}
                FROM agent_skill_releases r
                JOIN agent_skill_versions v ON v.id = r.skill_version_id
                WHERE r.name = ? AND r.status = 'published' AND r.owner_key = ? AND r.rollout_scope = 'personal'
                ORDER BY r.published_at DESC
            `, [String(name), personalOwnerKey]);
        }
        return await query(`
            SELECT ${columns}
            FROM agent_skill_releases r
            JOIN agent_skill_versions v ON v.id = r.skill_version_id
            WHERE r.name = ? AND r.status = 'published'
              AND (
                    (r.owner_key = ? AND r.rollout_scope = 'personal')
                 OR r.tenant_id = ?
              )
            ORDER BY r.published_at DESC
        `, [String(name), personalOwnerKey, tenant.tenantId]);
    }, []);
    const accessibleRows = await filterAccessibleReleases(rows, user, 'use');
    if (!accessibleRows.length) {
        const anyRelease = await withControlPlaneFallback(
            () => queryOne("SELECT tenant_id FROM agent_skill_releases WHERE name = ? AND status = 'published' LIMIT 1", [String(name)]),
            null
        );
        recordSkillReleaseResolveMiss(anyRelease ? 'tenant_mismatch' : 'no_release');
        return null;
    }
    const release = chooseRolloutRelease(accessibleRows, user, { teamIds });
    if (!release) {
        recordSkillReleaseResolveMiss('rollout_excluded');
        return null;
    }
    return release;
}

async function publishWorkflowRelease(workflowId, user, input = {}) {
    const tenantForAdmin = input.allowTenantAdmin === true && isTenantAdmin(user)
        ? (input.tenantId || await getPrimaryTenantId(user.id))
        : null;
    const resolved = await resolveAgentWorkflowVersion(workflowId, user, input.version || 'current', { allowTenantAdmin: Boolean(tenantForAdmin), tenantId: tenantForAdmin });
    if (!resolved) return null;
    let evaluation = input.evaluationRunId ? await getAgentEvalRun(input.evaluationRunId, user) : null;
    if (!evaluation) {
        const latest = await queryOne("SELECT er.id FROM agent_eval_runs er JOIN agent_eval_suites s ON s.id = er.suite_id WHERE er.user_id = ? AND s.workflow_id = ? AND er.status = 'completed' ORDER BY er.created_at DESC LIMIT 1", [user.id, resolved.workflow.id]);
        if (latest) evaluation = await getAgentEvalRun(latest.id, user);
    }
    if (input.fixedEvaluationRequired !== false && (!evaluation?.run || Number(evaluation.run.summary?.passRate || 0) < Number(input.minPassRate || 80))) throw invalid('工作流固定评测集未通过发布门禁。', 409, 'WORKFLOW_EVALUATION_GATE_FAILED');
    const rollout = normalizeRollout(input);
    if (rollout.rolloutScope !== 'personal' && !isTenantAdmin(user)) throw invalid('团队或组织工作流发布需要管理员权限。', 403, 'WORKFLOW_ROLLOUT_SCOPE_FORBIDDEN');
    const tenant = await assertTenantContext(user);
    if (rollout.rolloutScope !== 'personal') {
        const candidate = await queryOne("SELECT status FROM agent_evolution_proposals WHERE artifact_id = ? AND tenant_id = ? AND scope = 'organization_candidate' ORDER BY created_at DESC LIMIT 1", [String(resolved.workflow.id), tenant.tenantId]);
        if (candidate && candidate.status !== 'versioned_draft') {
            throw invalid('该工作流是组织共享候选，必须先在候选治理流程中完成审批与验证。', 409, 'EVOLUTION_CANDIDATE_GATE_REQUIRED');
        }
    }
    await publishAgentWorkflowVersion(workflowId, user, input.version || 'current', { skipRelease: true, skipEvaluationGate: input.fixedEvaluationRequired === false, allowTenantAdmin: Boolean(tenantForAdmin), tenantId: tenantForAdmin });
    const previous = await queryOne("SELECT * FROM agent_workflow_releases WHERE workflow_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1", [resolved.workflow.id]);
    const now = getBeijingTimestamp();
    const release = await queryOne(`INSERT INTO agent_workflow_releases (workflow_id, workflow_version_id, tenant_id, rollout_scope, rollout_percent, target_user_ids, target_units, status, previous_release_id, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?) ON CONFLICT(workflow_id, workflow_version_id) DO UPDATE SET tenant_id = excluded.tenant_id, rollout_scope = excluded.rollout_scope, rollout_percent = excluded.rollout_percent, target_user_ids = excluded.target_user_ids, target_units = excluded.target_units, status = 'published', published_by = excluded.published_by, published_at = excluded.published_at RETURNING *`, [resolved.workflow.id, resolved.version_id, tenant.tenantId, rollout.rolloutScope, rollout.rolloutPercent, JSON.stringify(rollout.targetUserIds), JSON.stringify(rollout.targetUnits), previous?.id || null, user.id, now]);
    await execute('UPDATE agent_workflows SET published_version_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [resolved.version_id, now, now, resolved.workflow.id, resolved.workflow.user_id]);
    try { await createAgentInboxEvent(user, { eventKey: `workflow.release:${release.id}`, eventType: 'release.published', sourceId: String(release.id), title: '工作流版本已发布', body: `工作流 ${resolved.workflow.name} 已进入 ${rollout.rolloutScope} 灰度。`, risk: 'medium', payload: { releaseId: release.id, workflowId: resolved.workflow.id, version: resolved.version } }); } catch (_) {}
    return release;
}

async function rollbackWorkflowRelease(id, user) {
    const release = await queryOne("SELECT * FROM agent_workflow_releases WHERE id = ? AND status = 'published'", [id]);
    if (!release) return null;
    if (Number(release.published_by) !== Number(user.id) && !isTenantAdmin(user)) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_workflow_releases SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?", [now, id]);
    if (release.previous_release_id) {
        const previous = await queryOne('SELECT workflow_version_id FROM agent_workflow_releases WHERE id = ?', [release.previous_release_id]);
        await execute("UPDATE agent_workflow_releases SET status = 'published' WHERE id = ?", [release.previous_release_id]);
        await execute('UPDATE agent_workflows SET published_version_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [previous?.workflow_version_id || null, now, now, release.workflow_id, user.id]);
    }
    return queryOne('SELECT * FROM agent_workflow_releases WHERE id = ?', [id]);
}

/**
 * 列出当前用户可见的技能版本。
 * 落地方案 v1.2 阶段 1.3 / 1.4：创建者可见本人版本；租户管理员可见本租户全部版本，
 * 用于治理他人技能；跨租户一律不可见。
 */
async function listSkillVersionsForUser(user, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 200));
    const tenant = await resolveTenantContext(user);
    const columns = 'id, skill_id, name, version, digest, content_digest, status, source_run_id, tenant_id, created_by, legacy_unrestricted, legacy_unrestricted_until, created_at, updated_at';
    if (isTenantAdmin(user) && tenant.resolvable) {
        return await withControlPlaneFallback(() => query(`
            SELECT ${columns} FROM agent_skill_versions
            WHERE tenant_id = ? OR created_by = ?
            ORDER BY updated_at DESC LIMIT ?
        `, [tenant.tenantId, user.id, limit]), []);
    }
    return await withControlPlaneFallback(() => query(`
        SELECT ${columns} FROM agent_skill_versions
        WHERE created_by = ?
        ORDER BY updated_at DESC LIMIT ?
    `, [user.id, limit]), []);
}

/**
 * 列出当前用户可见的发布记录。
 * 修复原实现 `WHERE owner_key = ? OR rollout_scope IN ('team','organization')` 的跨租户泄露：
 * 共享范围必须叠加租户条件，team 范围还要叠加团队成员校验。
 */
async function listSkillReleasesForUser(user, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 200));
    const tenant = await resolveTenantContext(user);
    const personalOwnerKey = `user:${Number.parseInt(user.id, 10) || 0}`;
    if (!tenant.resolvable) {
        return await withControlPlaneFallback(() => query(`
            SELECT r.*, v.version, v.manifest_yaml, v.manifest_json, v.instructions_md, v.digest, v.content_digest
            FROM agent_skill_releases r
            JOIN agent_skill_versions v ON v.id = r.skill_version_id
            WHERE r.owner_key = ? AND r.rollout_scope = 'personal'
            ORDER BY r.published_at DESC LIMIT ?
        `, [personalOwnerKey, limit]), []);
    }
    const params = [personalOwnerKey, tenant.tenantId, limit];
    const rows = await withControlPlaneFallback(() => query(`
        SELECT r.*, v.version, v.manifest_yaml, v.manifest_json, v.instructions_md, v.digest, v.content_digest
        FROM agent_skill_releases r
        JOIN agent_skill_versions v ON v.id = r.skill_version_id
        WHERE (
                (r.owner_key = ? AND r.rollout_scope = 'personal')
             OR r.tenant_id = ?
        )
        ORDER BY r.published_at DESC LIMIT ?
    `, params), []);
    return filterAccessibleReleasesAny(rows, user, isTenantAdmin(user) ? ['use', 'manage'] : ['use']);
}

/** 技能目录：只返回已发布且当前用户受众命中的条目，租户为首个访问条件。 */
async function listSkillCatalogForUser(user, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 200, 500));
    const releases = await listSkillReleasesForUser(user, { limit });
    const published = releases.filter(item => item.status === 'published');
    const context = await getUserEnterpriseContext(user.id);
    const teamIds = (context.teams || []).map(team => Number.parseInt(team.id, 10)).filter(Boolean);
    const byName = new Map();
    published.forEach(item => {
        if (!byName.has(item.name)) byName.set(item.name, []);
        byName.get(item.name).push(item);
    });
    const rows = [];
    for (const [, candidates] of byName) {
        const hit = chooseRolloutRelease(candidates, user, { teamIds });
        if (hit) rows.push(hit);
    }
    return rows;
}

/**
 * 系统级熔断动作：暂停发布。
 * 落地方案 v1.2 §6.3 第 5 条与阶段 4.3：熔断是平台的安全动作，不代表某个用户的意图，
 * 因此不走面向请求的权限判定，只由 agent-skill-breaker 的巡检调用。
 */
async function pauseSkillReleaseBySystem(release, reason = '') {
    if (!release?.id) return { action: 'skipped' };
    const now = getBeijingTimestamp();
    const updated = await query("UPDATE agent_skill_releases SET status = 'paused', rolled_back_at = ? WHERE id = ? AND status = 'published' RETURNING id", [now, release.id]);
    if (!updated.length) return { action: 'skipped' };
    await execute("UPDATE agent_skills SET status = 'disabled', updated_at = ? WHERE owner_key = ? AND name = ?", [now, release.owner_key, release.name]);
    await notifyBreakerAction(release, 'release.paused', 'Skill 发布已自动暂停', reason);
    return { action: 'paused' };
}

/** 系统级熔断动作：回滚到上一版本并重建目录投影。 */
async function rollbackSkillReleaseBySystem(release, reason = '') {
    if (!release?.id) return { action: 'skipped' };
    const now = getBeijingTimestamp();
    const updated = await query("UPDATE agent_skill_releases SET status = 'rolled_back', rolled_back_at = ? WHERE id = ? AND status = 'published' RETURNING id", [now, release.id]);
    if (!updated.length) return { action: 'skipped' };
    let restored = null;
    if (release.previous_release_id) {
        await execute("UPDATE agent_skill_releases SET status = 'published' WHERE id = ?", [release.previous_release_id]);
        restored = await queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [release.previous_release_id]);
    }
    if (restored) {
        const restoredVersion = await queryOne('SELECT * FROM agent_skill_versions WHERE id = ?', [restored.skill_version_id]);
        if (restoredVersion) {
            await projectSkillReadModel({
                version: restoredVersion,
                release: restored,
                ownerKey: restored.owner_key,
                tenantId: restored.tenant_id,
                actorUserId: restored.published_by
            });
        }
    } else {
        await execute("UPDATE agent_skills SET status = 'disabled', updated_at = ? WHERE owner_key = ? AND name = ?", [now, release.owner_key, release.name]);
    }
    await notifyBreakerAction(release, 'release.rolled_back', 'Skill 发布已自动回滚', reason);
    return { action: 'rolled_back', restoredReleaseId: restored?.id || null };
}

/** 熔断通知发给发布者；通知失败不影响熔断结果。 */
async function notifyBreakerAction(release, eventType, title, reason) {
    const publisherId = Number.parseInt(release.published_by, 10) || 0;
    if (!publisherId) return;
    try {
        await createAgentInboxEvent({ id: publisherId }, {
            eventKey: `skill.release.breaker:${release.id}:${eventType}`,
            eventType,
            sourceId: String(release.id),
            title,
            body: `${release.name} 触发熔断阈值：${reason || '未说明'}。`,
            risk: 'high',
            payload: { releaseId: release.id, reason }
        });
    } catch (_) {
        // 收件箱不可用时熔断仍然生效，事件已记录在 release 状态与日志中。
    }
}

module.exports = {
    RELEASE_SCOPES,
    createSkillVersion,
    approveSkillVersionForSharing,
    getSkillReleaseForUser,
    getSkillVersion,
    listSkillCatalogForUser,
    listSkillReleasesForUser,
    listSkillVersionsForUser,
    normalizeRollout,
    pauseSkillRelease,
    pauseSkillReleaseBySystem,
    publishSkillVersion,
    publishWorkflowRelease,
    resolvePublishedSkill,
    resumeSkillRelease,
    rollbackSkillRelease,
    rollbackSkillReleaseBySystem,
    rollbackWorkflowRelease,
    runDeclarativeSkillChecks,
    scanInstalledPackage,
    validateSkillVersion
};
