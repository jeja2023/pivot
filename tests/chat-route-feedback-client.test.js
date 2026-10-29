'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../client/chat/engine-streaming.js'), 'utf8');
const settingsShell = fs.readFileSync(path.join(__dirname, '../client/chat/partials/settings/shell-start.html'), 'utf8');
const monitorHtml = fs.readFileSync(path.join(__dirname, '../client/chat/partials/settings/monitor.html'), 'utf8');
const reviewQueueSource = fs.readFileSync(path.join(__dirname, '../client/chat/decision-feedback-review.js'), 'utf8');

test('普通用户通过对话纠正，不再渲染路由建议表单或提交内部动作 ID', () => {
    assert.doesNotMatch(source, /showRouteFeedbackForm|chat-route-feedback-form|提交路由建议|decision_feedback/);
    assert.doesNotMatch(source, /\/decision-feedback/);
    assert.match(source, /function renderAssistantRouteMetadata/);
    assert.match(reviewQueueSource, /'chat.execution': '任务执行与续接'/);
});

test('异常复核并入系统监控的对话质量，不再设置独立侧边栏入口', () => {
    assert.doesNotMatch(settingsShell, /id="tab-decision-review"/);
    assert.doesNotMatch(settingsShell, /id="tab-route-feedback"/);
    assert.match(monitorHtml, /data-quality-section="quality">对话质量<\/button>/);
    assert.match(monitorHtml, /partials\/settings\/route-feedback.html/);
    assert.match(reviewQueueSource, /decision-review-feedback-panel/);
});

test('路由复核队列使用统计路由前缀，避免请求不存在的 observability 根路径', () => {
    assert.match(reviewQueueSource, /\$\{API_BASE\}\/stats\/observability\/decision-feedback/);
    assert.doesNotMatch(reviewQueueSource, /\$\{API_BASE\}\/observability\/decision-feedback/);
});

test('路由复核详情中的提问、补充说明和复核记录不会把模板缩进渲染为前导空白', () => {
    assert.match(reviewQueueSource, /route-feedback-query-card \$\{queryText \? '' : 'text-muted'\}\">\$\{escapeHtml\(queryText/);
    assert.match(reviewQueueSource, /route-feedback-note-card \$\{noteText \? '' : 'text-muted'\}\">\$\{escapeHtml\(noteText/);
    assert.match(reviewQueueSource, /<div class="route-feedback-note-card">\$\{item\.review_status === 'not_required'/);
    assert.doesNotMatch(reviewQueueSource, /route-feedback-query-card \$\{queryText \? '' : 'text-muted'\}\">\s+\$\{escapeHtml\(queryText/);
    assert.doesNotMatch(reviewQueueSource, /route-feedback-note-card \$\{noteText \? '' : 'text-muted'\}\">\s+\$\{escapeHtml\(noteText/);
});

const reviewHtml = fs.readFileSync(path.join(__dirname, '../client/chat/partials/settings/route-feedback.html'), 'utf8');
const adminLayoutCss = fs.readFileSync(path.join(__dirname, '../client/chat/styles/admin/admin-layout.css'), 'utf8');

test('状态下拉框文字靠左显示且列表已复核项不显示被截断的长日期', () => {
    assert.match(adminLayoutCss, /\.route-feedback-filter select\.form-input/);
    assert.match(adminLayoutCss, /text-align:\s*left\s*!important/);
    assert.match(reviewQueueSource, /detailBtn\.title = `已于 \$\{formatTime\(item\.reviewed_at\)\} 完成复核 · 点击查看详情`/);
});

test('路由复核表格采用全局统一 compact-table 紧凑表格与标准分页布局，提供序号列且无多余提示', () => {
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

test('对话质量异常详情弹窗关闭按钮采用全局统一红色边框与字体样式 btn-danger-outline，且头部无重复按钮', () => {
    assert.doesNotMatch(reviewHtml, /route-feedback-detail-close/);
    assert.match(reviewQueueSource, /cancelBtn\.className = 'btn-danger-outline'/);
    assert.match(reviewQueueSource, /closeBtn\.className = 'btn-danger-outline'/);
    assert.match(reviewQueueSource, /cancelBtn\.id = 'route-feedback-detail-close-btn'/);
    assert.match(reviewQueueSource, /closeBtn\.id = 'route-feedback-detail-close-btn'/);
});

test('对话质量异常处理区域数据表格状态列与复核列及其内容靠左对齐', () => {
    assert.match(reviewHtml, /<th>状态<\/th>/);
    assert.doesNotMatch(reviewHtml, /<th[^>]*class="[^"]*text-center[^"]*"[^>]*>状态<\/th>/);
    assert.match(reviewHtml, /<th>复核<\/th>/);
    assert.doesNotMatch(reviewHtml, /<th[^>]*class="[^"]*text-center[^"]*"[^>]*>复核<\/th>/);
    assert.match(adminLayoutCss, /\.route-feedback-table \.col-feedback-status,\s*\.route-feedback-table th:nth-child\(9\)\s*\{\s*width:\s*80px;\s*text-align:\s*left;/);
    assert.match(adminLayoutCss, /\.route-feedback-status-cell\s*\{[^}]*text-align:\s*left;/);
    assert.match(adminLayoutCss, /\.route-feedback-table \.col-feedback-review,\s*\.route-feedback-table th:nth-child\(10\)\s*\{\s*width:\s*200px;\s*text-align:\s*left;/);
    assert.match(adminLayoutCss, /\.route-feedback-actions-cell\s*\{[^}]*text-align:\s*left;/);
    assert.match(reviewQueueSource, /statusCell\.className\s*=\s*'route-feedback-status-cell';/);
    assert.doesNotMatch(reviewQueueSource, /statusCell\.className\s*=\s*'text-center';/);
    assert.match(reviewQueueSource, /actionCell\.className\s*=\s*'route-feedback-actions-cell';/);
    assert.doesNotMatch(reviewQueueSource, /actionCell\.className\s*=\s*'text-center route-feedback-actions-cell';/);
});


