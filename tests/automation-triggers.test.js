// 自动化增强回归测试：cron 调度、部门可见性和工作流触发器
const assert = require('node:assert/strict');
const test = require('node:test');

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
const { normalizeSlug } = require('../server/services/workflow-credentials');

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

test('仅自己可见时清空部门范围', () => {
    const user = { id: 2, role: 'user', username: 'zhangsan', unit: '财务处' };
    const result = normalizeShareSettings({ scope: 'personal', allowedUnits: '财务处' }, user);
    assert.equal(result.scope, 'personal');
    assert.equal(result.allowedUnits, '');
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
