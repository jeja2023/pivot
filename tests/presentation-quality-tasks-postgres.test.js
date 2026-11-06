'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const service = require('../server/services/presentations/presentation-service');
const tasks = require('../server/services/presentations/presentation-quality-tasks');
const { compileDesignPlan } = require('../server/services/presentations/presentation-design-compiler');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');

test('整稿检查持久化进度、可恢复查询、隔离账号并识别原稿变化', { skip: !process.env.DATABASE_URL, timeout: 60000 }, async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const { presentation: content } = await compileDesignPlan({ title: '后台检查验证', slides: [{ title: '检查目标', layout: 'content', points: ['完整保留正文', '不覆盖后续编辑'] }] }, getBuiltInTemplate('learning-studio'));
    const document = await service.createPresentation(user, { title: content.title, templateId: 'learning-studio', content });
    let task = await tasks.createQualityTask(user, { presentationId: document.id, mode: 'layout' });
    for (let attempt = 0; attempt < 100 && task.status === 'working'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        task = await tasks.getQualityTask(user, document.id, task.id);
    }
    assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(task.result.visualStatus, 'not_requested');
    assert.equal((await tasks.getQualityTask(user, document.id)).id, task.id);
    const other = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING *", ['quality-other-' + crypto.randomBytes(5).toString('hex')]);
    await assert.rejects(() => tasks.getQualityTask(other, document.id, task.id), /无权访问/);
    const updated = globalThis.structuredClone(document.content); updated.slides[0].elements.find(element => element.id === 'body').content.text = '用户后续编辑的正文';
    await service.savePresentationContent(user, document.id, { baseVersion: document.version, title: document.title, content: updated, autoSave: true });
    assert.equal((await tasks.getQualityTask(user, document.id, task.id)).stale, true);
    const notOwner = await tasks.getQualityTask(user, 'missing-document', task.id).catch(error => error);
    assert.match(notOwner.message, /不存在|无权/);
    await execute('DELETE FROM tool_tasks WHERE id=? AND user_id=?', [task.id, user.id]);
});
