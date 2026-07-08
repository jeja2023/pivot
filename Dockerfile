# 使用国内华为云加速的 Node.js 22 镜像 (Debian 基础)
FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22

# 设置工作目录
WORKDIR /app

# 首先复制 package.json
COPY package*.json ./

# 安装系统级图像处理引擎、Canvas 渲染库、编译工具及时间数据包
RUN apt-get update && apt-get install -y \
    tzdata \
    pkg-config \
    libvips-dev \
    libglib2.0-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 设置容器时区与国内加速环境变量
ARG PIVOT_BUILD_REVISION=
ENV TZ=Asia/Shanghai
ENV PIVOT_BUILD_REVISION=$PIVOT_BUILD_REVISION
ENV npm_config_registry=https://registry.npmmirror.com
ENV PYTHON=python3
ENV SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips
ENV npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV SHARP_USE_GLOBAL_LIBVIPS=false


# 安装生产环境依赖，并确保 DuckDB Linux 原生绑定就位
# 背景：@duckdb/node-bindings-linux-x64 是 optional 依赖，弱网/TLS 抖动时 npm ci 会“静默跳过”
#       下载失败的可选依赖，构建照样成功，直到运行时 require 才崩（MODULE_NOT_FOUND）。
# 策略：仍在镜像源 .npmrc 生效时，require 校验一次；缺失则显式补装该绑定——
#       直接指名安装即为非可选，失败立即报错；--omit=dev 避免误拉 electron 等开发依赖触发二进制下载，
#       --registry 强制走国内镜像源，--no-save 不改 package.json。补装后仍无法加载则让构建当场失败。
#       注意：补装版本号须与 @duckdb/node-api 保持一致，升级 duckdb 时同步更新此处。
RUN echo "registry=https://registry.npmmirror.com" > .npmrc && \
    echo "sharp_binary_host=https://npmmirror.com/mirrors/sharp" >> .npmrc && \
    echo "sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips" >> .npmrc && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm ci --omit=dev && \
    ( node -e "require('@duckdb/node-api')" 2>/dev/null || \
      npm install --no-save --omit=dev --registry=https://registry.npmmirror.com @duckdb/node-bindings-linux-x64@1.5.4-r.1 ) && \
    node -e "require('@duckdb/node-api'); console.log('[build] DuckDB 原生绑定校验通过')" && \
    rm .npmrc

# 只复制生产运行需要的文件，避免安装包、本机配置和开发辅助目录误进镜像
COPY server ./server
COPY client ./client
COPY scripts/download_model.js ./scripts/download_model.js
COPY CHANGELOG.md 使用帮助.md ./

# 关键环节：在 Docker 构建阶段执行预下载模型脚本
# [RAG 功能] 如果需要离线使用本地 Embedding，请取消下面一行的注释。
# 注意：这会显著增加镜像体积并延长构建时间。
# RUN node scripts/download_model.js

# 暴露端口
EXPOSE 3000

# 容器健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# 启动服务
CMD ["node", "server/index.js"]
