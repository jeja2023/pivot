# 基础镜像默认使用 Docker Hub 官方镜像；国内网络构建可通过 --build-arg 覆盖镜像源：
#   --build-arg NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-bookworm
#   --build-arg PYTHON_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/python:3.12-bookworm
ARG NODE_IMAGE=node:22-bookworm
ARG RUNTIME_NODE_IMAGE=node:22.23.4-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-bookworm
ARG VERAPDF_VERSION=1.30.3
ARG VERAPDF_RELEASE_SERIES=1.30
ARG DOCKER_CLI_IMAGE=docker:29.9.3-cli@sha256:b0d99f37f463c88cae2082083f705210296186c06632d22f6952ed43506ae520
# 官方 Greenfield CLI-only 安装包的 SHA-256；更新版本必须同时更新 URL、摘要和回归契约。
ARG VERAPDF_INSTALLER_SHA256=b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59

FROM ${PYTHON_IMAGE} AS python-runtime
FROM ${DOCKER_CLI_IMAGE} AS docker-client

# Node 与 CPython 使用相同的 Debian 基线。项目 Python 位于 /usr/local，
# 不替换发行版 /usr/bin/python3，避免影响系统工具。
FROM ${RUNTIME_NODE_IMAGE} AS python-base
USER root
COPY --from=python-runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates libbz2-1.0 libexpat1 libffi8 libgdbm6 libgdbm-compat4 liblzma5 \
  libncursesw6 libreadline8 libsqlite3-0 libssl3 libuuid1 zlib1g \
  && apt-get dist-upgrade -y \
  && ldconfig \
  && python3 -c "import sys, ssl, sqlite3, ctypes, bz2, lzma, readline, dbm.gnu, uuid; assert sys.version_info[:2] == (3, 12), sys.version" \
  && rm -rf /var/lib/apt/lists/*

FROM ${NODE_IMAGE} AS verapdf
WORKDIR /tmp/verapdf
ARG VERAPDF_VERSION
ARG VERAPDF_RELEASE_SERIES
ARG VERAPDF_INSTALLER_SHA256

# veraPDF 在运行期只需要 JRE。此阶段使用官方无交互安装器，只选择 CLI，
# 下载摘要不匹配、安装失败或 CLI 无法启动均会阻断镜像构建。
COPY docker/verapdf-auto-install.xml /tmp/verapdf-auto-install.xml
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl default-jre-headless unzip \
  && curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://software.verapdf.org/releases/${VERAPDF_RELEASE_SERIES}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip" \
    --output /tmp/verapdf-installer.zip \
  && echo "${VERAPDF_INSTALLER_SHA256}  /tmp/verapdf-installer.zip" | sha256sum -c - \
  && unzip -q /tmp/verapdf-installer.zip -d /tmp/verapdf-installer \
  && java -jar "/tmp/verapdf-installer/verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" /tmp/verapdf-auto-install.xml \
  && test -x /opt/verapdf/verapdf \
  && /opt/verapdf/verapdf --version | grep -F "veraPDF ${VERAPDF_VERSION}" \
  && rm -rf /opt/verapdf/Uninstaller /tmp/verapdf /tmp/verapdf-installer /tmp/verapdf-installer.zip /var/lib/apt/lists/*

FROM python-base AS speech-recognition
USER root
WORKDIR /tmp/speech
RUN python3 -m venv /opt/pivot-speech/venv
COPY docker/speech/requirements.txt docker/speech/install_model.py ./
RUN /opt/pivot-speech/venv/bin/pip install --no-cache-dir -r requirements.txt \
  && python3 install_model.py \
  && find /opt/pivot-speech/venv -type d \( -name "__pycache__" -o -name "tests" -o -name "test" \) -exec rm -rf {} + 2>/dev/null || true
COPY server/services/speech-recognition/vosk-worker.py /opt/pivot-speech/vosk-worker.py
RUN PIVOT_SERVER_SPEECH_MODE=probe /opt/pivot-speech/venv/bin/python /opt/pivot-speech/vosk-worker.py

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ARG TARGETARCH
# 工具库向用户提供 MySQL/MariaDB、SQL Server 与 MongoDB 三类外部数据库连接。
# 标准镜像完整保留它们，发布方可通过 PIVOT_DB_CONNECTORS 显式裁剪不需要的驱动。
ARG PIVOT_DB_CONNECTORS="mysql,mssql,mongodb"
ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY package*.json ./
COPY scripts/prune_runtime_modules.js ./scripts/prune_runtime_modules.js
COPY scripts/prune_optional_database_connectors.js ./scripts/prune_optional_database_connectors.js
ENV npm_config_registry=${NPM_REGISTRY} \
  npm_config_ignore_scripts=true

RUN printf 'registry=%s\n' "$NPM_REGISTRY" > .npmrc && \
  npm config set fetch-retries 5 && \
  npm config set fetch-retry-mintimeout 20000 && \
  npm config set fetch-retry-maxtimeout 120000 && \
  npm ci --omit=dev --ignore-scripts && \
  npm_config_ignore_scripts=false npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild better-sqlite3 && \
  node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS n').get().n!==1)throw Error('SQLite运行自检失败'); db.close()" && \
  node -e "require('@duckdb/node-api')" && \
  node -e "require('@duckdb/node-api'); require('unzipper'); require('sharp'); require('docx'); require('@pdf-lib/fontkit'); console.log('[build] 生产运行依赖校验通过')" && \
  node scripts/prune_runtime_modules.js --node-modules /app/node_modules && \
  node scripts/prune_optional_database_connectors.js --node-modules /app/node_modules --connectors "$PIVOT_DB_CONNECTORS" && \
  rm .npmrc && npm cache clean --force

# 基础阶段供无授权字体的源码 CI 验证运行依赖；正式发布使用最后的 runtime 阶段。
FROM python-base AS runtime-base
WORKDIR /app
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY docker/analysis-controller/docker-cli-LICENSE.txt /app/licenses/DOCKER-CLI-APACHE-2.0.txt

# 运行镜像只安装运行期组件、qpdf、veraPDF JRE、pg_dump 和 Agent Browser 所需 Chromium，
# 不携带编译器及开发头文件。
RUN apt-get update && apt-get install -y --no-install-recommends \
  tzdata postgresql-common ca-certificates default-jre-headless chromium qpdf \
  && yes "" | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*

ARG PIVOT_BUILD_REVISION=
# UV_THREADPOOL_SIZE 必须在进程启动前生效：文件系统操作与 DNS 解析共用 libuv 线程池，
# 默认 4 个线程在文档解析、目录扫描或出站 DNS 变慢时会被占满，届时连纯内存接口都会
# 一起悬停。运行时通过 .env 覆盖同名变量同样有效（docker-compose 的 env_file 会注入）。
ENV NODE_ENV=production \
  TZ=Asia/Shanghai \
  UV_THREADPOOL_SIZE=16 \
  PIVOT_BUILD_REVISION=${PIVOT_BUILD_REVISION} \
  PIVOT_CHROMIUM_PATH=/usr/bin/chromium \
  DOCUMENT_QPDF_PATH=/usr/bin/qpdf \
  DOCUMENT_VERAPDF_PATH=/opt/verapdf/verapdf \
  PIVOT_SERVER_VOICE_PYTHON=/opt/pivot-speech/venv/bin/python \
  PIVOT_SERVER_VOICE_MODEL_PATH=/opt/pivot-speech/model \
  PIVOT_AGENT_PYTHON=/usr/local/bin/python3.12 \
  PIVOT_VOICE_PROVIDER=local \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHON=python3

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=verapdf --chown=node:node /opt/verapdf /opt/verapdf
COPY --from=speech-recognition --chown=node:node /opt/pivot-speech /opt/pivot-speech
COPY --chown=node:node server ./server
COPY --chown=node:node config/ppt-master-engine.json ./config/ppt-master-engine.json
COPY --chown=node:node client ./client
COPY --chown=node:node scripts/build_chat_css.js ./scripts/build_chat_css.js
COPY --chown=node:node scripts/official_fonts.js ./scripts/official_fonts.js
COPY --chown=node:node scripts/preflight_capability_workers.js scripts/preflight_ppt_master.js ./scripts/
COPY scripts/deploy_ppt_master.py /app/ppt-master-deploy/deploy_ppt_master.py
COPY scripts/lib/ppt_release_bundle.py scripts/lib/ppt_release_deploy.py /app/ppt-master-deploy/lib/
COPY --chown=node:node assets ./assets
COPY --chown=node:node docs/licenses ./licenses
COPY --chown=node:node scripts/download_model.js ./scripts/download_model.js
COPY --chown=node:node scripts/repair_chat_schema.js ./scripts/repair_chat_schema.js
COPY --chown=node:node scripts/offline_backup.js ./scripts/offline_backup.js
COPY --chown=node:node scripts/bi_physical_backup.js scripts/bi_security_recovery.js scripts/bi_operations.js ./scripts/
COPY --chown=node:node package.json package-lock.json CHANGELOG.md 使用帮助.md ./

# 在最终运行阶段重新加载原生模块和系统工具，避免只验证构建阶段而漏掉 runtime 层缺失。
RUN node scripts/build_chat_css.js && \
  node -e "require('@duckdb/node-api'); require('sharp'); require('unzipper'); const Database=require('better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS n').get().n!==1)throw Error('SQLite运行自检失败'); db.close(); require('docx'); require('@pdf-lib/fontkit'); console.log('[runtime] 原生模块加载通过')" && \
  python3 --version && \
  python3 -c "import sys; assert sys.version_info[:2] == (3, 12), sys.version" && \
  /opt/pivot-speech/venv/bin/python -c "import sys, vosk; assert sys.version_info[:2] == (3, 12), sys.version" && \
  qpdf --version && \
  java -version && \
  /opt/verapdf/verapdf --version && \
  pg_dump --version && docker --version

# 预建默认持久化目录。宿主机 bind mount 也必须允许 UID/GID 1000 写入。
RUN mkdir -p /app/data /app/uploads /app/downloads /app/logs && \
  chown -R node:node /app/data /app/uploads /app/downloads /app/logs

# 官方 Node 镜像随附的包管理器补丁可能滞后于其独立安全发布。
# 固定支持当前 Node 基线的修补版本，避免运行镜像携带已修复的解包依赖漏洞。
ARG RUNTIME_NPM_VERSION=12.2.2
RUN npm install --global "npm@${RUNTIME_NPM_VERSION}" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org \
  && npm cache clean --force

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]

# 字体已由 assets 复制到镜像内；以实际运行用户校验完整性、原字体名和嵌入权限。
# 缺少授权字体包或摘要不符时，默认生产构建直接失败，不依赖宿主机字体。
FROM runtime-base AS runtime
RUN node scripts/official_fonts.js check
