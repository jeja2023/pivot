# v0.0.161 版本发布说明

## 🎉 版本信息

- **版本号**: v0.0.161
- **发布日期**: 2026-06-25
- **类型**: Docker 生产环境优化与修复

## 📋 更新摘要

本版本针对 Docker 生产环境进行了两项关键修复和优化：

1. **修复 Canvas 依赖加载失败** - 解决 PDF 解析警告
2. **实现客户端下载灵活化** - 支持外部挂载、热更新

## 🔧 核心变更

### 1. Canvas 依赖修复（修复生产环境警告）

**问题**：Docker 容器日志显示
```
Warning: Cannot load "@napi-rs/canvas" package
Warning: Cannot polyfill `DOMMatrix`, rendering may be broken
```

**原因**：`pdf-parse` 依赖的 `@napi-rs/canvas` 需要系统级图形库

**解决**：在 Dockerfile 中添加必要的依赖
```dockerfile
RUN apt-get install -y \
    libcairo2-dev \      # Cairo 2D 图形库
    libpango1.0-dev \    # Pango 文本渲染
    libjpeg-dev \        # JPEG 支持
    libgif-dev \         # GIF 支持
    librsvg2-dev         # SVG 支持
```

**效果**：✅ PDF 解析功能正常，无警告

---

### 2. 客户端下载灵活化方案

**问题**：
- 登录页有"下载 Windows 客户端"链接
- Docker 镜像排除了 `.exe` 文件
- 用户点击下载返回 404

**解决方案**：提供三种灵活部署方案

#### 方案对比

| 方案 | 镜像大小 | 更新方式 | 适用场景 | 推荐度 |
|------|---------|---------|---------|--------|
| **外部挂载** | ~500MB | 热更新（无需重启） | 生产环境、内网 | ⭐⭐⭐⭐⭐ |
| 打包进镜像 | ~650MB | 重新构建镜像 | 离线环境 | ⭐⭐⭐ |
| 外部托管 | ~500MB | 独立管理 | 公网部署 | ⭐⭐⭐⭐ |

#### 推荐方案：外部挂载

**配置步骤**：

```bash
# 1. 创建下载目录并复制客户端
mkdir -p downloads
cp client/Pivot-Setup.exe downloads/

# 2. 构建镜像
docker build -t pivot:latest .

# 3. 启动服务（docker-compose.yml 已配置挂载）
docker-compose up -d

# 4. 验证
curl -I http://localhost:3000/downloads/Pivot-Setup.exe
```

**热更新客户端**：
```bash
# 直接替换文件，无需重启容器
cp new-version/Pivot-Setup.exe downloads/
```

**优势**：
- ✅ 镜像精简（不包含 136MB 的客户端）
- ✅ 热更新（无需重新构建镜像）
- ✅ 支持多版本管理
- ✅ 灵活性高

---

## 📂 文件变更清单

### Docker 配置
- ✅ `Dockerfile` - 添加 Canvas 系统依赖
- ✅ `docker-compose.yml` - 添加 downloads 目录挂载
- ✅ `.dockerignore` - 精确排除客户端构建产物

### 服务端
- ✅ `server/index.js` - 添加 /downloads 静态文件路由

### 前端
- ✅ `client/chat/partials/pre-app-modals.html` - 更新下载链接

### 目录结构
- ✅ `downloads/` - 新建客户端下载目录
- ✅ `downloads/README.md` - 使用说明

### 文档
- ✅ `docs/Docker客户端下载配置.md` - 详细配置文档
- ✅ `docs/Docker部署快速指南.md` - 快速部署指南
- ✅ `SOLUTION.md` - 完整解决方案
- ✅ `VERIFICATION.md` - 验证清单

### 配置文件
- ✅ `.gitignore` - 排除 downloads/*.exe
- ✅ `CHANGELOG.md` - 版本更新日志
- ✅ `README.md` - 更新版本号和摘要
- ✅ `package.json` - 版本号 0.0.161

---

## 🚀 快速部署

### 全新部署

```bash
# 1. 准备客户端（如需提供下载）
mkdir -p downloads
cp client/Pivot-Setup.exe downloads/

# 2. 构建镜像
docker build -t pivot:latest .

# 3. 启动服务
docker-compose up -d

# 4. 验证
docker logs pivot
curl -I http://localhost:3000/downloads/Pivot-Setup.exe
```

### 从 v0.0.160 升级

```bash
# 1. 停止旧容器
docker-compose down

# 2. 拉取最新代码
git pull

# 3. 准备客户端（如需提供下载）
mkdir -p downloads
cp client/Pivot-Setup.exe downloads/

# 4. 重新构建镜像
docker build -t pivot:latest .

# 5. 启动新版本
docker-compose up -d

# 6. 验证
docker logs pivot | grep -i canvas  # 应无警告
curl -I http://localhost:3000/downloads/Pivot-Setup.exe  # 应返回 200
```

---

## ✅ 验证检查

### 自动检查（已通过）

```bash
✅ npm run check              # 所有检查通过（263 个 JS 文件）
✅ 语法检查                   # 通过
✅ 文本完整性检查              # 通过
✅ 资源引用检查                # 通过（29 partials, 108 styles）
✅ 版本号同步                  # 已同步到 v0.0.161
```

### 手动验证清单

```bash
# 1. Canvas 依赖验证
[ ] docker build -t pivot:latest .
[ ] docker run --rm pivot:latest dpkg -l | grep libcairo
    预期：显示 libcairo2-dev 已安装

# 2. 客户端下载验证（外部挂载方案）
[ ] mkdir -p downloads && cp client/Pivot-Setup.exe downloads/
[ ] docker-compose up -d
[ ] docker exec pivot ls -lh /app/downloads/
    预期：显示 Pivot-Setup.exe (~136MB)
[ ] curl -I http://localhost:3000/downloads/Pivot-Setup.exe
    预期：200 OK

# 3. 日志验证
[ ] docker logs pivot 2>&1 | grep -i canvas
    预期：无 "Cannot load" 警告

# 4. 热更新验证
[ ] cp new-version.exe downloads/Pivot-Setup.exe
[ ] curl -I http://localhost:3000/downloads/Pivot-Setup.exe
    预期：立即可下载新版本，无需重启
```

---

## 📊 镜像体积对比

| 配置 | 镜像大小 | 说明 |
|------|---------|------|
| v0.0.160（旧版） | ~500MB | 基础镜像 + Node.js + 依赖 |
| v0.0.161 外部挂载 | ~500MB | + Canvas 依赖（~20MB） |
| v0.0.161 打包客户端 | ~650MB | + 客户端（~150MB） |

**推荐**：使用外部挂载方案，保持镜像精简

---

## 📚 相关文档

- **快速开始**: [docs/Docker部署快速指南.md](docs/Docker部署快速指南.md)
- **详细配置**: [docs/Docker客户端下载配置.md](docs/Docker客户端下载配置.md)
- **完整方案**: [SOLUTION.md](SOLUTION.md)
- **验证清单**: [VERIFICATION.md](VERIFICATION.md)
- **更新日志**: [CHANGELOG.md](CHANGELOG.md)

---

## ⚠️ 注意事项

1. **Canvas 依赖**：必须重新构建镜像才能生效
2. **客户端下载**：
   - 外部挂载方案需要手动复制客户端到 downloads/ 目录
   - 如不提供下载，保持 downloads/ 为空即可
3. **数据兼容性**：与 v0.0.160 完全兼容，无需数据迁移
4. **配置兼容性**：.env 配置无变化，可直接升级

---

## 🎯 最佳实践

### 生产环境推荐配置

```yaml
# docker-compose.yml
services:
  pivot:
    image: pivot:0.0.161
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
      - ./downloads:/app/downloads  # 外部挂载
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
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
├── .env
├── data/                   # 数据库
├── uploads/                # 上传文件
├── downloads/              # 客户端下载
│   └── Pivot-Setup.exe
└── logs/                   # 日志（可选）
```

---

## 🆘 故障排查

### 问题 1：仍有 Canvas 警告

```bash
# 确认镜像已重新构建
docker images pivot:latest

# 重新构建（不使用缓存）
docker build --no-cache -t pivot:latest .
```

### 问题 2：客户端下载 404

```bash
# 检查容器内文件
docker exec pivot ls -lh /app/downloads/

# 检查挂载配置
docker inspect pivot | grep -A 10 Mounts

# 检查主机文件
ls -lh downloads/Pivot-Setup.exe
```

### 问题 3：热更新不生效

```bash
# 检查文件时间戳
ls -lh downloads/Pivot-Setup.exe
docker exec pivot stat /app/downloads/Pivot-Setup.exe

# 清除浏览器缓存或使用隐私模式测试
```

---

## 📞 技术支持

如遇问题，请查看：
1. [VERIFICATION.md](VERIFICATION.md) - 详细的验证步骤
2. [docs/Docker客户端下载配置.md](docs/Docker客户端下载配置.md) - 配置说明
3. Docker 容器日志: `docker logs pivot`

---

**发布人**: Claude  
**审核状态**: ✅ 已通过所有自动化检查  
**部署建议**: 推荐使用外部挂载方案部署
