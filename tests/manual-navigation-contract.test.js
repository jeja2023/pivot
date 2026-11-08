'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describesRemovedTaskWorkspace } = require('../scripts/lib/manual-navigation-contract');
test('旧任务运行入口、工作区和标题仍被导航门禁拒绝', () => {
    for (const value of ['打开“任务运行”查看结果', '进入任务运行工作区', '点击任务运行页面', '### 任务运行', '使用 **任务运行** 入口', '旧任务运行入口']) assert.equal(describesRemovedTaskWorkspace(value), true, value);
});
test('制作任务的正常运行状态说明不会被误判为旧入口', () => {
    for (const value of ['已有完整制作或原稿任务运行/等待确认时，先结束任务再切换配置。', '任务运行时请等待完成。', '显示“任务运行中”状态', '查看当前运行记录']) assert.equal(describesRemovedTaskWorkspace(value), false, value);
});
