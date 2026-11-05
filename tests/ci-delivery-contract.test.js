const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

test('CI 同时覆盖 Node 20、Node 22、Docker 基础阶段构建和 Windows 桌面冒烟包', () => {
    assert.match(ci, /node-version:\s*\['20', '22'\]/);
    assert.match(ci, /container-build:/);
    assert.match(ci, /docker build --pull --target runtime-base -t pivot:ci/);
    assert.match(ci, /if docker build --pull=false -t pivot:ci-production \. > font-check\.log 2>&1; then/);
    assert.match(ci, /grep -F '公文字体包校验失败：缺少' font-check\.log/);
    assert.match(ci, /desktop-windows:/);
    assert.match(ci, /npm run pack:win/);
});

test('生产主 Compose 直接启用 GPU，无需额外覆盖文件', () => {
    assert.match(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(compose, /NVIDIA_DRIVER_CAPABILITIES:\s*compute,utility/);
});
