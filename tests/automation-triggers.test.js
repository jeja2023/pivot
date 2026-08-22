// 自动化增强回归测试：cron 调度、部门可见性和工作流触发器
const assert = require('node:assert/strict');
const test = require('node:test');
const { sql } = require('../server/db/statements');

const {
    computeNextCronDate,
    describeCronExpression,
    isValidCronExpression,
    parseCronExpression
} = require('../server/services/cron-expression');
const {
    canAccessSharedResource,
    matchesAllowedUnits,
    normalizeShareScope,
    normalizeShareSettings,
    parseAllowedUnits,
    serializeAllowedUnits
} = require('../server/services/unit-visibility');
const { assertWorkflowAccess, formatAgentWorkflow } = require('../server/services/agent-workflows');
const {
    applyAgentWorkflowDependencyBindings,
    buildAgentWorkflowDependencyManifest,
    getAgentWorkflowDependencyConfiguration,
    inspectAgentWorkflowDependencies,
    resolveAgentWorkflowDependencyBindings,
    saveAgentWorkflowDependencyConfiguration
} = require('../server/services/agent-workflow-dependencies');
const {
    createWorkflowCredential,
    listWorkflowCredentials,
    normalizeSlug,
    updateWorkflowCredential
} = require('../server/services/workflow-credentials');
const { configureAgentTriggers, pollDatabaseTrigger } = require('../server/services/agent-triggers');

function at(text) {
    return new Date(text.replace(' ', 'T'));
}

function format(date) {
    if (!date) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test('cron 表达式解析支持通配、步长、区间和列表', () => {
    const parsed = parseCronExpression('*/30 9-17 * * 1-5');
    assert.deepEqual(Array.from(parsed.minutes).sort((a, b) => a - b), [0, 30]);
    assert.equal(parsed.hours.has(9), true);
    assert.equal(parsed.hours.has(17), true);
    assert.equal(parsed.hours.has(18), false);
    assert.equal(parsed.restrictDayOfWeek, true);
    assert.equal(parsed.restrictDayOfMonth, false);

    const list = parseCronExpression('0,15,45 * * * *');
    assert.deepEqual(Array.from(list.minutes).sort((a, b) => a - b), [0, 15, 45]);
});

test('cron 星期字段兼容 7 表示周日以及 0-7 表示整周', () => {
    assert.deepEqual(Array.from(parseCronExpression('0 9 * * 7').daysOfWeek), [0]);
    const week = Array.from(parseCronExpression('0 9 * * 0-7').daysOfWeek).sort((a, b) => a - b);
    assert.deepEqual(week, [0, 1, 2, 3, 4, 5, 6]);
});

test('cron 单值带步长按惯例走到字段上界', () => {
    // 5/15 表示从第 5 分钟开始每 15 分钟一次
    assert.deepEqual(
        Array.from(parseCronExpression('5/15 * * * *').minutes).sort((a, b) => a - b),
        [5, 20, 35, 50]
    );
});

test('cron 非法表达式被拒绝并给出中文提示', () => {
    assert.equal(isValidCronExpression('* * * *'), false);
    assert.equal(isValidCronExpression('60 * * * *'), false);
    assert.equal(isValidCronExpression('*/0 * * * *'), false);
    assert.equal(isValidCronExpression('abc * * * *'), false);
    assert.equal(isValidCronExpression('*/30 * * * *'), true);
    assert.throws(() => parseCronExpression('60 * * * *'), /分钟/);
    assert.throws(() => parseCronExpression('* * * *'), /5 个字段/);
});

test('cron 下次执行时间按分钟推进且不会命中当前分钟', () => {
    assert.equal(format(computeNextCronDate('*/30 * * * *', at('2026-05-16 10:00:30'))), '2026-05-16 10:30');
    assert.equal(format(computeNextCronDate('*/30 * * * *', at('2026-05-16 10:45:00'))), '2026-05-16 11:00');
    assert.equal(format(computeNextCronDate('0 9 * * *', at('2026-05-16 10:00:00'))), '2026-05-17 09:00');
    // 每 15 分钟：10:07 之后应落到 10:15
    assert.equal(format(computeNextCronDate('*/15 * * * *', at('2026-05-16 10:07:00'))), '2026-05-16 10:15');
});

test('cron 工作日限定只在周一到周五命中', () => {
    // 2026-05-16 是周六，下一次工作日 8 点应为周一 2026-05-18
    assert.equal(format(computeNextCronDate('0 8 * * 1-5', at('2026-05-16 10:00:00'))), '2026-05-18 08:00');
});

test('cron 日期与星期同时限定时取并集', () => {
    const parsed = parseCronExpression('0 8 1 * 1');
    assert.equal(parsed.restrictDayOfMonth, true);
    assert.equal(parsed.restrictDayOfWeek, true);
    // 2026-06-01 恰好是周一，既满足 1 号也满足周一
    assert.equal(format(computeNextCronDate('0 8 1 * 1', at('2026-05-30 10:00:00'))), '2026-06-01 08:00');
});

test('cron 永不命中的表达式返回 null 而不是死循环', () => {
    // 2 月 30 日不存在，一年内无法命中
    assert.equal(computeNextCronDate('0 8 30 2 *', at('2026-05-16 10:00:00')), null);
});

test('cron 中文节奏描述可读', () => {
    assert.match(describeCronExpression('*/30 * * * *'), /每/);
    assert.equal(describeCronExpression('不是表达式'), '');
});

test('部门单位列表解析去重且限定长度', () => {
    assert.deepEqual(parseAllowedUnits('财务处, 人事处 ,财务处'), ['财务处', '人事处']);
    assert.deepEqual(parseAllowedUnits(['办公室', '', '办公室']), ['办公室']);
    assert.equal(serializeAllowedUnits('财务处,人事处'), '财务处,人事处');
    assert.deepEqual(parseAllowedUnits(''), []);
});

test('部门范围为空表示全单位可见', () => {
    assert.equal(matchesAllowedUnits('', { unit: '财务处' }), true);
    assert.equal(matchesAllowedUnits('财务处', { unit: '财务处' }), true);
    assert.equal(matchesAllowedUnits('财务处', { unit: '人事处' }), false);
    // 没有部门信息的账号不能命中限定范围
    assert.equal(matchesAllowedUnits('财务处', { unit: '' }), false);
});

test('共享范围归一化只接受 personal 和 shared', () => {
    assert.equal(normalizeShareScope('shared'), 'shared');
    assert.equal(normalizeShareScope('personal'), 'personal');
    assert.equal(normalizeShareScope('global'), 'personal');
    assert.equal(normalizeShareScope(undefined), 'personal');
});

test('普通用户只能共享给本部门，跨部门和全单位需要管理员', () => {
    const user = { id: 2, role: 'user', username: 'zhangsan', unit: '财务处' };

    const ownUnit = normalizeShareSettings({ scope: 'shared', allowedUnits: '财务处' }, user);
    assert.equal(ownUnit.scope, 'shared');
    assert.equal(ownUnit.allowedUnits, '财务处');
    assert.equal(ownUnit.allowedUserIds, '');

    assert.throws(
        () => normalizeShareSettings({ scope: 'shared', allowedUnits: '' }, user),
        /全单位/
    );
    assert.throws(
        () => normalizeShareSettings({ scope: 'shared', allowedUnits: '人事处' }, user),
        /跨部门/
    );
    assert.throws(
        () => normalizeShareSettings({ scope: 'shared', allowedUnits: '财务处,人事处' }, user),
        /跨部门/
    );
});

test('管理员可以共享给全单位和跨部门', () => {
    const admin = { id: 1, role: 'admin', username: 'admin', unit: '办公室' };
    assert.equal(normalizeShareSettings({ scope: 'shared', allowedUnits: '' }, admin).allowedUnits, '');
    assert.equal(normalizeShareSettings({ scope: 'shared', allowedUnits: '财务处,人事处' }, admin).allowedUnits, '财务处,人事处');
});

test('未设置部门的账号不能共享', () => {
    const user = { id: 3, role: 'user', username: 'lisi', unit: '' };
    assert.throws(() => normalizeShareSettings({ scope: 'shared', allowedUnits: '财务处' }, user), /未设置所属部门/);
});

test('未设置部门的账号仍可共享给指定个人', () => {
    const user = { id: 3, role: 'user', username: 'lisi', unit: '' };
    const result = normalizeShareSettings({ scope: 'shared', allowedUserIds: [8, 9, 8] }, user);
    assert.deepEqual(result, { scope: 'shared', allowedUnits: '', allowedUserIds: '8,9' });
});

test('仅自己可见时清空部门范围', () => {
    const user = { id: 2, role: 'user', username: 'zhangsan', unit: '财务处' };
    const result = normalizeShareSettings({ scope: 'personal', allowedUnits: '财务处' }, user);
    assert.equal(result.scope, 'personal');
    assert.equal(result.allowedUnits, '');
    assert.equal(result.allowedUserIds, '');
});

test('共享资源访问判定：所有者可写，共享者只读', () => {
    const owner = { id: 10, unit: '财务处' };
    const sameUnit = { id: 11, unit: '财务处' };
    const otherUnit = { id: 12, unit: '人事处' };

    const personal = { user_id: 10, scope: 'personal', allowed_units: '', deleted_at: null };
    const shared = { user_id: 10, scope: 'shared', allowed_units: '财务处', deleted_at: null };

    // 仅自己可见：他人完全不可见
    assert.equal(canAccessSharedResource(personal, owner, false), true);
    assert.equal(canAccessSharedResource(personal, owner, true), true);
    assert.equal(canAccessSharedResource(personal, sameUnit, false), false);

    // 共享给本部门：同部门可读但不可写
    assert.equal(canAccessSharedResource(shared, sameUnit, false), true);
    assert.equal(canAccessSharedResource(shared, sameUnit, true), false);
    assert.equal(canAccessSharedResource(shared, otherUnit, false), false);

    // 所有者对共享资源仍然可写
    assert.equal(canAccessSharedResource(shared, owner, true), true);
});

test('共享工作流在发布前对接收方不可见，发布后仅按发布版访问', () => {
    const owner = { id: 10, unit: '财务处' };
    const receiver = { id: 11, unit: '财务处' };
    const draft = { user_id: 10, scope: 'shared', allowed_units: '财务处', published_version_id: null, deleted_at: null };
    const published = { user_id: 10, scope: 'shared', allowed_units: '财务处', published_version_id: 42, deleted_at: null };

    assert.equal(assertWorkflowAccess(draft, owner, true), true);
    assert.equal(assertWorkflowAccess(draft, receiver, false), false);
    assert.equal(assertWorkflowAccess(published, receiver, false), true);
    assert.equal(assertWorkflowAccess(published, receiver, true), false);
});

test('共享工作流响应不泄露所有者当前草稿', () => {
    const response = formatAgentWorkflow({
        id: 7,
        user_id: 10,
        name: '日报',
        scope: 'shared',
        allowed_units: '财务处',
        current_version_id: 12,
        current_version: 4,
        current_dag_spec: JSON.stringify({ nodes: [{ id: 'draft-only', tool: 'agent.llm' }] }),
        published_version_id: 9,
        published_version: 3,
        published_dag_spec: JSON.stringify({ nodes: [{ id: 'published', tool: 'workflow.output' }] }),
        published_note: '已发布',
        published_version_created_at: '2026-08-06 10:00:00'
    }, { id: 11, unit: '财务处' });

    assert.equal(response.current_version, 3);
    assert.equal(response.current_version_id, 9);
    assert.deepEqual(response.dag_spec.nodes.map(node => node.id), ['published']);
});

test('共享工作流响应会遮蔽 HTTP 节点里的直接敏感值', () => {
    const response = formatAgentWorkflow({
        id: 8,
        user_id: 10,
        name: '敏感接口调用',
        scope: 'shared',
        allowed_units: '财务处',
        published_version_id: 10,
        published_version: 1,
        published_dag_spec: JSON.stringify({
            nodes: [{
                id: 'http',
                tool: 'agent.http',
                input: {
                    url: 'https://example.com/callback?token=url-secret',
                    headers: { Authorization: 'Bearer owner-secret', Accept: 'application/json' },
                    body: { profile: { password: 'body-secret' }, value: 'visible' }
                }
            }]
        })
    }, { id: 11, unit: '财务处' });

    const serialized = JSON.stringify(response.dag_spec);
    assert.equal(serialized.includes('owner-secret'), false);
    assert.equal(serialized.includes('url-secret'), false);
    assert.equal(serialized.includes('body-secret'), false);
    assert.equal(response.dag_spec.nodes[0].input.headers.Accept, 'application/json');
    assert.equal(response.dag_spec.nodes[0].input.body.value, 'visible');
});

test('共享工作流预检会阻止接收者缺失的模型和凭据', async () => {
    const report = await inspectAgentWorkflowDependencies({
        nodes: [
            { id: 'llm', title: '生成结果', tool: 'agent.llm', input: { model: '999999999' } },
            { id: 'http', title: '调用接口', tool: 'agent.http', input: { credentialSecret: 'MISSING_SHARED_CREDENTIAL' } }
        ]
    }, { id: 987654321, role: 'user', unit: '测试部' });
    assert.equal(report.status, 'blocked');
    assert.equal(report.summary.unavailableModelCount, 1);
    assert.equal(report.summary.unavailableCredentialCount, 1);
    assert.equal(report.blockers.length, 2);
});

test('依赖清单去重并将模型、工具和凭据替换为接收者映射', () => {
    const dagSpec = {
        nodes: [
            { id: 'llm-a', title: '生成', tool: 'agent.llm', input: { model: 'OWNER_MODEL' } },
            { id: 'llm-b', title: '复核', tool: 'agent.content_review', input: { modelId: 'OWNER_MODEL' } },
            { id: 'tool', title: '查询', tool: 'mcp.99.owner.lookup', input: { keyword: 'x' } },
            { id: 'db', title: '查库', tool: 'mcp.77.db.query', input: { connectionId: '77', sql: 'SELECT 1' } },
            { id: 'http', title: '推送', tool: 'agent.http', input: { credentialSecret: 'OWNER_SECRET' } }
        ]
    };
    const manifest = buildAgentWorkflowDependencyManifest(dagSpec);
    assert.equal(manifest.summary.modelCount, 1);
    assert.equal(manifest.models[0].nodes.length, 2);
    assert.equal(manifest.summary.toolCount, 2);
    assert.equal(manifest.tools.some(item => item.source === 'db.query#77'), true);
    assert.equal(manifest.summary.credentialCount, 1);

    const mapped = applyAgentWorkflowDependencyBindings(dagSpec, {
        models: { OWNER_MODEL: '42' },
        tools: { 'mcp.99.owner.lookup': 'sessions.recent' },
        credentials: { OWNER_SECRET: '88' }
    }, new Map([['88', { id: '88', slug: 'RECEIVER_SECRET' }]]));
    assert.equal(mapped.nodes[0].input.model, '42');
    assert.equal(mapped.nodes[1].input.modelId, '42');
    assert.equal(mapped.nodes[2].tool, 'sessions.recent');
    assert.equal(mapped.nodes[4].input.credentialSecret, 'PIVOT_BOUND_CREDENTIAL_88');
    assert.equal(dagSpec.nodes[0].input.model, 'OWNER_MODEL');
});

test('接收者依赖映射固定到发布版本且凭据接口不返回明文', async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const ownerInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', 'Binding Owner', 'QA', 'user', 'active')
    `).run(`binding_owner_${suffix}`);
    const receiverInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', 'Binding Receiver', 'QA', 'user', 'active')
    `).run(`binding_receiver_${suffix}`);
    const owner = { id: Number(ownerInfo.lastInsertRowid), username: `binding_owner_${suffix}`, role: 'user', unit: 'QA' };
    const receiver = { id: Number(receiverInfo.lastInsertRowid), username: `binding_receiver_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = sql(`
        INSERT INTO models (user_id, name, url, model_name, status)
        VALUES (?, 'Receiver Model', 'https://model.example/v1/chat/completions', ?, 'active')
    `).run(receiver.id, `receiver-model-${suffix}`);
    const credentialInfo = sql(`
        INSERT INTO workflow_credentials (user_id, name, slug, secret_value, scope, allowed_units)
        VALUES (?, 'Receiver Credential', ?, 'DO_NOT_RETURN_THIS_SECRET', 'personal', '')
    `).run(receiver.id, `RECEIVER_${suffix.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`);
    const dagSpec = {
        nodes: [
            { id: 'llm', title: '生成', tool: 'agent.llm', input: { model: `owner-model-${suffix}` } },
            { id: 'http', title: '推送', tool: 'agent.http', input: { credentialSecret: 'OWNER_SECRET' } }
        ]
    };
    const workflowInfo = sql(`
        INSERT INTO agent_workflows (user_id, name, scope, allowed_units)
        VALUES (?, 'Shared Binding Workflow', 'shared', 'QA')
    `).run(owner.id);
    const workflowId = Number(workflowInfo.lastInsertRowid);
    const versionOneInfo = sql(`
        INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, created_by)
        VALUES (?, 1, ?, ?)
    `).run(workflowId, JSON.stringify(dagSpec), owner.id);
    const versionOneId = Number(versionOneInfo.lastInsertRowid);
    sql('UPDATE agent_workflows SET current_version_id = ?, published_version_id = ? WHERE id = ?')
        .run(versionOneId, versionOneId, workflowId);
    const resolved = {
        workflow: { id: workflowId, user_id: owner.id, name: 'Shared Binding Workflow', is_owner: false },
        version: 1,
        version_id: versionOneId,
        mode: 'published',
        dagSpec
    };

    try {
        const initial = await getAgentWorkflowDependencyConfiguration(resolved, receiver);
        assert.equal(initial.status, 'blocked');
        assert.match(initial.blockers[0], /配置并确认/);
        await assert.rejects(async () => resolveAgentWorkflowDependencyBindings(resolved, receiver), /配置并确认/);

        const saved = await saveAgentWorkflowDependencyConfiguration(resolved, receiver, {
            bindings: {
                models: { [`owner-model-${suffix}`]: String(modelInfo.lastInsertRowid) },
                credentials: { OWNER_SECRET: String(credentialInfo.lastInsertRowid) },
                tools: {}
            }
        });
        assert.equal(saved.status, 'ready');
        assert.equal(JSON.stringify(saved).includes('DO_NOT_RETURN_THIS_SECRET'), false);

        const bound = await resolveAgentWorkflowDependencyBindings(resolved, receiver);
        assert.equal(bound.dagSpec.nodes[0].input.model, String(modelInfo.lastInsertRowid));
        assert.equal(bound.dagSpec.nodes[1].input.credentialSecret, `PIVOT_BOUND_CREDENTIAL_${credentialInfo.lastInsertRowid}`);

        const versionTwoInfo = sql(`
            INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, created_by)
            VALUES (?, 2, ?, ?)
        `).run(workflowId, JSON.stringify(dagSpec), owner.id);
        const stale = await getAgentWorkflowDependencyConfiguration({
            ...resolved,
            version: 2,
            version_id: Number(versionTwoInfo.lastInsertRowid)
        }, receiver);
        assert.equal(stale.stale, true);
        assert.equal(stale.status, 'blocked');
        assert.match(stale.blockers[0], /重新确认/);
    } finally {
        sql('DELETE FROM agent_workflows WHERE id = ?').run(workflowId);
        sql('DELETE FROM workflow_credentials WHERE id = ?').run(credentialInfo.lastInsertRowid);
        sql('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        sql('DELETE FROM users WHERE id IN (?, ?)').run(owner.id, receiver.id);
    }
});

test('已删除资源对任何人都不可见', () => {
    const owner = { id: 10, unit: '财务处' };
    const deleted = { user_id: 10, scope: 'shared', allowed_units: '', deleted_at: '2026-05-16 10:00:00' };
    assert.equal(canAccessSharedResource(deleted, owner, false), false);
});

test('凭据引用名归一化为大写下划线形式', () => {
    assert.equal(normalizeSlug('crm_api'), 'CRM_API');
    assert.equal(normalizeSlug('crm-api'), 'CRM_API');
    assert.equal(normalizeSlug(' oa token '), 'OA_TOKEN');
    assert.throws(() => normalizeSlug('a'), /引用名/);
    assert.throws(() => normalizeSlug('含中文'), /引用名/);
    assert.throws(() => normalizeSlug('bad!name'), /引用名/);
});

test('凭据加解密可逆且密文不含明文', () => {
    const { encryptSecret, decryptSecret } = require('../server/security');
    const plain = 'pivot-test-token-12345';
    const encrypted = encryptSecret(plain);
    assert.notEqual(encrypted, plain);
    assert.equal(encrypted.includes(plain), false);
    assert.equal(decryptSecret(encrypted), plain);
    // 重复加密不会二次包装，保证轮换时旧密文可以直接搬运
    assert.equal(encryptSecret(encrypted), encrypted);
});

test('工作流凭据按个人共享会持久化且列表不返回密文', async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const ownerInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', 'Credential Owner', 'QA', 'user', 'active')
    `).run(`credential_owner_${suffix}`);
    const receiverInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', 'Credential Receiver', 'Other QA', 'user', 'active')
    `).run(`credential_receiver_${suffix}`);
    const owner = { id: Number(ownerInfo.lastInsertRowid), username: `credential_owner_${suffix}`, role: 'user', unit: 'QA' };
    const receiver = { id: Number(receiverInfo.lastInsertRowid), username: `credential_receiver_${suffix}`, role: 'user', unit: 'Other QA' };
    const slug = `PERSONAL_SHARE_${suffix.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    let credentialId = null;
    try {
        const created = await createWorkflowCredential(owner, {
            name: '个人共享凭据',
            slug,
            secretValue: 'do-not-return-this-secret',
            scope: 'shared',
            allowedUserIds: [receiver.id]
        });
        credentialId = Number(created.id);
        assert.deepEqual(created.allowed_user_ids, [receiver.id]);

        const stored = sql('SELECT allowed_user_ids, secret_value FROM workflow_credentials WHERE id = ?').get(credentialId);
        assert.equal(stored.allowed_user_ids, String(receiver.id));
        assert.equal(stored.secret_value.includes('do-not-return-this-secret'), false);

        const visible = await listWorkflowCredentials(receiver);
        const received = visible.find(item => Number(item.id) === credentialId);
        assert.deepEqual(received?.allowed_user_ids, [receiver.id]);
        assert.equal(JSON.stringify(received).includes('do-not-return-this-secret'), false);

        const updated = await updateWorkflowCredential(credentialId, owner, {
            name: '个人共享凭据（已更新）',
            slug,
            scope: 'shared',
            allowedUserIds: [receiver.id]
        });
        assert.deepEqual(updated.allowed_user_ids, [receiver.id]);
    } finally {
        if (credentialId) sql('DELETE FROM workflow_credentials WHERE id = ?').run(credentialId);
        sql('DELETE FROM users WHERE id IN (?, ?)').run(owner.id, receiver.id);
    }
});

test('数据库触发器在持有租约时可推进水位线', async () => {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const userInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', 'Trigger Owner', 'QA', 'user', 'active')
    `).run(`trigger_owner_${suffix}`);
    const userId = Number(userInfo.lastInsertRowid);
    const workflowInfo = sql(`
        INSERT INTO agent_workflows (user_id, name, scope, allowed_units)
        VALUES (?, 'Database Trigger Workflow', 'personal', '')
    `).run(userId);
    const workflowId = Number(workflowInfo.lastInsertRowid);
    const versionInfo = sql(`
        INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, created_by)
        VALUES (?, 1, ?, ?)
    `).run(workflowId, JSON.stringify({ nodes: [{ id: 'start', tool: 'workflow.input', input: {} }] }), userId);
    const versionId = Number(versionInfo.lastInsertRowid);
    sql('UPDATE agent_workflows SET current_version_id = ?, published_version_id = ? WHERE id = ?')
        .run(versionId, versionId, workflowId);

    const claimToken = `lease_${suffix}`;
    const triggerInfo = sql(`
        INSERT INTO agent_workflow_triggers (
            user_id, workflow_id, name, trigger_type, status, config_json, watermark, claim_token
        ) VALUES (?, ?, 'Database compatibility trigger', 'database', 'active', ?, '', ?)
    `).run(userId, workflowId, JSON.stringify({
        connectionId: 'test-connection',
        query: 'SELECT * FROM source WHERE updated_at > {{watermark}}',
        watermarkField: 'updated_at',
        inputName: 'rows'
    }), claimToken);
    const triggerId = Number(triggerInfo.lastInsertRowid);

    try {
        configureAgentTriggers({
            createAgentRun: async () => ({ id: `trigger-run-${suffix}` }),
            createAgentNotification: async () => null
        });
        const trigger = sql('SELECT * FROM agent_workflow_triggers WHERE id = ?').get(triggerId);
        const created = await pollDatabaseTrigger(trigger, async (toolName, payload) => {
            assert.equal(toolName, 'db.run_readonly_query');
            assert.match(payload.sql, /updated_at >/);
            return { structuredContent: { rows: [{ updated_at: '2026-08-20 12:00:00', id: 1 }] } };
        });

        assert.equal(created.length, 1);
        const updated = sql('SELECT watermark, claim_token, last_error FROM agent_workflow_triggers WHERE id = ?').get(triggerId);
        assert.equal(updated.watermark, '2026-08-20 12:00:00');
        assert.equal(updated.claim_token, claimToken);
        assert.equal(updated.last_error, null);
    } finally {
        sql('DELETE FROM agent_workflows WHERE id = ?').run(workflowId);
        sql('DELETE FROM users WHERE id = ?').run(userId);
    }
});
