const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

test('CI 覆盖最低 Node 版本、Node 24、Docker 基础阶段和 Windows 桌面冒烟包', () => {
    assert.match(ci, /node-version:\s*\['20\.19\.0', '22\.23\.4', '24'\]/);
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
    assert.match(compose, /stop_grace_period:\s*20s/);
});

test('声明的各运行系列最低版本满足锁定直接依赖的 Node 要求', () => {
    const semver=require('semver');
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
    assert.equal(lock.packages[''].engines.node,pkg.engines.node);
    assert.equal(semver.satisfies('20.9.0',pkg.engines.node),false);
    for(const version of ['20.19.0','22.23.4','24.0.0']){
        assert.ok(semver.satisfies(version,pkg.engines.node));
        for(const name of Object.keys(pkg.dependencies)){
            const required=lock.packages['node_modules/'+name]?.engines?.node;
            if(required)assert.ok(semver.satisfies(version,required),`${name} 要求 ${required}，声明最低版本 ${version} 不兼容`);
        }
    }
});
