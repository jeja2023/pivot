ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-bookworm
ARG PYTHON_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/python:3.12-slim-bookworm
ARG VERAPDF_VERSION=1.30.3
ARG VERAPDF_RELEASE_SERIES=1.30
# 官方 Greenfield CLI-only 安装包的 SHA-256；更新版本必须同时更新 URL、摘要和回归契约。
ARG VERAPDF_INSTALLER_SHA256=b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59

FROM ${PYTHON_IMAGE} AS python-runtime

# Node 与 CPython 使用相同的 Debian 基线。项目 Python 位于 /usr/local，
# 不替换发行版 /usr/bin/python3，避免影响系统工具。
FROM ${NODE_IMAGE} AS python-base
USER root
COPY --from=python-runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates libbz2-1.0 libexpat1 libffi8 libgdbm6 libgdbm-compat4 liblzma5 \
  libncursesw6 libreadline8 libsqlite3-0 libssl3 libuuid1 zlib1g \
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
  && python3 install_model.py
COPY server/services/speech-recognition/vosk-worker.py /opt/pivot-speech/vosk-worker.py
RUN PIVOT_SERVER_SPEECH_MODE=probe /opt/pivot-speech/venv/bin/python /opt/pivot-speech/vosk-worker.py

FROM python-base AS speech-engine
WORKDIR /tmp/speech-engine
RUN python3 -m venv /opt/pivot-speech/engine-venv
COPY docker/speech-service/requirements.txt docker/speech-service/requirements-cpu.txt ./
COPY artifacts/speech-wheelhouse/ /wheels/
RUN /opt/pivot-speech/engine-venv/bin/pip install --no-index --find-links=/wheels -r requirements.txt -c requirements-cpu.txt \
  && /opt/pivot-speech/engine-venv/bin/pip check \
  && /opt/pivot-speech/engine-venv/bin/python -c "import torch, torchaudio, funasr, silero_vad, uvicorn; assert torch.version.cuda is None; print('embedded speech CPU runtime ready')" \
  && rm -rf /wheels
COPY docker/speech-service/app.py docker/speech-service/engine.py docker/speech-service/embedded_worker.py /opt/pivot-speech/engine/

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ARG TARGETARCH
# 工具库向用户提供 MySQL/MariaDB、SQL Server 与 MongoDB 三类外部数据库连接。
# 标准镜像完整保留它们，发布方可通过 PIVOT_DB_CONNECTORS 显式裁剪不需要的驱动。
ARG PIVOT_DB_CONNECTORS="mysql,mssql,mongodb"

COPY package*.json ./
COPY scripts/prune_runtime_modules.js ./scripts/prune_runtime_modules.js
COPY scripts/prune_optional_database_connectors.js ./scripts/prune_optional_database_connectors.js
ENV npm_config_registry=https://registry.npmmirror.com \
  npm_config_ignore_scripts=true

RUN echo "registry=https://registry.npmmirror.com" > .npmrc && \
  npm config set fetch-retries 5 && \
  npm config set fetch-retry-mintimeout 20000 && \
  npm config set fetch-retry-maxtimeout 120000 && \
  npm ci --omit=dev --ignore-scripts && \
  node -e "require('@duckdb/node-api')" && \
  node -e "require('@duckdb/node-api'); require('unzipper'); require('sharp'); require('docx'); require('@pdf-lib/fontkit'); console.log('[build] 生产运行依赖校验通过')" && \
  node scripts/prune_runtime_modules.js --node-modules /app/node_modules && \
  node scripts/prune_optional_database_connectors.js --node-modules /app/node_modules --connectors "$PIVOT_DB_CONNECTORS" && \
  rm .npmrc && npm cache clean --force

FROM python-base AS runtime
WORKDIR /app

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
  PIVOT_VOICE_PROVIDER=embedded \
  PIVOT_EMBEDDED_VOICE_PYTHON=/opt/pivot-speech/engine-venv/bin/python \
  PIVOT_EMBEDDED_VOICE_WORKER=/opt/pivot-speech/engine/embedded_worker.py \
  PIVOT_EMBEDDED_VOICE_MODEL_ROOT=/models \
  PYTHON=python3

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=verapdf --chown=node:node /opt/verapdf /opt/verapdf
COPY --from=speech-recognition --chown=node:node /opt/pivot-speech /opt/pivot-speech
COPY --from=speech-engine --chown=node:node /opt/pivot-speech /opt/pivot-speech
COPY --chown=node:node server ./server
COPY --chown=node:node client ./client
COPY --chown=node:node scripts/build_chat_css.js ./scripts/build_chat_css.js
COPY --chown=node:node assets ./assets
COPY --chown=node:node docs/licenses ./licenses
COPY --chown=node:node scripts/download_model.js ./scripts/download_model.js
COPY --chown=node:node scripts/repair_chat_schema.js ./scripts/repair_chat_schema.js
COPY --chown=node:node package.json package-lock.json CHANGELOG.md 使用帮助.md ./

# 在最终运行阶段重新加载原生模块和系统工具，避免只验证构建阶段而漏掉 runtime 层缺失。
RUN node scripts/build_chat_css.js && \
  node -e "require('@duckdb/node-api'); require('sharp'); require('unzipper'); require('better-sqlite3'); require('docx'); require('@pdf-lib/fontkit'); console.log('[runtime] 原生模块加载通过')" && \
  python3 --version && \
  python3 -c "import sys; assert sys.version_info[:2] == (3, 12), sys.version" && \
  /opt/pivot-speech/venv/bin/python -c "import sys, vosk; assert sys.version_info[:2] == (3, 12), sys.version" && \
  /opt/pivot-speech/engine-venv/bin/python -c "import torch, torchaudio, funasr, silero_vad; assert torch.version.cuda is None" && \
  qpdf --version && \
  java -version && \
  /opt/verapdf/verapdf --version && \
  pg_dump --version

# 预建默认持久化目录。宿主机 bind mount 也必须允许 UID/GID 1000 写入。
RUN mkdir -p /app/data /app/uploads /app/downloads /app/logs && \
  chown -R node:node /app/data /app/uploads /app/downloads /app/logs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
