'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { queryOne, execute, query } = require('../server/db/client');
const goals = require('../server/services/agent-goals');

test('持续目标真实轮询越过一百个保留文件且回绕去重，数据库目标按数值推进水位', { timeout: 30000, skip: !process.env.DATABASE_URL }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-goal-poll-'));
    const originalRoots = process.env.AGENT_GOAL_FILE_ROOTS;
    const user = await queryOne("INSERT INTO users(username,password_hash,status,role,unit) VALUES (?,'hash','active','user','测试') RETURNING id,username,status,role,unit", [`poll_${crypto.randomUUID()}`]);
    let modelId;
    let databaseRows = [{ id: 9 }, { id: 10 }];
    const goalIds = [];
    try {
        process.env.AGENT_GOAL_FILE_ROOTS = directory;
        const model = await queryOne("INSERT INTO models(user_id,name,model_name,url,status) VALUES (?,'轮询测试模型','synthetic','https://synthetic.invalid/v1','active') RETURNING id", [user.id]);
        modelId = model.id;
        await Promise.all(Array.from({ length: 101 }, async (_, index) => {
            const file = path.join(directory, `${String(index).padStart(4, '0')}.txt`);
            await fs.writeFile(file, '待处理文件'); await fs.utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
        }));
        goals.configureAgentGoals({ createAgentNotification: async () => null,
            executeReadOnlyQuery: async () => ({ rows: databaseRows }),
            createAgentRun: async body => {
                const id = `poll_run_${crypto.randomUUID()}`;
                await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,model_id,dedupe_key,metadata) VALUES (?,?,'轮询回归','处理来源','completed',?,?,?::jsonb)", [id, body.user.id, body.modelId, body.dedupeKey, JSON.stringify(body.metadata)]);
                return { id, status: 'completed' };
            } });
        const create = async triggerSpec => {
            const result = await goals.createAgentGoal(user, { title: '来源轮询回归', goal: '读取本轮新增来源并记录', kind: 'monitor', triggerSpec,
                authorizationSpec: { modelId }, budgetSpec: { maxRunsPerWindow: 1000 } });
            goalIds.push(result.goal.id); return result.goal.id;
        };
        const makeDue = id => execute("UPDATE agent_goals SET status='active',next_run_at=NOW()-INTERVAL '100 years' WHERE id=?", [id]);
        const fileGoal = await create({ type: 'file', directory, extensions: ['txt'], stableSeconds: 1 });
        for (let round = 0; round < 3; round++) { await makeDue(fileGoal); await goals.runDueAgentGoals(1); }
        const fileRuns = await query("SELECT metadata FROM agent_runs WHERE user_id=? AND metadata->>'goalId'=?", [user.id, fileGoal]);
        assert.equal(fileRuns.length, 101);
        assert.ok(fileRuns.some(row => row.metadata.triggerInputs.fileName === '0100.txt'));
        assert.equal((await queryOne('SELECT last_error FROM agent_goals WHERE id=?', [fileGoal])).last_error, '');
        await execute("UPDATE agent_goals SET status='paused',next_run_at=NULL WHERE id=?", [fileGoal]);
        const databaseGoal = await create({ type: 'database', connectionId: 'synthetic', query: 'SELECT id FROM source WHERE id > {{watermark}}', watermarkField: 'id', watermark: '8' });
        await makeDue(databaseGoal); await goals.runDueAgentGoals(1);
        const database = await queryOne('SELECT trigger_spec,last_error FROM agent_goals WHERE id=?', [databaseGoal]);
        assert.equal(database.last_error, ''); assert.equal(database.trigger_spec.watermark, '10');
        // 模拟任务已接纳但水位提交前退出；即使运行配额已满也必须接续已接纳批次。
        await execute("UPDATE agent_goals SET trigger_spec=jsonb_set(trigger_spec,'{watermark}','\"8\"'::jsonb),budget_spec=jsonb_set(budget_spec,'{maxRunsPerWindow}','1'::jsonb) WHERE id=?", [databaseGoal]);
        await makeDue(databaseGoal); await goals.runDueAgentGoals(1);
        const recovered = await queryOne('SELECT trigger_spec,last_error FROM agent_goals WHERE id=?', [databaseGoal]);
        assert.equal(recovered.last_error, ''); assert.equal(recovered.trigger_spec.watermark, '10');
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS count FROM agent_runs WHERE user_id=? AND metadata->>'goalId'=?", [user.id, databaseGoal])).count), 1);
        await execute("UPDATE agent_goals SET trigger_spec=jsonb_set(trigger_spec,'{watermark}','\"8\"'::jsonb) WHERE id=?", [databaseGoal]);
        databaseRows = [{ id: 9, note: '来源内容已变化' }, { id: 10 }];
        await makeDue(databaseGoal); await goals.runDueAgentGoals(1);
        const conflict = await queryOne('SELECT trigger_spec,last_error FROM agent_goals WHERE id=?', [databaseGoal]);
        assert.equal(conflict.trigger_spec.watermark, '8'); assert.match(conflict.last_error, /来源内容不一致/);
    } finally {
        for (const id of goalIds) await execute('DELETE FROM agent_goals WHERE id=?', [id]);
        await execute('DELETE FROM agent_runs WHERE user_id=?', [user.id]);
        if (modelId) await execute('DELETE FROM models WHERE id=?', [modelId]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
        if (originalRoots === undefined) delete process.env.AGENT_GOAL_FILE_ROOTS; else process.env.AGENT_GOAL_FILE_ROOTS = originalRoots;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
