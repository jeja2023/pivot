const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('会话任务结果文件横向布局与紧凑高度规范验证', () => {
    const renderJs = fs.readFileSync(path.resolve(__dirname, '../client/chat/chat-task-render.js'), 'utf8');
    const cssContent = fs.readFileSync(path.resolve(__dirname, '../client/chat/styles/base/chat-task-execution.css'), 'utf8');

    // 1. 结构验证：图标、标题、格式徽章、元数据与状态同级置于 artifact-info 下
    assert.match(renderJs, /class="chat-task-artifact-info"/);
    assert.match(renderJs, /class="chat-task-artifact-icon"/);
    assert.match(renderJs, /class="chat-task-artifact-title"/);
    assert.match(renderJs, /class="chat-task-artifact-badge"/);
    assert.match(renderJs, /class="chat-task-artifact-meta"/);
    assert.match(renderJs, /class="chat-task-artifact-status"/);

    // 2. 样式验证：artifact-info 采用行内 flex 布局横向排列信息
    assert.match(cssContent, /\.chat-task-artifact-info[^}]*flex-direction:\s*row/);
    assert.match(cssContent, /\.chat-task-artifact-info[^}]*align-items:\s*center/);

    // 3. 紧凑高度验证：条目高度由原先 84px+ 紧凑至 38px
    assert.match(cssContent, /\.chat-task-artifact\s*\{[^}]*min-height:\s*38px/);
});

