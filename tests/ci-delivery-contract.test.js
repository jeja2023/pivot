const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const gpuCompose = fs.readFileSync(path.join(root, 'docker-compose.gpu.yml'), 'utf8');

test('CI 同时覆盖 Node 20、Node 22、真实 Docker 构建和 Windows 桌面冒烟包', () => {
    assert.match(ci, /node-version:\s*\['20', '22'\]/);
    assert.match(ci, /container-build:/);
    assert.match(ci, /docker build --pull -t pivot:ci/);
    assert.match(ci, /desktop-windows:/);
    assert.match(ci, /npm run pack:win/);
});

test('默认 Compose 不要求 GPU，GPU 透传必须显式叠加覆盖层', () => {
    assert.doesNotMatch(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(gpuCompose, /^\s*gpus:\s*all\s*$/m);
});
