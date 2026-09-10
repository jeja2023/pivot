const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
const gpuCompose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.gpu.yml'), 'utf8');

test('Dockerfile relies on lockfile-provided DuckDB native binding and fails closed when absent', () => {
    assert.match(dockerfile, /ARG TARGETARCH/);
    assert.match(dockerfile, /npm ci --omit=dev/);
    assert.match(dockerfile, /node -e "require\('\@duckdb\/node-api'\)"/);
    assert.doesNotMatch(dockerfile, /node-bindings-linux-(?:x64|arm64)@1\.5\.4-r\.1/);
});

test('Docker install uses only lockfile artifacts and carries no obsolete sharp source-build knobs', () => {
    assert.match(dockerfile, /npm_config_ignore_scripts=true/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.doesNotMatch(dockerfile, /SHARP_IGNORE_GLOBAL_LIBVIPS/);
    assert.doesNotMatch(dockerfile, /SHARP_USE_GLOBAL_LIBVIPS/);
    assert.doesNotMatch(dockerfile, /(?:python3\s+make\s+g\+\+|libvips-dev|librsvg2-dev)/);
});

test('Docker image generates split chat CSS bundles before the non-root runtime starts', () => {
    assert.match(dockerfile, /COPY --chown=node:node scripts\/build_chat_css\.js \.\/scripts\/build_chat_css\.js/);
    assert.match(dockerfile, /RUN node scripts\/build_chat_css\.js/);
});

test('Docker production dependencies remove verified non-runtime type and browser-only packages', () => {
    assert.match(dockerfile, /COPY scripts\/prune_runtime_modules\.js \.\/scripts\/prune_runtime_modules\.js/);
    assert.match(dockerfile, /node scripts\/prune_runtime_modules\.js --node-modules \/app\/node_modules/);
});

test('Docker image retains all tool-library database connectors by default while allowing optional connector profiles', () => {
    assert.match(dockerfile, /ARG PIVOT_DB_CONNECTORS="mysql,mssql,mongodb"/);
    assert.match(dockerfile, /COPY scripts\/prune_optional_database_connectors\.js \.\/scripts\/prune_optional_database_connectors\.js/);
    assert.match(dockerfile, /prune_optional_database_connectors\.js --node-modules \/app\/node_modules --connectors "\$PIVOT_DB_CONNECTORS"/);
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

test('Docker image carries required LGPL notice material with runtime dependencies', () => {
    assert.match(dockerfile, /COPY --chown=node:node docs\/licenses \.\/licenses/);
    assert.match(dockerignore, /^!docs\/$/m);
    assert.match(dockerignore, /^!docs\/licenses\/$/m);
    assert.match(dockerignore, /^!docs\/licenses\/\*\*$/m);
});

test('Docker image ships a Chromium runtime for agent.browser instead of silently hiding it', () => {
    assert.match(dockerfile, /chromium/);
    assert.match(dockerfile, /PIVOT_CHROMIUM_PATH=\/usr\/bin\/chromium/);
});

test('默认 Compose 可运行于 CPU 主机，GPU 透传由独立覆盖层启用', () => {
    assert.doesNotMatch(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(gpuCompose, /^\s*gpus:\s*all\s*$/m);
    assert.match(gpuCompose, /NVIDIA_VISIBLE_DEVICES/);
});
