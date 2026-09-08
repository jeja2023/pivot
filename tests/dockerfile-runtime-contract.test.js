const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

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

test('Docker production dependencies remove verified non-runtime type and browser-only packages', () => {
    assert.match(dockerfile, /COPY scripts\/prune_runtime_modules\.js \.\/scripts\/prune_runtime_modules\.js/);
    assert.match(dockerfile, /node scripts\/prune_runtime_modules\.js --node-modules \/app\/node_modules/);
});

test('Docker image removes optional database connector closures unless selected at build time', () => {
    assert.match(dockerfile, /ARG PIVOT_DB_CONNECTORS=""/);
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
});

test('Docker image ships a Chromium runtime for agent.browser instead of silently hiding it', () => {
    assert.match(dockerfile, /chromium/);
    assert.match(dockerfile, /PIVOT_CHROMIUM_PATH=\/usr\/bin\/chromium/);
});
