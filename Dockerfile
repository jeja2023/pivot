ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ARG TARGETARCH

# 构建阶段保留编译工具；这些工具不会进入最终运行镜像。
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ pkg-config \
  libvips-dev libglib2.0-dev libcairo2-dev libpango1.0-dev \
  libjpeg-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
ENV npm_config_registry=https://registry.npmmirror.com \
  PYTHON=python3 \
  SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips \
  npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips \
  SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
  SHARP_USE_GLOBAL_LIBVIPS=false

RUN echo "registry=https://registry.npmmirror.com" > .npmrc && \
  echo "sharp_binary_host=https://npmmirror.com/mirrors/sharp" >> .npmrc && \
  echo "sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips" >> .npmrc && \
  npm config set fetch-retries 5 && \
  npm config set fetch-retry-mintimeout 20000 && \
  npm config set fetch-retry-maxtimeout 120000 && \
  npm ci --omit=dev && \
  (node -e "require('@duckdb/node-api')" 2>/dev/null || \
  case "${TARGETARCH:-}" in \
    amd64) echo "[build] 补装 DuckDB 原生绑定：linux-x64" && \
      npm install --no-save --omit=dev --registry=https://registry.npmmirror.com @duckdb/node-bindings-linux-x64@1.5.4-r.1 ;; \
    arm64) echo "[build] 补装 DuckDB 原生绑定：linux-arm64" && \
      npm install --no-save --omit=dev --registry=https://registry.npmmirror.com @duckdb/node-bindings-linux-arm64@1.5.4-r.1 ;; \
    *) echo "不支持的 Docker 目标架构：${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac) && \
  node -e "require('@duckdb/node-api'); require('unzipper'); require('sharp'); console.log('[build] 生产运行依赖校验通过')" && \
  rm .npmrc && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# 运行镜像只安装运行期组件和 pg_dump，不携带编译器及开发头文件。
RUN apt-get update && apt-get install -y --no-install-recommends \
  tzdata postgresql-common ca-certificates python3 \
  && yes "" | /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*

ARG PIVOT_BUILD_REVISION=
ENV NODE_ENV=production \
  TZ=Asia/Shanghai \
  PIVOT_BUILD_REVISION=${PIVOT_BUILD_REVISION} \
  PYTHON=python3 \
  SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
  SHARP_USE_GLOBAL_LIBVIPS=false

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server ./server
COPY --chown=node:node client ./client
COPY --chown=node:node scripts/download_model.js ./scripts/download_model.js
COPY --chown=node:node package.json package-lock.json CHANGELOG.md 使用帮助.md ./

# 在最终运行阶段重新加载原生模块和系统工具，避免只验证构建阶段而漏掉 runtime 层缺失。
RUN node -e "require('@duckdb/node-api'); require('sharp'); require('unzipper'); require('better-sqlite3'); console.log('[runtime] 原生模块加载通过')" && \
  python3 --version && \
  pg_dump --version

# 预建默认持久化目录。宿主机 bind mount 也必须允许 UID/GID 1000 写入。
RUN mkdir -p /app/data /app/uploads /app/downloads /app/logs && \
  chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
