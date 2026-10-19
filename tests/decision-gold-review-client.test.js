'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('冻结金标审核工作台使用管理员标签、双人状态与受控提交入口', () => {
    const shell = read('client/chat/partials/settings/shell-start.html');
    const settings = read('client/chat/partials/workspaces/settings.html');
    const evaluation = read('client/chat/partials/settings/evaluation-review.html');
    const models = read('client/chat/partials/settings/models.html');
    const admin = read('client/chat/admin.js');
    const view = read('client/chat/partials/settings/decision-gold-review.html');
    const script = read('client/chat/decision-gold-review.js');
    assert.doesNotMatch(shell, /id="tab-decision-review"/);
    assert.doesNotMatch(settings, /partials\/settings\/decision-review\.html/);
    assert.match(evaluation, /partials\/settings\/decision-gold-review\.html/);
    assert.match(evaluation, /id="decision-review-gold-panel"/);
    assert.match(shell, /id="tab-evaluation-review"[^>]*class="admin-tab admin-only hidden">评测审核/);
    assert.match(settings, /partials\/settings\/evaluation-review\.html/);
    assert.doesNotMatch(models, /decision-gold-review|models-evaluation-tab|评测管理/);
    assert.match(admin, /settings\.quality/);
    assert.match(view, /id="decision-gold-review-list"/);
    assert.match(view, /id="decision-gold-review-import"/);
    assert.match(script, /pending_human_review/);
    assert.match(script, /human_review_conflict/);
    assert.match(script, /两名不同审核员结论一致/);
    assert.match(script, /decision-evaluation-sets/);
    assert.match(script, /decision-review-gold-panel/);
    assert.match(script, /document\.createElement/);
});
