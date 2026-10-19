const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
const gpuCompose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.gpu.yml'), 'utf8');
const veraPdfInstall = fs.readFileSync(path.join(__dirname, '..', 'docker', 'verapdf-auto-install.xml'), 'utf8');

test('Docker 镜像构建时安装固定版本离线中文识别，运行时无需下载模型', () => {
    assert.match(dockerfile, /AS speech-recognition/);
    assert.match(dockerfile, /COPY --from=speech-recognition --chown=node:node \/opt\/pivot-speech \/opt\/pivot-speech/);
    assert.match(dockerfile, /PIVOT_SERVER_VOICE_PYTHON=\/opt\/pivot-speech\/venv\/bin\/python/);
    assert.match(dockerfile, /PIVOT_SERVER_VOICE_MODEL_PATH=\/opt\/pivot-speech\/model/);
    const installer = fs.readFileSync(path.join(__dirname, '../docker/speech/install_model.py'), 'utf8');
    assert.match(installer, /3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba/);
    assert.match(installer, /digest\.hexdigest\(\) != MODEL_SHA256/);
    const worker = fs.readFileSync(path.join(__dirname, '../server/services/speech-recognition/vosk-worker.py'), 'utf8');
    assert.doesNotMatch(worker, /urllib|requests|download|open\(.+['"]w/);
    assert.match(worker, /io\.BytesIO/);
    assert.match(worker, /KaldiRecognizer/);
});

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

test('Ubuntu production image packages qpdf and Compose resolves its in-image absolute path', () => {
    assert.match(dockerfile, /chromium qpdf/);
    assert.match(dockerfile, /DOCUMENT_QPDF_PATH=\/usr\/bin\/qpdf/);
    assert.match(dockerfile, /qpdf --version/);
    assert.match(compose, /DOCUMENT_QPDF_PATH:\s*\$\{DOCUMENT_QPDF_PATH:-\/usr\/bin\/qpdf\}/);
});

test('Ubuntu production image packages hash-pinned veraPDF CLI and JRE without GUI or sample plugins', () => {
    assert.match(dockerfile, /ARG VERAPDF_VERSION=1\.30\.3/);
    assert.match(dockerfile, /ARG VERAPDF_INSTALLER_SHA256=b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59/);
    assert.match(dockerfile, /default-jre-headless/);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.match(dockerfile, /COPY --from=verapdf --chown=node:node \/opt\/verapdf \/opt\/verapdf/);
    assert.match(dockerfile, /DOCUMENT_VERAPDF_PATH=\/opt\/verapdf\/verapdf/);
    assert.match(dockerfile, /\/opt\/verapdf\/verapdf --version/);
    assert.match(compose, /DOCUMENT_VERAPDF_PATH:\s*\$\{DOCUMENT_VERAPDF_PATH:-\/opt\/verapdf\/verapdf\}/);
    assert.match(veraPdfInstall, /name="veraPDF CLI" selected="true"/);
    assert.match(veraPdfInstall, /name="veraPDF GUI" selected="false"/);
    assert.match(veraPdfInstall, /name="veraPDF Sample Plugins" selected="false"/);
});

test('默认 Compose 可运行于 CPU 主机，GPU 透传由独立覆盖层启用', () => {
    assert.doesNotMatch(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(gpuCompose, /^\s*gpus:\s*all\s*$/m);
    assert.match(gpuCompose, /NVIDIA_VISIBLE_DEVICES/);
});
