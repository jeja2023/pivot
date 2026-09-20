const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    DRAFT_TTL_MS,
    confirmedGoalDraftInput,
    createGoalDraft,
    extractIntervalMinutes,
    extractTime,
    scheduleFromPrompt,
    mergeConfirmedGoalDraftOverrides
} = require('../server/services/agent-goal-drafts');

const USER = { id: 731 };
const SECRET = 'agent-goal-draft-test-secret-012345678901234567890';
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

test('natural language goal draft parses bounded schedules without inferring external authority', () => {
    const weekdays = createGoalDraft(USER, '每个工作日 09:30 检查项目风险并通知我', { secret: SECRET, now: NOW });
    assert.equal(weekdays.draft.canConfirm, true);
    assert.equal(weekdays.draft.triggerSpec.type, 'timer');
    assert.equal(weekdays.draft.triggerSpec.frequency, 'weekdays');
    assert.equal(weekdays.draft.triggerSpec.timeOfDay, '09:30');
    assert.equal(weekdays.draft.authorizationSpec.toolPolicy, 'builtin_only');
    assert.equal(weekdays.draft.authorizationSpec.approvalPolicy, 'safe_mcp_auto');
    assert.equal(weekdays.draft.deliveryHint.requiresChannelSelection, true);
    assert.ok(weekdays.confirmationToken);

    const interval = scheduleFromPrompt('Every 2 hours at 9am summarize new reports');
    assert.equal(interval.triggerSpec.frequency, 'interval');
    assert.equal(interval.triggerSpec.intervalMinutes, 120);
    assert.equal(interval.triggerSpec.timeOfDay, '09:00');
    assert.equal(extractIntervalMinutes('每隔 15 分钟运行一次'), 15);
    assert.equal(extractTime('每周一 at 7:05pm'), '19:05');
});

test('confirmed goal only accepts explicit presentation-level snapshot overrides', () => {
    const created = createGoalDraft(USER, '每天 08:00 汇总项目待办', { secret: SECRET, now: NOW });
    const signed = confirmedGoalDraftInput(USER, created.confirmationToken, { secret: SECRET, now: NOW + 1000 });
    const merged = mergeConfirmedGoalDraftOverrides(signed, {
        title: '篡改标题', triggerSpec: { type: 'webhook' },
        authorizationSpec: { timezone: 'UTC', deliveryBindingIds: ['channel_allowed'], resultRetentionDays: 14, toolPolicy: 'all' }
    });
    assert.equal(merged.title, signed.title);
    assert.equal(merged.triggerSpec.type, 'timer');
    assert.equal(merged.authorizationSpec.toolPolicy, 'builtin_only');
    assert.equal(merged.authorizationSpec.timezone, 'UTC');
    assert.deepEqual(merged.authorizationSpec.deliveryBindingIds, ['channel_allowed']);
});

test('natural language goal drafts require missing high-risk source details before confirmation', () => {
    const timer = createGoalDraft(USER, '定时检查项目风险', { secret: SECRET, now: NOW });
    assert.equal(timer.draft.canConfirm, false);
    assert.equal(timer.confirmationToken, null);
    assert.equal(timer.draft.missingFields[0].key, 'schedule');

    const file = createGoalDraft(USER, '发现新文件后整理并通知我', { secret: SECRET, now: NOW });
    assert.equal(file.draft.triggerSpec.type, 'file');
    assert.equal(file.draft.canConfirm, false);
    assert.equal(file.draft.missingFields[0].key, 'directory');

    const database = createGoalDraft(USER, '数据库变更后生成日报', { secret: SECRET, now: NOW });
    assert.equal(database.draft.triggerSpec.type, 'database');
    assert.equal(database.draft.canConfirm, false);
    assert.deepEqual(database.draft.missingFields.map(item => item.key), ['connectionId', 'query']);
});

test('confirmed goal draft is signed, user-scoped, expiring, and authoritative', () => {
    const created = createGoalDraft(USER, '每天 08:00 汇总项目待办', { secret: SECRET, now: NOW });
    const confirmed = confirmedGoalDraftInput(USER, created.confirmationToken, { secret: SECRET, now: NOW + 1000 });
    assert.equal(confirmed.goal, '每天 08:00 汇总项目待办');
    assert.equal(confirmed.triggerSpec.timeOfDay, '08:00');
    assert.equal(confirmed.authorizationSpec.toolPolicy, 'builtin_only');

    assert.throws(
        () => confirmedGoalDraftInput({ id: USER.id + 1 }, created.confirmationToken, { secret: SECRET, now: NOW + 1000 }),
        error => error.code === 'AGENT_GOAL_DRAFT_SCOPE_DENIED'
    );
    assert.throws(
        () => confirmedGoalDraftInput(USER, `${created.confirmationToken}tampered`, { secret: SECRET, now: NOW + 1000 }),
        error => error.code === 'AGENT_GOAL_DRAFT_TOKEN_INVALID'
    );
    assert.throws(
        () => confirmedGoalDraftInput(USER, created.confirmationToken, { secret: SECRET, now: NOW + DRAFT_TTL_MS + 1 }),
        error => error.code === 'AGENT_GOAL_DRAFT_TOKEN_EXPIRED'
    );
});

test('goal draft route and workbench require preview confirmation before using a signed draft', () => {
    const route = fs.readFileSync(path.resolve(__dirname, '../server/routes/agent-control-plane.js'), 'utf8');
    const client = fs.readFileSync(path.resolve(__dirname, '../client/chat/agent-personal-experience.js'), 'utf8');
    const partial = fs.readFileSync(path.resolve(__dirname, '../client/chat/partials/workspaces/agent.html'), 'utf8');

    assert.match(route, /router\.post\('\/agents\/goals\/parse'/);
    assert.match(route, /confirmedGoalDraftInput\(req\.user, confirmationToken\)/);
    assert.match(client, /\/agents\/goals\/parse/);
    assert.match(client, /confirmationToken && !editId \? \{ confirmationToken, goalOverrides: fallback \}/);
    assert.match(client, /确认并创建目标/);
    assert.match(partial, /id="agent-goal-natural-input"/);
    assert.match(partial, /id="agent-goal-draft-token"/);
});
