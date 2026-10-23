# Pivot Docker 部署快速指南

## 一、基础部署（不含客户端下载）

```bash
# 1. 构建镜像
docker build -t pivot:latest .

# 2. 启动服务
docker-compose up -d

# 3. 访问系统
# 浏览器打开 http://localhost:3000
```

## 二、添加客户端下载功能

### 浏览器中文语音

标准镜像在构建阶段安装 CPU 中文识别运行库；默认 `embedded` 模式的三个模型通过 `./data/speech-models:/models:ro` 导入，不写入镜像。浏览器无需中文本地包，短录音仅发送当前 Pivot，在容器内存中完成识别；镜像运行阶段无需访问模型下载站点。

升级时需重新构建镜像并重建容器：

```bash
docker compose build pivot
docker compose up -d --no-deps --force-recreate pivot
```

浏览器需通过安全连接或可信本地地址访问，并允许麦克风。普通局域网 IP 的明文页面通常不具备录音权限，应通过受信的加密反向代理访问。

`PIVOT_SERVER_VOICE_ENABLED=false` 可关闭部署内识别。如显式选择旧 `local` 兼容模式，标准镜像保留的 Vosk Python 和模型分别位于 `/opt/pivot-speech/venv/bin/python`、`/opt/pivot-speech/model`；`PIVOT_SERVER_VOICE_MODEL_PATH` 只用于这条兼容链路，不配置新的三个模型。

中文双遍识别默认集成在主容器中，`.env` 使用 `PIVOT_VOICE_PROVIDER=embedded`，无需额外容器或 GPU。SeACo Paraformer、流式 Paraformer 和标点模型放在部署目录的 `./data/speech-models/`，主 Compose 已配置 `./data/speech-models:/models:ro`。主镜像内置 CPU 推理依赖，动态内部端口与凭据由应用管理，无需填写语音 IP、HTTP/WS 端点或共享密钥。开发机的 `artifacts/speech-models/` 是下载准备目录；选择其他内网服务器提供 API 时才使用 `gateway`，可选独立部署文件为 `docker-compose.speech.yml`。详见 [中文语音服务离线部署与验收](deployment/中文语音服务离线部署与验收.md)。

### 方法 1：外部挂载（推荐）✅

```bash
# 1. 创建下载目录
mkdir -p downloads

# 2. 复制客户端到下载目录
cp artifacts/release/Pivot-Setup.exe downloads/

# 3. 启动服务（docker-compose.yml 已配置挂载）
docker-compose up -d

# 4. 验证文件可访问
curl -I http://localhost:3000/downloads/Pivot-Setup.exe
```

**更新客户端**：
```bash
# 直接替换文件即可，无需重启容器
cp new-version/Pivot-Setup.exe downloads/
```

### 方法 2：打包进镜像

```bash
# 1. 复制客户端到 downloads 目录
cp artifacts/release/Pivot-Setup.exe downloads/

# 2. 重新构建镜像
docker build -t pivot:latest .

# 3. 启动服务
docker-compose up -d
```

**注意**：镜像会增加约 150MB，每次更新客户端需要重新构建镜像。

### 方法 3：使用外部链接

修改 `client/chat/partials/pre-app-modals.html` 第 36 行：

```html
<!-- 改为指向 GitHub Releases 或 CDN -->
<a href="https://github.com/your-org/pivot/releases/latest/download/Pivot-Setup.exe" ...>
```

## 三、生产环境部署示例

生产服务器的主 `docker-compose.yml` 已直接启用 NVIDIA GPU 透传，原 `docker-compose.gpu.yml` 已移除。宿主机需安装 NVIDIA 驱动和 NVIDIA Container Toolkit，并使用 Docker Compose 2.30.0+。旧 `.env` 中引用 GPU 覆盖文件的 `COMPOSE_FILE`、仅为此设置的 `COMPOSE_PATH_SEPARATOR`，以及启动命令中对应的 `-f` 参数应删除。

更新配置后执行 `docker compose up -d --no-build --force-recreate pivot` 重建主容器，再用 `docker exec pivot nvidia-smi` 验证；普通 restart 不会更新设备请求。无 GPU 的主机需先从主配置移除 `gpus` 与两项 NVIDIA 环境变量。

### 完整的 docker-compose.yml

```yaml
version: '3.8'

services:
  pivot:
    image: pivot:latest
    container_name: pivot
    gpus: all
    ports:
      - "3000:3000"
    
    volumes:
      - ./data:/app/data              # 数据库
      - ./data/speech-models:/models:ro # 内置 CPU 语音模型
      - ./uploads:/app/uploads        # 上传文件
      - ./downloads:/app/downloads    # 客户端下载
      - ./logs:/app/logs              # 日志（可选）
    
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
      - NODE_ENV=production
      - TZ=Asia/Shanghai
      # - ENABLE_DESKTOP_DOWNLOAD=true  # 如需显式启用
    
    restart: unless-stopped
    
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 目录结构

```
<部署目录>/
├── docker-compose.yml
├── .env                    # 环境变量配置
├── data/                   # 主服务持久化文件
│   └── speech-models/      # 主容器内置 CPU 语音读取的三个模型目录
├── uploads/                # 上传文件（自动创建）
├── downloads/              # 客户端下载
│   ├── Pivot-Setup.exe     # 最新版本
│   └── README.txt          # 版本说明（可选）
└── logs/                   # 日志（可选）
```

### 启动命令

```bash
# 创建必要的目录
mkdir -p data uploads downloads logs
sudo chown -R "${PIVOT_UID:-1000}:${PIVOT_GID:-1000}" data uploads downloads logs

# 复制客户端（如果需要）
cp Pivot-Setup.exe downloads/

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 查看状态
docker-compose ps

# 重启服务
docker-compose restart

# 停止服务
docker-compose down
```

## 四、多版本管理（可选）

如果需要提供多个版本：

```bash
downloads/
├── Pivot-Setup.exe              # 软链接指向最新版本
├── Pivot-Setup-0.0.160.exe      # 版本 0.0.160
├── Pivot-Setup-0.0.159.exe      # 版本 0.0.159
└── versions.txt                 # 版本说明

# 创建软链接
ln -s Pivot-Setup-0.0.160.exe downloads/Pivot-Setup.exe
```

用户访问 `/downloads/Pivot-Setup.exe` 会下载最新版本。
高级用户可以直接访问 `/downloads/Pivot-Setup-0.0.160.exe` 下载特定版本。

## 五、故障排查

### 1. 下载链接 404

```bash
# 检查容器内文件是否存在
docker exec pivot ls -lh /app/downloads/

# 检查挂载是否正确
docker inspect pivot | grep -A 10 Mounts

# 检查文件权限（Pivot 容器默认以 UID/GID 1000 的非 root 用户运行）
ls -lh downloads/
```

### 2. 下载速度慢

客户端文件较大（100MB+），下载速度取决于：
- 服务器带宽
- 用户网络速度
- Nginx 等反向代理配置

建议：
- 使用 CDN 加速
- 配置 Nginx 缓存
- 或使用对象存储（OSS/COS）

### 3. Canvas 相关警告

如果看到 `Cannot load "@napi-rs/canvas"` 警告，确保 Dockerfile 已安装必要的库：

```dockerfile
RUN apt-get install -y \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev
```

## 六、最佳实践

### ✅ 推荐做法

1. **使用外部挂载**：保持镜像精简，方便更新
2. **定期备份**：`data/` 和 `uploads/` 目录
3. **监控日志大小**：配置日志轮转
4. **使用反向代理**：Nginx/Traefik 处理 HTTPS

### ❌ 不推荐做法

1. ~~将客户端打包进镜像~~（除非离线环境）
2. ~~不设置日志限制~~（可能占满磁盘）
3. ~~直接暴露 3000 端口到公网~~（应使用反向代理）

## 七、性能优化

### Nginx 配置示例（处理大文件下载）

```nginx
server {
    listen 80;
    server_name pivot.example.com;
    
    client_max_body_size 200M;  # 允许上传大文件
    
    location /downloads/ {
        proxy_pass http://localhost:3000;
        
        # 大文件下载优化
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_http_version 1.1;
        
        # 超时设置
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 八、参考文档

- [Docker客户端下载配置.md](./Docker客户端下载配置.md) - 详细配置说明
- [生产环境离线部署.md](./生产环境离线部署.md) - 离线生产环境镜像导入、OCR 外部服务对接和升级回滚流程
- [OCR服务对接协议.md](./OCR%E6%9C%8D%E5%8A%A1%E5%AF%B9%E6%8E%A5%E5%8D%8F%E8%AE%AE.md) - 外部 OCR 服务 HTTP 接口约定
- [独立OCR项目搭建指南.md](./独立OCR项目搭建指南.md) - 独立 OCR 项目目录、镜像和 PaddleOCR-VL 选型建议
- [Dockerfile](../Dockerfile) - 镜像构建配置
- [docker-compose.yml](../docker-compose.yml) - 编排配置
- [使用帮助.md](../使用帮助.md) - 用户使用手册
