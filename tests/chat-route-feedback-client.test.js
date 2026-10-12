'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../client/chat/engine-streaming.js'), 'utf8');
const settingsShell = fs.readFileSync(path.join(__dirname, '../client/chat/partials/settings/shell-start.html'), 'utf8');
const reviewQueueSource = fs.readFileSync(path.join(__dirname, '../client/chat/decision-feedback-review.js'), 'utf8');

test('路由建议以对话内选择面板提交，需显式选择替代路径，且不依赖原生 prompt 或用户输入内部动作 ID', () => {
    assert.match(source, /function showRouteFeedbackForm\(/);
    assert.match(source, /chat-route-feedback-form/);
    assert.match(source, /routeFeedbackActionLabel/);
    assert.match(source, /请选择建议路由/);
    assert.match(source, /ROUTE_FEEDBACK_REASON_LABELS/);
    assert.match(source, /不会重跑或改变本次对话/);
    assert.match(source, /decision-feedback/);
    assert.doesNotMatch(source, /window\.prompt\(`请输入“序号:动作ID”提交路由修正/);
});

test('路由反馈核验菜单沿用侧边栏标签样式，不继承次级操作按钮外观', () => {
    assert.match(settingsShell, /id="tab-route-feedback"[^>]*class="admin-tab admin-only hidden"/);
    assert.match(settingsShell, /id="tab-route-feedback"[^>]*>反馈核验<\/button>/);
    assert.doesNotMatch(settingsShell, /id="tab-route-feedback"[^>]*btn-secondary/);
});

test('路由反馈核验队列使用统计路由前缀，避免请求不存在的 observability 根路径', () => {
    assert.match(reviewQueueSource, /\$\{API_BASE\}\/stats\/observability\/decision-feedback/);
    assert.doesNotMatch(reviewQueueSource, /\$\{API_BASE\}\/observability\/decision-feedback/);
});

const reviewHtml = fs.readFileSync(path.join(__dirname, '../client/chat/partials/settings/route-feedback.html'), 'utf8');
const adminLayoutCss = fs.readFileSync(path.join(__dirname, '../client/chat/styles/admin/admin-layout.css'), 'utf8');

test('路由反馈核验表格采用全局统一 compact-table 紧凑表格与标准分页布局，提供序号列且无多余提示', () => {
    assert.match(reviewHtml, /class="data-table compact-table route-feedback-table"/);
    assert.match(reviewHtml, /<th[^>]*class="[^"]*col-index[^"]*"[^>]*>序号<\/th>/);
    assert.doesNotMatch(reviewHtml, /route-feedback-review-summary/);
    assert.match(reviewHtml, /id="pagination-route-feedback"\s+class="pagination"/);
    assert.match(reviewQueueSource, /renderWorkspacePagination/);
    assert.match(reviewQueueSource, /pagination-route-feedback/);
    assert.match(reviewQueueSource, /col-index/);
    assert.match(adminLayoutCss, /\.route-feedback-table th,\s*\.route-feedback-table td\s*\{\s*height:\s*38px;/);
    assert.match(adminLayoutCss, /\.route-feedback-table \.col-index/);
    assert.match(reviewQueueSource, /exposeModule(?:\?\.)?\(\s*['"]decision\.feedbackReview['"]/);
    assert.doesNotMatch(reviewQueueSource, /window\.Pivot\.legacy\s*=/);
    assert.doesNotMatch(reviewQueueSource, /window\.showToast/);
    assert.doesNotMatch(reviewQueueSource, /window\.formatDateToCN/);
});


