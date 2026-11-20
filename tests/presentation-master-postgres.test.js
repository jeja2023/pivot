'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { queryOne, execute } = require('../server/db/client');
const taskStore = require('../server/services/tool-tasks');
const repository = require('../server/repositories/presentation-master-tasks');

test('完整引擎真实租约防止重复执行，保留检查点与确认答复并隔离账号，取消后旧租约不能写回', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const other = { id: Number(user.id) + 99999 };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: { presentationId: 'ppt-protected' }, ttlMs: 600000 });
    try {
        const first = crypto.randomUUID(), second = crypto.randomUUID();
        const claims = await Promise.all([repository.claim(user, task.id, first), repository.claim(user, task.id, second)]);
        assert.equal(claims.filter(Boolean).length, 1);
        const winner = claims[0] ? first : second, loser = claims[0] ? second : first;
        const state = { request: { presentationId: 'ppt-protected' }, steps: 2, usedTokens: 123, prepared: true };
        assert.ok(await repository.save(user, task.id, winner, state, { phase: 'authoring' }));
        assert.equal(await repository.save(user, task.id, loser, state, {}), null);
        assert.equal(await repository.read(other, task.id), null);
        assert.equal(await repository.claim(other, task.id, crypto.randomUUID()), null);
        assert.equal((await repository.read(user, task.id)).result_json.state.usedTokens, 123);
        await taskStore.requestInput(task.id, user, { question: '旧租约问题' }, { expectedLease: loser });
        assert.equal((await repository.read(user, task.id)).status, 'working');
        await taskStore.complete(task.id, user, { stale: true }, { expectedLease: loser, failed: true });
        assert.equal((await repository.read(user, task.id)).status, 'working', '旧执行不能将新租约任务标为失败');
        await taskStore.requestInput(task.id, user, { question: '确认方案？' });
        assert.equal(await repository.claim(user, task.id, crypto.randomUUID()), null);
        const answered = { ...state, response: '确认，保留金额。' };
        const accepted = await Promise.all([repository.acceptResponse(user, task.id, answered), repository.acceptResponse(user, task.id, answered)]);
        assert.equal(accepted.filter(Boolean).length, 1);
        assert.equal((await repository.latest(user, 'ppt-protected')).id, task.id);
        assert.equal((await repository.read(user, task.id)).result_json.state.response, answered.response);
        const resumedLease = crypto.randomUUID(); assert.ok(await repository.claim(user, task.id, resumedLease));
        assert.equal(await repository.resume(user, task.id, answered), null, '有效租约不能被继续请求接管');
        await taskStore.requestCancel(task.id, user);
        assert.equal(await repository.save(user, task.id, resumedLease, state, {}), null);
        assert.equal(await repository.resume(user, task.id, answered), null, '取消的任务不能被自动恢复');
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('完整引擎接纳与任务创建在同一事务中，多个请求不能突破单用户名额', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const created = [];
    const create = () => repository.admit(user, client => taskStore.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user, toolName: repository.TOOL, ttlMs: 600000 }));
    try {
        const results = await Promise.allSettled([create(), create()]);
        for (const result of results) if (result.status === 'fulfilled') created.push(result.value.id);
        assert.equal(created.length, 1); assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'PPT_MASTER_CAPACITY_BUSY').length, 1);
        await taskStore.requestCancel(created[0], user);
        const next = await create(); created.push(next.id); assert.notEqual(next.id, created[0]);
    } finally { for (const id of created) await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [id, user.id]); }
});

test('活跃检查点和心跳延长到期时间，超过执行上限或租约过期时不能延长', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, ttlMs: 600000 });
    const lease = crypto.randomUUID(), state = { request: { presentationId: '' }, steps: 31 };
    try {
        assert.ok(await repository.claim(user, task.id, lease));
        assert.equal(await repository.renew(user, task.id, crypto.randomUUID()), null);
        assert.ok(await repository.renew(user, task.id, lease));
        const renewed = await repository.read(user, task.id);
        assert.ok(Date.parse(renewed.expires_at) > Date.now() + 55 * 60000);
        assert.ok(renewed.result_json._runDeadline > Date.now() / 1000 + 7.9 * 3600);
        await execute(`UPDATE tool_tasks SET expires_at=NOW()+INTERVAL '10 minutes',
            result_json=result_json||jsonb_build_object('_runDeadline', extract(epoch from NOW()+INTERVAL '40 minutes')) WHERE id=?`, [task.id]);
        assert.ok(await repository.save(user, task.id, lease, state, { phase: 'authoring' }));
        const saved = await repository.read(user, task.id);
        const { expiry_epoch: expires } = await queryOne('SELECT extract(epoch from expires_at) AS expiry_epoch FROM tool_tasks WHERE id=?', [task.id]);
        assert.equal(Number(expires), saved.result_json._runDeadline);
        assert.equal(saved.result_json.state.steps, 31);
        await execute("UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_leaseUntil',extract(epoch from NOW())-1) WHERE id=?", [task.id]);
        assert.equal(await repository.renew(user, task.id, lease), null);
        assert.equal(await repository.save(user, task.id, lease, state, {}), null);
        const nextLease = crypto.randomUUID();
        assert.ok(await repository.claim(user, task.id, nextLease));
        assert.equal((await repository.read(user, task.id)).result_json._runDeadline, saved.result_json._runDeadline);
        await execute("UPDATE tool_tasks SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [task.id]);
        assert.equal(await repository.renew(user, task.id, nextLease), null);
        assert.equal((await taskStore.getForUser(task.id, user)).status, 'expired');
        assert.ok(await repository.resume(user, task.id, state));
        assert.ok(await repository.claim(user, task.id, lease));
        assert.ok((await repository.read(user, task.id)).result_json._runDeadline > saved.result_json._runDeadline);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('过期检查点可续跑，待确认任务必须先提交实际答复，取消任务不能复活', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, ttlMs: 600000 });
    const base = { request: { presentationId: '', tokenBudget: 1000000, maxSteps: 80 }, steps: 3, usedTokens: 321 };
    try {
        await execute("UPDATE tool_tasks SET status='expired',result_json=?::jsonb WHERE id=?", [JSON.stringify({ state: base }), task.id]);
        assert.ok(await repository.resume(user, task.id, base));
        assert.equal((await repository.read(user, task.id)).result_json.state.usedTokens, 321);
        const pending = { ...base, pendingKind: 'confirmation' };
        await execute("UPDATE tool_tasks SET status='expired',result_json=?::jsonb WHERE id=?", [JSON.stringify({ state: pending }), task.id]);
        assert.equal(await repository.resume(user, task.id, pending), null);
        assert.ok(await repository.acceptResponse(user, task.id, { ...pending, response: '确认保留金额' }));
        assert.equal((await repository.read(user, task.id)).result_json.state.response, '确认保留金额');
        await execute("UPDATE tool_tasks SET status='expired' WHERE id=?", [task.id]);
        assert.ok(await repository.resume(user, task.id, { ...pending, response: '确认保留金额' }));
        await taskStore.requestCancel(task.id, user);
        assert.equal(await repository.resume(user, task.id, base), null);
        assert.equal(await repository.acceptResponse(user, task.id, pending), null);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('从旧检查点取消累计上限后保留已用量，再次续跑沿用不限', { skip: !process.env.DATABASE_URL }, async () => {
    const { resume } = require('../server/services/presentations/master/tasks');
    const { identity } = require('../server/services/presentations/master/runtime');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { presentationId: '', modelId: '1', tokenBudget: 1000000, maxSteps: 5 };
    const state = { request, usedTokens: 1000200, steps: 5, prepared: true, bootstrapped: true, runtimeImage: await identity(), messages: [] };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 600000 });
    try {
        await taskStore.complete(task.id, user, { state }, { failed: true, errorCode: 'PPT_MASTER_BUDGET_EXHAUSTED' });
        await assert.rejects(resume({ id: Number(user.id) + 99999 }, task.id, { tokenBudget: 0 }), { code: 'PPT_MASTER_BUSY' });
        await assert.rejects(resume(user, task.id, { tokenBudget: 900000 }), { code: 'PPT_MASTER_INVALID' });
        for (const input of [{ tokenBudget: 0 }, {}]) {
            const resumed = await resume(user, task.id, input);
            assert.equal(resumed.request.tokenBudget, 0);
            assert.equal(resumed.usedTokens, state.usedTokens);
            assert.equal(resumed.steps, state.steps);
            let row;
            for (let attempt = 0; attempt < 100; attempt++) {
                row = await repository.read(user, task.id);
                if (row.status === 'failed' && !row.result_json._lease) break;
                await delay(20);
            }
            assert.equal(row.error_code, 'PPT_MASTER_STEP_LIMIT');
            assert.equal(row.result_json.state.request.tokenBudget, 0);
        }
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('旧的 120 秒超时熔断检查点续跑时登记优先整理历史', { skip: !process.env.DATABASE_URL }, async () => {
    const { resume } = require('../server/services/presentations/master/tasks');
    const { identity } = require('../server/services/presentations/master/runtime');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { presentationId: '', modelId: '1', tokenBudget: 10000000, maxSteps: 32 };
    const state = { request, usedTokens: 1509415, steps: 32, prepared: true, bootstrapped: true, runtimeImage: await identity(), messages: [] };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request, ttlMs: 600000 });
    try {
        await taskStore.complete(task.id, user, { state }, { failed: true, errorCode: 'AI_ENDPOINT_CIRCUIT_OPEN',
            errorMessage: '模型端点暂时熔断，约 55 秒后可重试。上次错误：timeout of 120000ms exceeded' });
        await resume(user, task.id);
        let row;
        for (let attempt = 0; attempt < 100; attempt++) {
            row = await repository.read(user, task.id);
            if (row.status === 'failed' && !row.result_json._lease) break;
            await delay(20);
        }
        assert.equal(row.error_code, 'PPT_MASTER_STEP_LIMIT');
        assert.equal(row.result_json.state.focusModelHistory, true);
        assert.equal(row.result_json.state.usedTokens, 1509415);
        assert.equal(row.result_json.state.steps, 32);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('模型超时的计时和未知用量随任务失败保存，重读仍可见', { skip: !process.env.DATABASE_URL }, async () => {
    const { run, get } = require('../server/services/presentations/master/tasks');
    const { runModelTurn } = require('../server/services/presentations/master/model-turn');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { presentationId: '', operation: 'generate', profile: 'default', materials: [], tokenBudget: 0, maxSteps: 80 };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request });
    try {
        await run(task.id, user, {
            drive: (owner, id, state, hooks) => runModelTurn(owner, id, state, { context_window_tokens: 32000, max_tokens: 8000 }, hooks, {
                messagesForModel: async () => [{ role: 'user', content: '测试制作材料' }],
                callModel: async () => { throw Object.assign(new Error('模型响应超时。'), { code: 'ECONNABORTED' }); }
            })
        });
        const result = await get(user, task.id);
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, 'PPT_MASTER_MODEL_TIMEOUT');
        assert.equal(result.usageDiagnostics.length, 1);
        const [attempt] = result.usageDiagnostics;
        assert.equal(attempt.outcome, 'model_failed');
        assert.match(attempt.startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        assert.ok(Number.isSafeInteger(attempt.durationMs) && attempt.durationMs >= 0);
        assert.equal(attempt.inputTokens, null);
        assert.equal(attempt.outputTokens, null);
        assert.equal(result.usedTokens, 0);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('旧沟通方向等待项可直接继续，保留用量且不登记最终批准', { skip: !process.env.DATABASE_URL }, async () => {
    const { get, respond } = require('../server/services/presentations/master/tasks');
    const { identity } = require('../server/services/presentations/master/runtime');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { presentationId: '', operation: 'generate', profile: 'default', pageCount: 8, modelId: '1', tokenBudget: 0, maxSteps: 5 };
    const pendingInput = { stage: 'direction', question: '请确认沟通方向', plan: { summary: '经营汇报' } };
    const state = { request, steps: 5, usedTokens: 8000, prepared: true, bootstrapped: true, runtimeImage: await identity(),
        pendingKind: 'confirmation', pendingInput, review: { version: 1, approvals: {} },
        messages: [{ role: 'system', content: '存量制作任务' }] };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request });
    try {
        const lease = crypto.randomUUID();
        await repository.claim(user, task.id, lease);
        await repository.save(user, task.id, lease, state, { phase: 'input_required' });
        await taskStore.requestInput(task.id, user, pendingInput, { expectedLease: lease });
        await repository.release(user, task.id, lease);
        const { inputRequest } = await get(user, task.id);
        assert.equal(inputRequest.kind, 'continue');
        assert.equal(inputRequest.stage, undefined);
        await assert.rejects(respond(user, task.id, { decision: 'approve', promptId: inputRequest.promptId }), { code: 'PPT_MASTER_CONFIRMATION_CHANGED' });
        await assert.rejects(respond(user, task.id, { decision: 'continue' }), { code: 'PPT_MASTER_CONFIRMATION_CHANGED' });
        await respond(user, task.id, { decision: 'continue', promptId: inputRequest.promptId });
        let row;
        for (let attempt = 0; attempt < 100; attempt++) {
            row = await repository.read(user, task.id);
            if (row.status === 'failed' && !row.result_json._lease) break;
            await delay(20);
        }
        assert.equal(row.error_code, 'PPT_MASTER_STEP_LIMIT');
        const resumed = row.result_json.state;
        assert.equal(resumed.usedTokens, 8000);
        assert.deepEqual(resumed.review.approvals, {});
        assert.equal(resumed.pendingKind, undefined);
        assert.equal(resumed.milestones?.firstApproval, undefined);
        assert.match(resumed.messages.at(-1).content, /直接准备最终页面与关键数据清单/);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('旧阶段上限与新引文暂停均可在补充原文后续作并保留八页草案', { skip: !process.env.DATABASE_URL }, async () => {
    const { get, resume } = require('../server/services/presentations/master/tasks');
    const { identity } = require('../server/services/presentations/master/runtime');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { presentationId: '', operation: 'generate', profile: 'default', pageCount: 8, modelId: '1', tokenBudget: 0, maxSteps: 5 };
    const draft = { stage: 'design', plan: { summary: '项目经营汇报', pages: Array.from({ length: 8 }, (_, index) => ({ title: '第 ' + (index + 1) + ' 页', values: [] })) } };
    const issue = { location: '第 1 页第 1 项（inputs/material-1.md）', page: 1, item: 1, title: '第 1 页',
        text: '收入120万元', reason: '关键数据未完整出现在引文中，请核对数字、单位及原文范围。' };
    for (const errorCode of ['PPT_MASTER_PHASE_LIMIT', 'PPT_MASTER_CITATION_REVIEW_REQUIRED']) {
        const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request });
        const state = { request, usedTokens: 466661, steps: 5, prepared: true, bootstrapped: true, runtimeImage: await identity(), messages: [],
            review: { version: 1, approvals: { direction: { plan: { summary: '经营汇报' } } } },
            citationDraft: draft, citationRepair: [issue], workflowProgress: { phase: 'design', calls: 18 } };
        try {
            await taskStore.complete(task.id, user, { state }, { failed: true, errorCode });
            assert.equal((await get(user, task.id)).citationReview.items[0].reason, issue.reason);
            await assert.rejects(resume(user, task.id), { code: 'PPT_MASTER_CITATION_REVIEW_REQUIRED' });
            await resume(user, task.id, { resumeNote: '经核对，项目收入120万元。' });
            let row;
            for (let attempt = 0; attempt < 100; attempt++) {
                row = await repository.read(user, task.id);
                if (row.status === 'failed' && !row.result_json._lease) break;
                await delay(20);
            }
            assert.equal(row.error_code, 'PPT_MASTER_STEP_LIMIT');
            const resumed = row.result_json.state;
            assert.equal(resumed.workflowProgress, undefined);
            assert.equal(resumed.usedTokens, state.usedTokens);
            assert.deepEqual(resumed.citationDraft, draft);
            assert.match(resumed.messages.at(-1).content, /沿用已保存的完整清单.*id.*repairCitations/);
        } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
    }
});

test('活动制作可以跨文稿查询，过期读请求不会撤销刚延长的截止时间', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: { presentationId: 'previous-document' } });
    try {
        assert.equal(await repository.latest(user, 'current-document'), null);
        assert.equal((await repository.findActive(user)).id, task.id);
        assert.equal(await repository.findActive({ id: Number(user.id) + 99999 }), null);
        await execute("UPDATE tool_tasks SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [task.id]);
        let extended = false;
        const reader = taskStore.createToolTaskStore({ execute, queryOne: async (sql, params) => {
            const row = await queryOne(sql, params);
            if (!extended) {
                extended = true;
                await execute("UPDATE tool_tasks SET expires_at=NOW()+INTERVAL '1 hour' WHERE id=?", [task.id]);
            }
            return row;
        } });
        assert.equal((await reader.getForUser(task.id, user)).status, 'working');
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('PPT 交付事务中断不留下产物，重试同一回执原子提交并复用文件', { skip: !process.env.DATABASE_URL }, async t => {
    const { prepareDelivery, commitDelivery } = require('../server/services/presentations/master/delivery');
    const runtime = require('../server/services/presentations/master/runtime');
    const { query } = require('../server/db/client');
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const request = { title: '交付事务测试 ' + crypto.randomUUID(), draftFirst: true };
    const task = await taskStore.create({ user, toolName: repository.TOOL, inputRequest: request });
    const lease = crypto.randomUUID(), pptx = Buffer.from('用于事务验收的合成主输出'), zip = Buffer.from('用于事务验收的合成源包');
    const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const receipt = { sha256: digest(pptx), projectSha256: digest(zip), packageCheck: { status: 'passed', slideCount: 1, currentExportSha256: digest(pptx) } };
    const deliveryContext = { engine: { runtimeId: 'sha256:' + 'a'.repeat(64), revision: 'synthetic-runtime' } };
    const artifacts = () => query('SELECT id FROM agent_artifacts WHERE user_id=? AND title=?', [user.id, request.title + '-初稿']);
    const { listPresentations } = require('../server/services/presentations/presentation-service');
    const listDrafts = filter => listPresentations(user, { includeMasterDrafts: true, status: 'draft', search: request.title, ...filter });
    let broken = true;
    t.mock.method(runtime, 'readOutput', async (_user, _id, file) => {
        if (file === 'presentation.pptx') return pptx;
        if (broken === 'large') throw runtime.error('超过大小上限', 'PPT_SERVICE_RESPONSE_TOO_LARGE', 502);
        if (broken) throw new Error('模拟源包传输失败');
        return zip;
    });
    try {
        assert.ok(await repository.claim(user, task.id, lease));
        await assert.rejects(prepareDelivery(user, task.id, request, receipt, deliveryContext), /传输失败/);
        assert.equal((await artifacts()).length, 0);
        broken = 'large';
        const withoutBundle = await prepareDelivery(user, task.id, request, receipt, deliveryContext);
        assert.deepEqual(withoutBundle.files.map(file => file.format), ['pptx']);
        assert.match(withoutBundle.sourcePackageWarning, /完整项目源包/);
        broken = false;
        const prepared = await prepareDelivery(user, task.id, request, receipt, deliveryContext);
        await assert.rejects(repository.withExecution(user, task.id, lease, async executor => {
            await commitDelivery(user, task.id, request, prepared, executor);
            throw new Error('模拟任务状态写入失败');
        }), /写入失败/);
        assert.equal((await artifacts()).length, 0);
        const result = await repository.withExecution(user, task.id, lease, async executor => {
            const first = await commitDelivery(user, task.id, request, prepared, executor);
            const replay = await commitDelivery(user, task.id, request, prepared, executor);
            assert.deepEqual(first, replay);
            const txStore = taskStore.createToolTaskStore({ queryOne: executor.queryOne, execute: executor.execute });
            assert.equal((await txStore.complete(task.id, user, { state: { request }, publicResult: replay }, { expectedLease: lease })).status, 'completed');
            return first;
        });
        assert.equal((await artifacts()).length, 1);
        assert.equal(result.files.length, 2);
        assert.deepEqual((await listDrafts()).map(({ id, masterDraft, status }) => ({ id, masterDraft, status })),
            [{ id: task.id, masterDraft: true, status: 'draft' }]);
        assert.deepEqual(await listDrafts({ status: 'ready' }), []);
        assert.deepEqual(await listDrafts({ favorite: true }), []);
        assert.deepEqual(await listDrafts({ search: request.title + '-缺失' }), []);
        assert.deepEqual(await listDrafts({ includeMasterDrafts: false }), []);
        assert.match((await queryOne('SELECT renderer_version FROM agent_artifact_renditions WHERE id=?', [result.files[0].renditionId])).renderer_version, /^ppt-master-[a-f0-9]{20}$/);
        await assert.rejects(repository.withExecution(user, task.id, lease, () => assert.fail('成功任务不能再次登记')), { code: 'PPT_MASTER_LEASE_LOST' });
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});

test('压缩归档随租约检查点持久化，隔离账号不能读取，恢复后可分页取回原观察', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const task = await taskStore.create({ user, toolName: repository.TOOL, ttlMs: 600000 });
    const state = { request: { presentationId: '', tokenBudget: 1000000, maxSteps: 80 }, messages: [{ role: 'system', content: '完整指引' }] };
    for (let index = 0; index < 12; index++) {
        state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read', path: `inputs/${index}.md` }] }) });
        state.messages.push({ role: 'user', content: JSON.stringify([{ action: 'read', result: { path: `inputs/${index}.md`, text: '中文资料'.repeat(18000) } }]) });
    }
    const original = state.messages[2].content, lease = crypto.randomUUID();
    try {
        assert.equal(await require('../server/services/presentations/master/history').archiveOlderObservations(state), true);
        assert.ok(await repository.claim(user, task.id, lease));
        assert.ok(await repository.save(user, task.id, lease, state, { phase: 'authoring' }));
        assert.equal(await repository.read({ id: Number(user.id) + 99999 }, task.id), null);
        const restored = (await repository.read(user, task.id)).result_json.state;
        let text = '', offset = 0;
        do {
            const chunk = await require('../server/services/presentations/master/history').readHistory(restored, { archive: 0, index: 2, offset });
            text += chunk.text; offset = chunk.nextOffset;
        } while (offset !== null);
        assert.equal(text, original);
    } finally { await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]); }
});
