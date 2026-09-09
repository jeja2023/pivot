const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Node 测试运行器支持原生覆盖率参数，且发布脚本配置了最低门槛', () => {
    const root = path.resolve(__dirname, '..');
    const runner = fs.readFileSync(path.join(root, 'scripts', 'run_node_tests.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(runner, /--experimental-test-coverage/);
    assert.match(runner, /PIVOT_NODE_TEST_WORKERS/);
    assert.match(runner, /splitTestGroups/);
    assert.match(runner, /nodeTestOptions\.includes\('--experimental-test-coverage'\)/);
    assert.match(packageJson.scripts['test:coverage'], /--test-coverage-lines=75/);
    assert.match(packageJson.scripts['test:coverage'], /--test-coverage-functions=75/);
    assert.match(packageJson.scripts['test:coverage'], /--test-coverage-branches=60/);
    assert.match(workflow, /Node test coverage threshold/);
});
