ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22

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

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# 运行镜像只安装运行期组件、pg_dump 和 Agent Browser 所需 Chromium，
# 不携带编译器及开发头文件。
RUN apt-get update && apt-get install -y --no-install-recommends \
  tzdata postgresql-common ca-certificates python3 chromium \
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
  PYTHON=python3

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server ./server
COPY --chown=node:node client ./client
COPY --chown=node:node scripts/build_chat_css.js ./scripts/build_chat_css.js
COPY --chown=node:node assets ./assets
COPY --chown=node:node docs/licenses ./licenses
COPY --chown=node:node scripts/download_model.js ./scripts/download_model.js
COPY --chown=node:node package.json package-lock.json CHANGELOG.md 使用帮助.md ./

# 在最终运行阶段重新加载原生模块和系统工具，避免只验证构建阶段而漏掉 runtime 层缺失。
RUN node scripts/build_chat_css.js && \
  node -e "require('@duckdb/node-api'); require('sharp'); require('unzipper'); require('better-sqlite3'); require('docx'); require('@pdf-lib/fontkit'); console.log('[runtime] 原生模块加载通过')" && \
  python3 --version && \
  pg_dump --version

# 预建默认持久化目录。宿主机 bind mount 也必须允许 UID/GID 1000 写入。
RUN mkdir -p /app/data /app/uploads /app/downloads /app/logs && \
  chown -R node:node /app/data /app/uploads /app/downloads /app/logs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
