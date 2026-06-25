# 客户端下载目录

本目录用于存放 Pivot 客户端安装包，供用户通过 Web 页面下载。

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 1. 复制客户端到此目录
cp client/Pivot-Setup.exe downloads/

# 2. 启动 Docker 服务（docker-compose.yml 已配置挂载）
docker-compose up -d

# 3. 用户可通过登录页下载客户端
# 访问地址：http://your-server:3000/downloads/Pivot-Setup.exe
```

### 直接运行

```bash
# 1. 复制客户端到此目录
cp client/Pivot-Setup.exe downloads/

# 2. 启动服务
npm start

# 3. 用户可通过登录页下载
```

## 📁 文件说明

- **Pivot-Setup.exe** - Windows 客户端安装包（约 100-150MB）
- 此目录中的 `.exe` 文件不会被提交到 Git（已在 .gitignore 中排除）
- Docker 镜像默认不包含客户端文件，需要通过挂载提供

## 🔧 部署方案对比

| 方案 | 镜像大小 | 更新便利性 | 适用场景 |
|------|---------|-----------|---------|
| **外部挂载** ✅ | ~500MB | ⭐⭐⭐⭐⭐ 热更新 | 生产环境、内网部署 |
| 打包进镜像 | ~650MB | ⭐⭐ 需重新构建 | 离线环境 |
| 外部托管 | ~500MB | ⭐⭐⭐⭐ 独立管理 | 公网部署、CDN |

## 📦 多版本管理

如果需要提供多个版本供用户选择：

```bash
downloads/
├── Pivot-Setup.exe              # 最新版本（或软链接）
├── Pivot-Setup-0.0.160.exe      # v0.0.160
├── Pivot-Setup-0.0.159.exe      # v0.0.159
└── README.txt                   # 版本说明

# 创建软链接指向最新版本
ln -s Pivot-Setup-0.0.160.exe downloads/Pivot-Setup.exe
```

用户访问方式：
- `/downloads/Pivot-Setup.exe` - 自动下载最新版本
- `/downloads/Pivot-Setup-0.0.160.exe` - 下载指定版本

## 🔍 验证部署

```bash
# 检查文件是否存在
ls -lh downloads/

# Docker 环境检查容器内文件
docker exec pivot ls -lh /app/downloads/

# 测试下载链接
curl -I http://localhost:3000/downloads/Pivot-Setup.exe

# 应返回 200 OK 和文件大小信息
```

## ⚠️ 注意事项

1. **文件大小**：客户端安装包较大（100MB+），下载需要一定时间
2. **磁盘空间**：确保主机/容器有足够空间存储
3. **权限**：确保 Docker 容器有读取权限（通常挂载会自动处理）
4. **更新策略**：建议保留最近 2-3 个版本，定期清理旧版本

## 🌐 外部托管方案

如果不想在 Docker 中存放大文件，可以使用外部托管：

### GitHub Releases（推荐）

1. 创建 GitHub Release
2. 上传 `Pivot-Setup.exe`
3. 修改 `client/chat/partials/pre-app-modals.html` 中的链接：
   ```html
   <a href="https://github.com/your-org/pivot/releases/latest/download/Pivot-Setup.exe" ...>
   ```

### 对象存储

1. 上传到阿里云 OSS / 腾讯云 COS / AWS S3
2. 配置公开读取权限或签名 URL
3. 更新登录页链接

## 📚 相关文档

- [Docker客户端下载配置.md](../docs/Docker客户端下载配置.md) - 详细配置说明
- [Docker部署快速指南.md](../docs/Docker部署快速指南.md) - 部署步骤
- [SOLUTION.md](../SOLUTION.md) - 完整解决方案

## 🆘 常见问题

**Q: 用户点击下载显示 404？**
```bash
# 检查文件是否存在
ls downloads/Pivot-Setup.exe

# Docker 环境检查挂载
docker inspect pivot | grep -A 10 Mounts
```

**Q: 下载速度慢？**
- 使用 Nginx 反向代理并配置缓存
- 考虑使用 CDN 加速
- 或使用对象存储（OSS/COS/S3）

**Q: 如何不提供下载？**
- 保持此目录为空即可
- 登录页链接会返回 404（可选择隐藏链接）

**Q: 可以放置其他平台的客户端吗？**
- 可以！macOS (.dmg)、Linux (.AppImage) 都可以
- 需要自行修改前端添加对应的下载链接

