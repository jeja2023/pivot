# 使用国内华为云加速的 Node.js 22 镜像 (Debian 基础)
FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22

# 设置工作目录
WORKDIR /app

# 首先复制 package.json
COPY package*.json ./

# 安装系统级图像处理引擎、编译工具及时间数据包
RUN apt-get update && apt-get install -y \
    tzdata \
    pkg-config \
    libvips-dev \
    libglib2.0-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 设置容器时区与国内加速环境变量
ENV TZ=Asia/Shanghai
ENV npm_config_registry=https://registry.npmmirror.com
ENV PYTHON=python3
ENV SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips
ENV npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV SHARP_USE_GLOBAL_LIBVIPS=false

# 安装生产环境依赖
RUN echo "registry=https://registry.npmmirror.com" > .npmrc && \
    echo "sharp_binary_host=https://npmmirror.com/mirrors/sharp" >> .npmrc && \
    echo "sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips" >> .npmrc && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --omit=dev && \
    rm .npmrc

# 将项目源代码及模型下载脚本复制进镜像
COPY . .

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
