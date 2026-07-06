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

### 方法 1：外部挂载（推荐）✅

```bash
# 1. 创建下载目录
mkdir -p downloads

# 2. 复制客户端到下载目录
cp client/Pivot-Setup.exe downloads/

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
cp client/Pivot-Setup.exe downloads/

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

### 完整的 docker-compose.yml

```yaml
version: '3.8'

services:
  pivot:
    image: pivot:latest
    container_name: pivot
    ports:
      - "3000:3000"
    
    volumes:
      - ./data:/app/data              # 数据库
      - ./uploads:/app/uploads        # 上传文件
      - ./downloads:/app/downloads    # 客户端下载
      - ./logs:/app/logs              # 日志（可选）
    
    environment:
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
/data/pivot/
├── docker-compose.yml
├── .env                    # 环境变量配置
├── data/                   # 数据库（自动创建）
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

# 检查文件权限
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
- [生产环境离线部署.md](./生产环境离线部署.md) - 离线生产环境镜像导入、模型挂载和升级回滚流程
- [PaddleOCR模型外部挂载.md](./PaddleOCR模型外部挂载.md) - OCR 模型目录挂载与运行时配置
- [Dockerfile](../Dockerfile) - 镜像构建配置
- [docker-compose.yml](../docker-compose.yml) - 编排配置
- [使用帮助.md](../使用帮助.md) - 用户使用手册
