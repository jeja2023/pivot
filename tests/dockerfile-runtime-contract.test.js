const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

test('Dockerfile selects DuckDB binding by BuildKit target architecture', () => {
    assert.match(dockerfile, /ARG TARGETARCH/);
    assert.match(dockerfile, /@duckdb\/node-bindings-linux-x64@1\.5\.4-r\.1/);
    assert.match(dockerfile, /@duckdb\/node-bindings-linux-arm64@1\.5\.4-r\.1/);
    assert.match(dockerfile, /不支持的 Docker 目标架构/);
});

test('Dockerfile validates native modules in the final runtime stage', () => {
    const copyIndex = dockerfile.indexOf('COPY --from=dependencies');
    const runtimeCheckIndex = dockerfile.indexOf("[runtime] 原生模块加载通过");
    const userIndex = dockerfile.indexOf('\nUSER node');
    assert.ok(copyIndex >= 0, 'runtime stage must copy production node_modules');
    assert.ok(runtimeCheckIndex > copyIndex, 'runtime smoke check must follow node_modules copy');
    assert.ok(runtimeCheckIndex < userIndex, 'runtime smoke check must run before dropping privileges');
    assert.match(dockerfile, /python3 --version/);
    assert.match(dockerfile, /pg_dump --version/);
});
