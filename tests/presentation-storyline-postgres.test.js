'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const store = require('../server/services/tool-tasks');
const service = require('../server/services/presentations/presentation-service');
const repository = require('../server/repositories/presentation-storyline');
const tasks = require('../server/services/presentations/storyline/tasks');
const { computePresentationDigest } = require('../server/services/presentations/presentation-schema');
const options = { skip: !process.env.DATABASE_URL, timeout: 60000 };

async function fixture() {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const model = await queryOne("INSERT INTO models(name,url,model_name,user_id) VALUES (?,'http://127.0.0.1:1/v1','storyline-test',?) RETURNING id", ['故事线测试-' + crypto.randomUUID(), user.id]);
    const document = await service.createPresentation(user, { title: '故事线持久化验证', templateId: 'business-blue' });
    return { user, document, model };
}
async function create(f, overrides = {}) {
    const input = { presentationId: f.document.id, scope: 'deck', slideId: '', instruction: '突出行动', modelId: String(f.model.id), baseVersion: Number(f.document.version), contentDigest: computePresentationDigest(f.document.content), ...overrides };
    return repository.create(f.user, input, client => store.createToolTaskStore({ queryOne: client.queryOne, execute: client.execute }).create({ user: f.user, toolName: repository.TOOL, inputRequest: input, ttlMs: 600000 }));
}
function response(f) { return { content: JSON.stringify({ summary: '明确下一步安排', slideOrder: f.document.content.slides.map(slide => slide.id), updates: [{ slideId: f.document.content.slides[0].id, reason: '从泛泛说明改为具体行动', intent: { purpose: '形成下一步行动', takeaway: '先核对材料再推进', stage: 'action', relation: 'sequence', bridgeToNext: '结束汇报', durationSeconds: 30 }, textEdits: [{ elementId: 'title', text: '明确下一步安排' }] }] }), usage: { total_tokens: 9 } }; }
async function propose(f) { const task = await create(f); await tasks.run(f.user, f.document.id, task.id, { callModel: async () => response(f) }); return tasks.get(f.user, f.document.id, task.id); }

test('取消后立即重建时，恢复查询总是返回新任务而非同秒的旧任务', options, async () => {
    const f = await fixture(), first = await create(f);
    await repository.discard(f.user, first.id);
    const second = await create(f);
    assert.equal((await tasks.get(f.user, f.document.id)).id, second.id);
    await tasks.run(f.user, f.document.id, second.id, { callModel: async () => response(f) });
    assert.equal((await tasks.get(f.user, f.document.id)).status, 'input_required');
});

test('故事线持久化方案只预览，显式确认后保存新版本，重试不会重复落版本', options, async () => {
    const f = await fixture(), task = await propose(f);
    assert.equal(task.status, 'input_required'); assert.equal(task.phase, 'proposed'); assert.ok(task.planDigest);
    assert.equal(computePresentationDigest((await service.getPresentation(f.user, f.document.id)).content), computePresentationDigest(f.document.content));
    assert.equal((await tasks.get(f.user, f.document.id)).id, task.id);
    await assert.rejects(() => tasks.apply(f.user, f.document.id, task.id, { confirm: false, planDigest: task.planDigest }), { code: 'PRESENTATION_STORY_CONFIRM_REQUIRED' });
    await assert.rejects(() => tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: 'wrong' }), { code: 'PRESENTATION_STORY_CONFIRM_REQUIRED' });
    const applied = await tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: task.planDigest });
    assert.equal(applied.presentation.version, f.document.version + 1);
    assert.equal(applied.presentation.content.slides[0].elements.find(item => item.id === 'title').content.text, '明确下一步安排');
    const replay = await tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: task.planDigest });
    assert.equal(replay.reused, true); assert.equal(replay.appliedVersion, applied.appliedVersion);
    assert.equal((await service.listPresentationVersions(f.user, f.document.id)).length, 2);
    assert.equal((await tasks.get(f.user, f.document.id)).stale, false);
});

test('相同版本号的草稿新改动使方案失效，放弃后也不能应用', options, async () => {
    const f = await fixture(), task = await propose(f), content = globalThis.structuredClone(f.document.content);
    content.metadata.productionProfile = { audience: '新受众', purpose: '新目标' };
    const saved = await service.savePresentationContent(f.user, f.document.id, { baseVersion: f.document.version, title: f.document.title, content, autoSave: true });
    assert.equal(saved.version, f.document.version); assert.equal((await tasks.get(f.user, f.document.id)).stale, true);
    await assert.rejects(() => tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: task.planDigest }), { code: 'PRESENTATION_STORY_STALE' });
    await assert.rejects(() => service.savePresentationContent(f.user, f.document.id, { baseVersion: saved.version, title: f.document.title, content: f.document.content }, { expectedContentDigest: task.sourceDigest }), { code: 'PRESENTATION_STORY_STALE' });
    await tasks.cancel(f.user, f.document.id, task.id);
    const next = await propose({ ...f, document: saved }); await tasks.cancel(f.user, f.document.id, next.id);
    await assert.rejects(() => tasks.apply(f.user, f.document.id, next.id, { confirm: true, planDigest: next.planDigest }), { code: 'PRESENTATION_STORY_BUSY' });
    assert.equal((await service.getPresentation(f.user, f.document.id)).content.metadata.productionProfile.audience, '新受众');
});

test('并发接纳与确认只有一个执行者，应用租约过期可恢复，账号及文稿互相隔离', options, async () => {
    const f = await fixture(), results = await Promise.allSettled([create(f), create(f)]), admitted = results.find(result => result.status === 'fulfilled').value;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await repository.read({ id: Number(f.user.id) + 9999 }, f.document.id, admitted.id), null);
    assert.equal(await repository.read(f.user, 'another-document', admitted.id), null);
    await tasks.run(f.user, f.document.id, admitted.id, { callModel: async () => response(f) });
    const attempts = await Promise.all([repository.claimApply(f.user, admitted.id, 'first'), repository.claimApply(f.user, admitted.id, 'second')]);
    assert.equal(attempts.filter(Boolean).length, 1); assert.equal(await repository.discard(f.user, admitted.id), null);
    await assert.rejects(() => store.requestCancel(admitted.id, f.user), { code: 'PRESENTATION_STORY_BUSY' });
    await execute("UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_leaseUntil',0) WHERE id=?", [admitted.id]);
    const task = await tasks.get(f.user, f.document.id, admitted.id);
    assert.equal(task.canResumeApply, true);
    const result = await tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: task.planDigest });
    assert.equal(result.appliedVersion, f.document.version + 1);
});

test('确认与草稿并发时在最终写入核对原稿，冲突不会留下产物版本或覆盖草稿', options, async () => {
    const f = await fixture(), task = await propose(f), pool = require('../server/db/pg-connection').getPgPool(), blocker = await pool.connect();
    const artifactBefore = await queryOne('SELECT content,current_version_id FROM agent_artifacts WHERE id=?', [f.document.artifactId]);
    let applying;
    try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM presentation_documents WHERE client_id=$1 FOR UPDATE', [f.document.id]);
        applying = tasks.apply(f.user, f.document.id, task.id, { confirm: true, planDigest: task.planDigest }).then(value => ({ value }), error => ({ error }));
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            const active = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE presentation_documents%'");
            if (active.rowCount) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.equal(waiting, true, '确认应停在最终文稿条件写入');
        const concurrent = globalThis.structuredClone(f.document.content); concurrent.slides[0].elements.find(item => item.id === 'title').content.text = '协作者的新草稿';
        await blocker.query('UPDATE presentation_documents SET content_json=$1 WHERE client_id=$2', [JSON.stringify(concurrent), f.document.id]);
        await blocker.query('COMMIT');
        const result = await applying; assert.equal(result.error?.code, 'PRESENTATION_VERSION_CONFLICT');
        assert.equal((await service.getPresentation(f.user, f.document.id)).content.slides[0].elements.find(item => item.id === 'title').content.text, '协作者的新草稿');
        assert.deepEqual(await queryOne('SELECT content,current_version_id FROM agent_artifacts WHERE id=?', [f.document.artifactId]), artifactBefore);
        assert.equal((await service.listPresentationVersions(f.user, f.document.id)).length, 1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (applying) await applying; }
});

test('取消会立即中断模型调用，迟到的结果不能写入；丢失编辑权限后拒绝操作', options, async () => {
    const f = await fixture(), task = await create(f); let entered, observed;
    const started = new Promise(resolve => entered = resolve);
    const running = tasks.run(f.user, f.document.id, task.id, { callModel: ({ signal }) => new Promise(resolve => { entered(); signal.addEventListener('abort', () => { observed = true; resolve(response(f)); }, { once: true }); }) });
    await started; await tasks.cancel(f.user, f.document.id, task.id); await running;
    assert.equal(observed, true); assert.equal((await tasks.get(f.user, f.document.id, task.id)).status, 'cancelled');
    const other = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING *", ['story-viewer-' + crypto.randomBytes(5).toString('hex')]);
    await service.addPresentationCollaborator(f.user, f.document.id, { userId: other.id, role: 'viewer' });
    await assert.rejects(() => tasks.start(other, f.document.id, { modelId: String(f.model.id) }), { code: 'PRESENTATION_EDIT_FORBIDDEN' });
    await assert.rejects(() => tasks.apply(other, f.document.id, task.id, { confirm: true }), { code: 'PRESENTATION_EDIT_FORBIDDEN' });
    await service.removePresentationCollaborator(f.user, f.document.id, other.id);
    await assert.rejects(() => tasks.get(other, f.document.id, task.id), /无权访问|不存在/);
    await assert.rejects(() => tasks.start(f.user, f.document.id, { modelId: 'missing-model' }), { code: 'PRESENTATION_MODEL_UNAVAILABLE' });
});

test('共享权限撤销后，通用任务入口也不能读取旧方案或绕过取消边界', options, async () => {
    const f = await fixture(), editor = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING *", ['story-editor-' + crypto.randomBytes(5).toString('hex')]);
    await service.addPresentationCollaborator(f.user, f.document.id, { userId: editor.id, role: 'editor' });
    const task = await create({ ...f, user: editor });
    await store.complete(task.id, editor, { preview: { summary: '仅授权编辑者可读的旧方案' } });
    assert.equal((await store.getForUser(task.id, editor)).result.preview.summary, '仅授权编辑者可读的旧方案');
    await service.removePresentationCollaborator(f.user, f.document.id, editor.id);
    assert.equal(await store.getForUser(task.id, editor), null);
    await assert.rejects(() => store.requestCancel(task.id, editor), /无权访问|不存在/);
});
