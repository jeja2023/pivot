const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { validateSkillManifest, verifySkillSignature, parseSkillManifest } = require('./agent-skills');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');
const { publishAgentWorkflowVersion, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { getAgentEvalRun } = require('./agent-evaluations');
const { createAgentInboxEvent } = require('./agent-inbox');
const { getPrimaryTenantId } = require('./enterprise-access');

const RELEASE_SCOPES = Object.freeze(['personal', 'team', 'organization']);

function invalid(message, status = 400, code = 'AGENT_RELEASE_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeScope(value) {
    const scope = String(value || 'personal').trim().toLowerCase();
    if (!RELEASE_SCOPES.includes(scope)) throw invalid('发布范围只能是 personal、team 或 organization。');
    return scope;
}

function normalizeRollout(input = {}) {
    return {
        rolloutScope: normalizeScope(input.rolloutScope || input.rollout_scope || input.scope),
        rolloutPercent: Math.max(1, Math.min(Number.parseInt(input.rolloutPercent ?? input.rollout_percent, 10) || 100, 100)),
        targetUserIds: [...new Set((Array.isArray(input.targetUserIds || input.target_user_ids) ? (input.targetUserIds || input.target_user_ids) : []).map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 500),
        targetUnits: [...new Set((Array.isArray(input.targetUnits || input.target_units) ? (input.targetUnits || input.target_units) : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100)
    };
}

function chooseRollout(releases, user) {
    const candidates = (releases || []).filter(item => item.status === 'published');
    if (!candidates.length) return null;
    const userId = Number(user?.id || 0);
    const unit = String(user?.unit || '').trim();
    const hash = crypto.createHash('sha256').update(`${userId}:${String(candidates[0].id)}`).digest().readUInt32BE(0) % 100;
    return candidates.find(item => {
        const ids = parseJson(item.target_user_ids, []);
        const units = parseJson(item.target_units, []);
        const matchesTarget = (!ids.length || ids.includes(userId)) && (!units.length || units.includes(unit));
        return matchesTarget && hash < Number(item.rollout_percent || 100);
    }) || null;
}

function checkSkillDependencies(manifest, packageRoot = '') {
    const errors = [];
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
    Object.keys(dependencies).forEach(name => {
        if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name)) errors.push(`依赖名称非法：${name}`);
    });
    const lockCandidates = packageRoot ? ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'poetry.lock'].map(file => path.join(packageRoot, file)) : [];
    if (Object.keys(dependencies).length && !lockCandidates.some(file => fs.existsSync(file))) errors.push('Skill 声明依赖但未提供锁定文件。');
    return { passed: errors.length === 0, dependencies, lockFiles: lockCandidates.filter(file => fs.existsSync(file)).map(file => path.basename(file)), errors };
}

function checkSupplyChain(packageRoot = '', manifest = {}) {
    const errors = [];
    const forbidden = new Set(['.env', '.git/config', 'id_rsa', 'credentials.json']);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    files.forEach(file => {
        const name = String(file || '').replace(/\\/g, '/');
        if (name.startsWith('/') || name.includes('../') || forbidden.has(name)) errors.push(`供应链文件路径被禁止：${name}`);
    });
    if (packageRoot && fs.existsSync(packageRoot)) {
        const packageJson = path.join(packageRoot, 'package.json');
        if (fs.existsSync(packageJson)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
                if (parsed.scripts?.preinstall || parsed.scripts?.install || parsed.scripts?.postinstall) errors.push('Skill 包禁止执行 npm 生命周期脚本。');
            } catch (error) { errors.push(`package.json 解析失败：${error.message}`); }
        }
    }
    return { passed: errors.length === 0, errors };
}

async function sandboxValidateSkill({ version, _manifest, packageRoot = '', user, options = {} }) {
    const root = packageRoot && fs.existsSync(packageRoot) ? packageRoot : path.dirname(__filename);
    const jail = createWorkspaceJail(options.workspaceRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-release-sandbox'), `skill-${version.id}`);
    const staged = jail.resolve('package');
    fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
    fs.cpSync(root, staged, { recursive: true, force: false, errorOnExist: false });
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
    return { passed: result.code === 0, mode: 'isolated-static-sandbox', sideEffects: false, result: { code: result.code, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000), isolation: result.isolation } };
}

async function runSkillRegressionTests({ version, manifest, packageRoot = '', user, options = {} }) {
    const tests = Array.isArray(manifest.tests) ? manifest.tests : Array.isArray(manifest.regressionTests) ? manifest.regressionTests : [];
    if (!tests.length) return { passed: false, fixedSuite: true, reason: 'Skill 必须声明至少一个固定回归测试。', tests: [] };
    const root = packageRoot && fs.existsSync(packageRoot) ? packageRoot : path.dirname(__filename);
    const results = [];
    for (const test of tests.slice(0, 50)) {
        const name = String(test?.name || '').trim().slice(0, 120) || 'unnamed';
        const script = String(test?.script || test?.code || '').trim();
        if (!script || script.length > 128 * 1024) {
            results.push({ name, passed: false, error: '测试脚本为空或超过 128KB。' });
            continue;
        }
        const jail = createWorkspaceJail(options.workspaceRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-release-sandbox'), `skill-test-${version.id}-${results.length}`);
        const staged = jail.resolve('package');
        fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
        fs.cpSync(root, staged, { recursive: true, force: false, errorOnExist: false });
        try {
            const output = await runSandboxedProcess(process.execPath, ['-e', script], {
                jail,
                cwd: staged,
                strictIsolation: options.strictIsolation ?? (process.env.PIVOT_AGENT_STRICT_ISOLATION === '1' || process.env.PIVOT_AGENT_STRICT_ISOLATION === 'true'),
                networkDisabled: true,
                timeoutMs: Math.min(Math.max(Number(options.testTimeoutMs) || 30000, 1000), 120000),
                inheritEnv: false,
                user
            });
            results.push({ name, passed: output.code === 0, stdout: output.stdout.slice(0, 2000), stderr: output.stderr.slice(0, 2000) });
        } catch (error) {
            results.push({ name, passed: false, error: String(error.message || error).slice(0, 2000) });
        }
    }
    return { passed: results.length > 0 && results.every(item => item.passed), fixedSuite: true, tests: results };
}

async function createSkillVersion(user, input = {}) {
    const manifest = parseSkillManifest(input.manifest || input.manifestYaml || {});
    const checked = validateSkillManifest(manifest, { allowedPermissions: input.allowedPermissions, allowedTools: input.allowedTools });
    if (!checked.valid) throw invalid(`Skill Manifest 校验失败：${checked.errors.join('；')}`, 422, 'SKILL_MANIFEST_INVALID');
    const signature = verifySkillSignature(manifest, { publicKey: input.publicKey, algorithm: input.algorithm });
    if (input.requireSignature !== false && !signature.verified && input.signatureVerified !== true) throw invalid('Skill 版本必须提供有效签名。', 422, 'SKILL_SIGNATURE_INVALID');
    const packageRoot = String(input.packageRoot || '').trim();
    const dependencies = checkSkillDependencies(manifest, packageRoot);
    const supplyChain = checkSupplyChain(packageRoot, manifest);
    if (!dependencies.passed || !supplyChain.passed) throw invalid([...dependencies.errors, ...supplyChain.errors].join('；'), 422, 'SKILL_SUPPLY_CHAIN_INVALID');
    const ownerKey = String(input.ownerKey || (manifest.scope === 'user' ? `user:${user.id}` : `scope:${manifest.scope || 'user'}`));
    const digest = manifest.package_digest || `sha256:${checked.computedDigest}`;
    const now = getBeijingTimestamp();
    const row = await queryOne(`INSERT INTO agent_skill_versions (skill_id, owner_key, name, version, digest, manifest_yaml, instructions_md, package_path, source_run_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?) RETURNING id`, [String(manifest.id), ownerKey, String(manifest.name), String(manifest.version), String(digest), JSON.stringify(manifest), String(input.instructions || ''), packageRoot, input.sourceRunId || null, user.id, now, now]);
    return getSkillVersion(row?.id, user);
}

async function getSkillVersion(id, user) {
    return await queryOne('SELECT * FROM agent_skill_versions WHERE id = ? AND created_by = ?', [id, user.id]);
}

async function validateSkillVersion(id, user, options = {}) {
    const version = await getSkillVersion(id, user);
    if (!version) return null;
    const manifest = parseJson(version.manifest_yaml, {});
    const checked = validateSkillManifest(manifest, { allowedPermissions: options.allowedPermissions, allowedTools: options.allowedTools });
    const signature = verifySkillSignature(manifest, { publicKey: options.publicKey, algorithm: options.algorithm });
    const dependencies = checkSkillDependencies(manifest, version.package_path);
    const supplyChain = checkSupplyChain(version.package_path, manifest);
    let sandbox = { passed: false, mode: 'not-run', sideEffects: true };
    const evaluation = options.evaluationRunId ? await getAgentEvalRun(options.evaluationRunId, user) : null;
    const evaluationResult = options.evaluationRunId
        ? { passed: Boolean(evaluation?.run && Number(evaluation.run.summary?.passRate || 0) >= Number(options.minPassRate || 80)), evalRunId: options.evaluationRunId, passRate: Number(evaluation?.run?.summary?.passRate || 0) }
        : { passed: true, fixedSuite: 'skill-manifest-regression' };
    if (checked.valid && signature.verified && dependencies.passed && supplyChain.passed) {
        sandbox = await sandboxValidateSkill({ version, manifest, packageRoot: version.package_path, user, options });
    }
    const regression = checked.valid && signature.verified && dependencies.passed && supplyChain.passed ? await runSkillRegressionTests({ version, manifest, packageRoot: version.package_path, user, options }) : { passed: false, fixedSuite: true, tests: [] };
    const passed = checked.valid && signature.verified && dependencies.passed && supplyChain.passed && sandbox.passed && regression.passed && evaluationResult.passed;
    const now = getBeijingTimestamp();
    const finalEvaluation = { ...evaluationResult, regression };
    await execute(`INSERT INTO agent_skill_validations (skill_version_id, user_id, status, manifest_result, signature_result, dependency_result, supply_chain_result, sandbox_result, evaluation_result, risk_level, error_code, error_message, version, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [version.id, user.id, passed ? 'passed' : 'failed', JSON.stringify(checked), JSON.stringify(signature), JSON.stringify(dependencies), JSON.stringify(supplyChain), JSON.stringify(sandbox), JSON.stringify(finalEvaluation), passed ? 'low' : 'high', passed ? '' : 'SKILL_VALIDATION_FAILED', passed ? '' : [...checked.errors, ...dependencies.errors, ...supplyChain.errors, sandbox.result?.stderr || '', regression.reason || '', evaluationResult.passed ? '' : '固定评测集未通过'].join('；').slice(0, 4000), Number(options.version || 1), now, now]);
    await execute('UPDATE agent_skill_versions SET status = ?, updated_at = ? WHERE id = ? AND created_by = ?', [passed ? 'validated' : 'draft', now, version.id, user.id]);
    return { version: await getSkillVersion(id, user), passed, manifest: checked, signature, dependencies, supplyChain, sandbox, evaluation: finalEvaluation };
}

async function publishSkillVersion(id, user, input = {}) {
    const version = await getSkillVersion(id, user);
    if (!version) return null;
    const validation = await queryOne('SELECT status FROM agent_skill_validations WHERE skill_version_id = ? ORDER BY version DESC, created_at DESC LIMIT 1', [version.id]);
    if (version.status !== 'validated' || validation?.status !== 'passed') throw invalid('Skill 必须通过完整验证后才能发布。', 409, 'SKILL_RELEASE_GATE_FAILED');
    const rollout = normalizeRollout(input);
    if (rollout.rolloutScope !== 'personal' && !['admin', 'root'].includes(String(user.role || '').toLowerCase())) throw invalid('团队或组织 Skill 发布需要管理员权限。', 403, 'SKILL_ROLLOUT_SCOPE_FORBIDDEN');
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const previous = await queryOne("SELECT * FROM agent_skill_releases WHERE owner_key = ? AND name = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1", [version.owner_key, version.name]);
    const now = getBeijingTimestamp();
    const release = await queryOne(`INSERT INTO agent_skill_releases (skill_version_id, owner_key, name, tenant_id, rollout_scope, rollout_percent, target_user_ids, target_units, status, previous_release_id, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?) RETURNING *`, [version.id, version.owner_key, version.name, tenantId, rollout.rolloutScope, rollout.rolloutPercent, JSON.stringify(rollout.targetUserIds), JSON.stringify(rollout.targetUnits), previous?.id || null, user.id, now]);
    await execute(`INSERT INTO agent_skills (id, name, version, title, description, publisher, digest, manifest_yaml, instructions_md, scope, user_id, owner_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?) ON CONFLICT(owner_key, name) DO UPDATE SET id = excluded.id, version = excluded.version, title = excluded.title, description = excluded.description, publisher = excluded.publisher, digest = excluded.digest, manifest_yaml = excluded.manifest_yaml, instructions_md = excluded.instructions_md, status = 'enabled', updated_at = excluded.updated_at`, [version.skill_id, version.name, version.version, parseJson(version.manifest_yaml, {}).title || version.name, parseJson(version.manifest_yaml, {}).description || '', parseJson(version.manifest_yaml, {}).publisher || '', version.digest, version.manifest_yaml, version.instructions_md, version.owner_key.startsWith('scope:') ? version.owner_key.slice(6) : 'user', user.id, version.owner_key, now, now]);
    await execute('UPDATE agent_skill_versions SET status = \'published\', updated_at = ? WHERE id = ?', [now, version.id]);
    try { await createAgentInboxEvent(user, { eventKey: `skill.release:${release.id}`, eventType: 'release.published', sourceId: String(release.id), title: 'Skill 版本已发布', body: `${version.name}@${version.version} 已进入 ${rollout.rolloutScope} 灰度。`, risk: 'medium', payload: { releaseId: release.id, rollout } }); } catch (_) {}
    return release;
}

async function rollbackSkillRelease(id, user) {
    const release = await queryOne('SELECT * FROM agent_skill_releases WHERE id = ? AND published_by = ? AND status = \'published\'', [id, user.id]);
    if (!release) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_skill_releases SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?", [now, id]);
    if (release.previous_release_id) await execute("UPDATE agent_skill_releases SET status = 'published' WHERE id = ?", [release.previous_release_id]);
    return queryOne('SELECT * FROM agent_skill_releases WHERE id = ?', [id]);
}

async function resolvePublishedSkill(name, user) {
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const rows = await query("SELECT r.*, v.version, v.manifest_yaml, v.instructions_md, v.digest FROM agent_skill_releases r JOIN agent_skill_versions v ON v.id = r.skill_version_id WHERE r.name = ? AND r.status = 'published' AND ((r.owner_key = ? AND r.rollout_scope = 'personal') OR (r.tenant_id = ? AND r.rollout_scope IN ('team', 'organization'))) ORDER BY r.published_at DESC", [String(name), `user:${user.id}`, tenantId]);
    const release = chooseRollout(rows, user);
    if (!release) return null;
    return release;
}

async function publishWorkflowRelease(workflowId, user, input = {}) {
    const resolved = await resolveAgentWorkflowVersion(workflowId, user, input.version || 'current');
    if (!resolved) return null;
    let evaluation = input.evaluationRunId ? await getAgentEvalRun(input.evaluationRunId, user) : null;
    if (!evaluation) {
        const latest = await queryOne("SELECT er.id FROM agent_eval_runs er JOIN agent_eval_suites s ON s.id = er.suite_id WHERE er.user_id = ? AND s.workflow_id = ? AND er.status = 'completed' ORDER BY er.created_at DESC LIMIT 1", [user.id, resolved.workflow.id]);
        if (latest) evaluation = await getAgentEvalRun(latest.id, user);
    }
    if (input.fixedEvaluationRequired !== false && (!evaluation?.run || Number(evaluation.run.summary?.passRate || 0) < Number(input.minPassRate || 80))) throw invalid('工作流固定评测集未通过发布门禁。', 409, 'WORKFLOW_EVALUATION_GATE_FAILED');
    const rollout = normalizeRollout(input);
    if (rollout.rolloutScope !== 'personal' && !['admin', 'root'].includes(String(user.role || '').toLowerCase())) throw invalid('团队或组织工作流发布需要管理员权限。', 403, 'WORKFLOW_ROLLOUT_SCOPE_FORBIDDEN');
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    await publishAgentWorkflowVersion(workflowId, user, input.version || 'current', { skipRelease: true, skipEvaluationGate: input.fixedEvaluationRequired === false });
    const previous = await queryOne("SELECT * FROM agent_workflow_releases WHERE workflow_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1", [resolved.workflow.id]);
    const now = getBeijingTimestamp();
    const release = await queryOne(`INSERT INTO agent_workflow_releases (workflow_id, workflow_version_id, tenant_id, rollout_scope, rollout_percent, target_user_ids, target_units, status, previous_release_id, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?) ON CONFLICT(workflow_id, workflow_version_id) DO UPDATE SET tenant_id = excluded.tenant_id, rollout_scope = excluded.rollout_scope, rollout_percent = excluded.rollout_percent, target_user_ids = excluded.target_user_ids, target_units = excluded.target_units, status = 'published', published_by = excluded.published_by, published_at = excluded.published_at RETURNING *`, [resolved.workflow.id, resolved.version_id, tenantId, rollout.rolloutScope, rollout.rolloutPercent, JSON.stringify(rollout.targetUserIds), JSON.stringify(rollout.targetUnits), previous?.id || null, user.id, now]);
    await execute('UPDATE agent_workflows SET published_version_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [resolved.version_id, now, now, resolved.workflow.id, user.id]);
    try { await createAgentInboxEvent(user, { eventKey: `workflow.release:${release.id}`, eventType: 'release.published', sourceId: String(release.id), title: '工作流版本已发布', body: `工作流 ${resolved.workflow.name} 已进入 ${rollout.rolloutScope} 灰度。`, risk: 'medium', payload: { releaseId: release.id, workflowId: resolved.workflow.id, version: resolved.version } }); } catch (_) {}
    return release;
}

async function rollbackWorkflowRelease(id, user) {
    const release = await queryOne("SELECT * FROM agent_workflow_releases WHERE id = ? AND published_by = ? AND status = 'published'", [id, user.id]);
    if (!release) return null;
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_workflow_releases SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?", [now, id]);
    if (release.previous_release_id) {
        const previous = await queryOne('SELECT workflow_version_id FROM agent_workflow_releases WHERE id = ?', [release.previous_release_id]);
        await execute("UPDATE agent_workflow_releases SET status = 'published' WHERE id = ?", [release.previous_release_id]);
        await execute('UPDATE agent_workflows SET published_version_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [previous?.workflow_version_id || null, now, now, release.workflow_id, user.id]);
    }
    return queryOne('SELECT * FROM agent_workflow_releases WHERE id = ?', [id]);
}

module.exports = {
    RELEASE_SCOPES,
    createSkillVersion,
    getSkillVersion,
    publishSkillVersion,
    publishWorkflowRelease,
    resolvePublishedSkill,
    rollbackSkillRelease,
    rollbackWorkflowRelease,
    validateSkillVersion,
    normalizeRollout
};
