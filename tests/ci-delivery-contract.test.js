const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

test('CI 同时覆盖 Node 20、Node 22、真实 Docker 构建和 Windows 桌面冒烟包', () => {
    assert.match(ci, /node-version:\s*\['20', '22'\]/);
    assert.match(ci, /container-build:/);
    assert.match(ci, /docker build --pull (?:--build-arg\s+\S+\s+)*-t pivot:ci/);
    assert.match(ci, /desktop-windows:/);
    assert.match(ci, /npm run pack:win/);
});

test('生产主 Compose 直接启用 GPU，无需额外覆盖文件', () => {
    assert.match(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(compose, /NVIDIA_DRIVER_CAPABILITIES:\s*compute,utility/);
});
