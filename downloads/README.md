# 客户端下载与自动更新目录

本目录用于存放 Pivot Windows 桌面客户端发布文件。它同时服务两个入口：

- Web 登录页手工下载：`/downloads/Pivot-Setup.exe`
- 桌面客户端自动更新：`/downloads/latest.yml` 以及 `latest.yml` 指向的安装包和 `.blockmap`

## 推荐发布流程

```bash
# 1. 更新版本号和变更日志后打包 Windows 客户端
npm run dist:win

# 2. 脚本会自动复制自动更新所需文件到 downloads/
#    downloads/Pivot Setup <version>.exe
#    downloads/Pivot Setup <version>.exe.blockmap
#    downloads/latest.yml
#    downloads/Pivot-Setup.exe

# 3. Docker/生产环境挂载 downloads 目录后即可通过 Web 服务访问
curl -I http://your-pivot-server:3000/downloads/latest.yml
curl -I http://your-pivot-server:3000/downloads/Pivot-Setup.exe
```

`npm run pack:win` / `--dir` 只生成未打包调试目录，不会写入 `downloads/`。

## 文件说明

- `latest.yml`：Electron 自动更新清单。客户端会先读取它判断是否有新版本。
- `Pivot Setup <version>.exe`：自动更新实际下载的版本化安装包，文件名必须与 `latest.yml` 中的 `path` 保持一致。
- `Pivot Setup <version>.exe.blockmap`：差分更新元数据，由 `electron-builder` 生成。
- `Pivot-Setup.exe`：网页登录页使用的“最新版客户端”下载入口，由打包脚本从版本化安装包复制而来。

安装包、`.blockmap` 和 `latest.yml` 都是发布产物，已通过 `.gitignore` 排除，不应提交到仓库。

## 桌面端配置

无 HTTPS 的离线局域网生产环境，可以在桌面端 `config.json` 中使用：

```json
{
  "mode": "remote",
  "remoteUrl": "http://pivot.example.local:3000/",
  "autoUpdate": {
    "enabled": true,
    "path": "/downloads/",
    "url": "",
    "checkOnStart": true,
    "autoDownload": true,
    "allowPrerelease": false,
    "allowInsecureHttp": true,
    "allowedOrigins": ["http://pivot.example.local:3000"],
    "installOnQuit": true
  }
}
```

当 `autoUpdate.enabled=true` 且 `autoUpdate.url` 为空时，桌面客户端会基于 `remoteUrl + autoUpdate.path` 推导更新源，例如 `http://pivot.example.local:3000/downloads/`。

## 更新源协议要求

有 HTTPS 时优先使用 HTTPS。无互联网、无 HTTPS 证书的离线局域网生产环境可以使用 HTTP，但必须在桌面端配置中同时设置：

- `autoUpdate.allowInsecureHttp=true`
- `autoUpdate.allowedOrigins=["http://固定内网地址:端口"]`

`allowedOrigins` 必须与客户端实际访问的协议、主机和端口一致。未显式开启或白名单不匹配时，普通 HTTP 更新源会被拒绝。

## Docker 部署

推荐通过 volume 挂载主机目录，替换文件即可发布新客户端，无需重建镜像：

```yaml
services:
  pivot:
    volumes:
      - ./downloads:/app/downloads
```

发布新版本后确认容器内能看到文件：

```bash
docker exec pivot ls -lh /app/downloads/
curl -I http://your-pivot-server:3000/downloads/latest.yml
```

## 多版本保留

建议保留最近 2-3 个版本，便于回滚和排查。不要手动改写 `latest.yml` 中的文件名，除非同时保证对应安装包和 `.blockmap` 已存在。