const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
const veraPdfInstall = fs.readFileSync(path.join(__dirname, '..', 'docker', 'verapdf-auto-install.xml'), 'utf8');

test('语音识别深度学习引擎由独立微服务容器承载，主镜像保持轻量化解耦', () => {
    const speechDockerfile = fs.readFileSync(path.join(__dirname, '../docker/speech-service/Dockerfile'), 'utf8');
    const speechCompose = fs.readFileSync(path.join(__dirname, '../docker-compose.speech.yml'), 'utf8');
    // 主镜像不携带笨重的 PyTorch/FunASR，保持轻量级 Web 容器基线
    assert.doesNotMatch(dockerfile, /FROM python-base AS speech-engine/);
    assert.doesNotMatch(dockerfile, /torch/);
    assert.match(dockerfile, /AS speech-recognition/);
    assert.match(dockerfile, /COPY --from=speech-recognition --chown=node:node \/opt\/pivot-speech \/opt\/pivot-speech/);
    assert.match(dockerfile, /PIVOT_VOICE_PROVIDER=local/);
    // 高精度双遍语音识别由专用独立微服务容器提供
    assert.match(speechDockerfile, /requirements\.txt/);
    assert.match(speechDockerfile, /artifacts\/speech-wheelhouse/);
    assert.match(speechCompose, /image:\s*\$\{SPEECH_IMAGE:-speech-service:latest\}/);
    assert.match(speechCompose, /\$\{SPEECH_MODELS_PATH:-\.\/data\/speech-models\}:\/models:ro/);
    assert.match(speechCompose, /8000:8000/);
    assert.doesNotMatch(compose, /8000:8000/);
});

test('项目 Python 基线在主镜像、语音镜像和离线依赖准备中一致，并保留系统解释器', () => {
    const baseline = fs.readFileSync(path.join(__dirname, '..', '.python-version'), 'utf8').trim();
    const speechDockerfile = fs.readFileSync(path.join(__dirname, '../docker/speech-service/Dockerfile'), 'utf8');
    const prepare = fs.readFileSync(path.join(__dirname, '../docker/speech-service/prepare_assets.py'), 'utf8');
    const nodeImage = dockerfile.match(/^ARG NODE_IMAGE=(.+)$/m)?.[1];
    const mainImage = dockerfile.match(/^ARG PYTHON_IMAGE=(.+)$/m)?.[1];
    const speechImage = speechDockerfile.match(/^ARG SPEECH_PYTHON_IMAGE=(.+)$/m)?.[1];
    assert.ok(nodeImage?.endsWith('node:22-bookworm'));
    assert.match(dockerfile, /ARG RUNTIME_NODE_IMAGE=node:22\.23\.4-bookworm-slim/);
    assert.match(dockerfile, /FROM \$\{RUNTIME_NODE_IMAGE\} AS python-base/);
    assert.ok(mainImage?.endsWith(`python:${baseline}-bookworm`));
    assert.ok(speechImage?.endsWith(`python:${baseline}-bookworm`));
    assert.match(dockerfile, /FROM python-base AS speech-recognition/);
    assert.match(dockerfile, /FROM python-base AS runtime-base/);
    assert.match(dockerfile, /PIVOT_AGENT_PYTHON=\/usr\/local\/bin\/python3\.12/);
    assert.match(prepare, /sys\.version_info\[:2\] != \(3, 12\)/);
    assert.doesNotMatch(dockerfile, /ln\s+.*\/usr\/bin\/python/);
});

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

test('SQLite 依赖使用 npm 发布包并保留离线源码编译与查询自检', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const lockfile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const dependency = manifest.dependencies['better-sqlite3'];
    const locked = lockfile.packages['node_modules/better-sqlite3'];
    assert.match(dependency, /^\d+\.\d+\.\d+$/);
    assert.equal(lockfile.packages[''].dependencies['better-sqlite3'], dependency);
    assert.equal(locked.version, dependency);
    assert.equal(locked.resolved, `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${dependency}.tgz`);
    assert.match(locked.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.match(dockerfile, /npm_config_ignore_scripts=false npm_config_build_from_source=true npm_config_nodedir=\/usr\/local npm rebuild better-sqlite3/);
    const installIndex = dockerfile.indexOf('npm ci --omit=dev --ignore-scripts');
    const rebuildIndex = dockerfile.indexOf('npm rebuild better-sqlite3');
    const queryIndex = dockerfile.indexOf("db.prepare('SELECT 1 AS n').get().n!==1");
    assert.ok(rebuildIndex > installIndex);
    assert.ok(queryIndex > rebuildIndex);
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

test('默认主镜像完整打包 Git、ripgrep 和终端协议入口，无需额外构建参数', () => {
    const runtime = dockerfile.split('FROM python-base AS runtime-base')[1].replace(/\\\r?\n/g, ' ');
    assert.match(runtime, /apt-get install -y --no-install-recommends[^\n]*\bgit ripgrep\b/);
    assert.match(runtime, /COPY --chown=node:node docker\/capability-workers\/terminal-runner\/runner\.js \/runner\/runner\.js/);
    assert.match(runtime, /USER node\s+RUN node --version && python3 --version && git --version && rg --version && node --check \/runner\/runner\.js/);
    assert.match(runtime, /CMD \["node", "server\/index\.js"\]/);
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

test('生产主 Compose 内置 GPU 监控驱动能力，不依赖覆盖文件或镜像内安装驱动', () => {
    assert.match(compose, /^\s*gpus:\s*all\s*$/m);
    assert.match(compose, /NVIDIA_VISIBLE_DEVICES:\s*all/);
    assert.match(compose, /NVIDIA_DRIVER_CAPABILITIES:\s*compute,utility/);
});

test('默认生产镜像以实际运行用户强制校验内置公文字体包', () => {
    assert.match(dockerfile, /COPY --chown=node:node scripts\/official_fonts\.js \.\/scripts\/official_fonts\.js/);
    assert.match(dockerfile, /COPY --chown=node:node assets \.\/assets/);
    assert.match(dockerfile, /USER node[\s\S]*FROM runtime-base AS runtime\s+RUN node scripts\/official_fonts\.js check\s*$/);
    assert.equal([...dockerfile.matchAll(/^FROM .+$/gm)].at(-1)[0], 'FROM runtime-base AS runtime');
});
