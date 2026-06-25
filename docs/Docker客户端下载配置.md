# Docker 部署中提供客户端下载

## 问题说明

默认情况下，Docker 镜像不包含 Windows 客户端安装包（`.exe` 文件），因为：
- 客户端安装包体积很大（100MB+），会显著增加镜像大小
- Docker 通常部署在服务器上，主要用于 Web 访问
- Linux 镜像中包含 Windows 安装包没有意义

但登录页提供了客户端下载链接，如果镜像中没有文件，点击会 404。

## 解决方案

### 方案1：挂载外部目录（**推荐用于生产环境**）

通过 Docker volume 挂载主机上的下载目录，无需重新构建镜像即可更新客户端。

#### 使用 docker run

```bash
# 1. 在主机上创建下载目录
mkdir -p /data/pivot/downloads

# 2. 复制客户端到该目录
cp Pivot-Setup.exe /data/pivot/downloads/

# 3. 启动容器时挂载
docker run -d \
  -p 3000:3000 \
  -v /data/pivot/data:/app/data \
  -v /data/pivot/uploads:/app/uploads \
  -v /data/pivot/downloads:/app/downloads \
  --name pivot \
  pivot:latest
```

#### 使用 docker-compose

创建或修改 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  pivot:
    image: pivot:latest
    container_name: pivot
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
      - ./downloads:/app/downloads  # 挂载下载目录
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
    restart: unless-stopped
```

然后：
```bash
# 1. 创建下载目录
mkdir -p downloads

# 2. 复制客户端
cp Pivot-Setup.exe downloads/

# 3. 启动服务
docker-compose up -d
```

**优点**：
- ✅ 镜像体积小（不包含客户端文件）
- ✅ 更新客户端无需重新构建镜像
- ✅ 可以放置多个版本（如 Pivot-Setup-v0.0.160.exe）
- ✅ 热更新：直接替换文件即可生效

**最佳实践**：
```bash
# 主机目录结构
/data/pivot/
├── data/              # 数据库
├── uploads/           # 上传文件
└── downloads/         # 客户端下载
    ├── Pivot-Setup.exe          # 最新版本
    ├── Pivot-Setup-0.0.160.exe  # 指定版本
    └── README.txt               # 版本说明
```

### 方案2：在镜像中包含客户端

如果需要在镜像中直接包含客户端（适用于离线环境或不方便挂载的场景）：

1. **将客户端文件复制到 downloads 目录**：
   ```bash
   cp client/Pivot-Setup.exe downloads/
   ```

2. **重新构建 Docker 镜像**：
   ```bash
   docker build -t pivot:latest .
   ```

3. **验证文件已包含**：
   ```bash
   docker run --rm pivot:latest ls -lh /app/downloads/
   ```

**注意**：这会增加镜像大小约 100-150MB。

### 方案3：使用外部托管

将客户端放到外部存储，修改登录页链接：

1. **上传到 GitHub Releases**（推荐）：
   - 创建 GitHub Release
   - 上传 `Pivot-Setup.exe`
   - 获取下载链接

2. **或使用 CDN/对象存储**：
   - 上传到阿里云 OSS / 腾讯云 COS / AWS S3
   - 配置公开读取权限
   - 更新链接

3. **修改登录页链接**：
   编辑 `client/chat/partials/pre-app-modals.html` 第 36 行：
   ```html
   <a href="https://github.com/your-org/pivot/releases/latest/download/Pivot-Setup.exe" ...>
   ```

### 方案4：动态隐藏链接

如果不提供客户端下载，可以隐藏下载链接。

编辑 `client/chat/auth.js`，在 `loadAuthConfig()` 后添加：
```javascript
// 检查客户端是否可用
fetch('/downloads/Pivot-Setup.exe', { method: 'HEAD' })
    .then(res => {
        if (!res.ok) {
            document.getElementById('desktop-download-link')?.parentElement?.remove();
        }
    })
    .catch(() => {
        document.getElementById('desktop-download-link')?.parentElement?.remove();
    });
```

## 多版本支持（可选）

如果需要提供多个版本供用户选择，可以：

1. **在 downloads 目录放置多个文件**：
   ```
   downloads/
   ├── Pivot-Setup.exe              # 指向最新版本
   ├── Pivot-Setup-0.0.160.exe
   ├── Pivot-Setup-0.0.159.exe
   └── versions.json
   ```

2. **创建版本列表 API**（需自行实现）：
   ```javascript
   // server/index.js 中添加
   app.get('/api/client-versions', (req, res) => {
       const downloadsDir = path.join(__dirname, '../downloads');
       const files = fs.readdirSync(downloadsDir)
           .filter(f => f.endsWith('.exe'))
           .map(f => ({
               name: f,
               url: `/downloads/${f}`,
               size: fs.statSync(path.join(downloadsDir, f)).size
           }));
       res.json(files);
   });
   ```

## 当前配置

- 下载目录：`/app/downloads`（容器内路径）
- 访问路径：`/downloads/Pivot-Setup.exe`
- 服务端配置：`server/index.js` 已配置静态文件服务
- Docker 镜像默认不包含客户端文件
- 推荐使用 **方案1（挂载外部目录）** 用于生产环境

## 验证

```bash
# 检查容器内文件
docker exec pivot ls -lh /app/downloads/

# 测试下载链接
curl -I http://localhost:3000/downloads/Pivot-Setup.exe

# 查看访问日志
docker logs pivot | grep "downloads"
```
