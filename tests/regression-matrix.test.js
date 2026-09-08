const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('安全回归矩阵列出全部领域的可执行证据并由项目检查器守护', () => {
    const root = path.resolve(__dirname, '..');
    const matrix = fs.readFileSync(path.join(root, 'docs', 'agent-experience', 'security-regression-matrix.md'), 'utf8');
    const checker = fs.readFileSync(path.join(root, 'scripts', 'check_regression_matrix.js'), 'utf8');
    ['Skill', 'Workflow', 'Channel', 'Goals', 'Data', 'Runtime'].forEach(area => {
        assert.match(matrix, new RegExp(`\\| ${area} \\|`));
    });
    assert.match(matrix, /agent-channel-delivery-reliability\.test\.js/);
    assert.match(matrix, /agent-runtime-lifecycle\.test\.js/);
    assert.match(checker, /缺少可执行测试证据/);
});
