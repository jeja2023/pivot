# Pivot Docker 部署快速指南

v0.7.169 修复任务详情及工作流编排界面；更新主应用并刷新页面，详见[v0.7.169发布说明](releases/v0.7.169-任务详情与工作流编排体验修复.md)。从 v0.7.167 或更早版本升级还须处理 [v0.7.168 PPT 与技能修复](releases/v0.7.168-PPT制作恢复与技能治理修复.md)：PPT 文件分页和文字校准需重建独立服务镜像，升级前保留数据库、CAS、技能包及 PPT 工作区，处理在途任务并核对引擎身份。源码升级未构建或部署新制品。

v0.7.167 优化 PPT Master 制作确认与预算展示，并支持工作流结果按需下载 CSV 或 Excel。更新主应用服务端、网页资源及编译样式并刷新页面；从 v0.7.166 升级无新增迁移。本次未构建或部署新镜像与安装包，范围及验收限制见[v0.7.167发布说明](releases/v0.7.167-PPT制作确认与工作流结果下载.md)。

v0.7.166 修复技能签名、撤权、验证接口和多版本发布一致性。更新主应用并刷新页面，保留数据库及技能包目录；从 v0.7.165 升级无新增迁移。历史仅签署清单的团队或组织技能需管理员重新批准签名后使用。源码升版未构建或部署新镜像与安装包，详见[v0.7.166发布说明](releases/v0.7.166-技能签名撤权与发布一致性修复.md)。

v0.7.165 汇总智能路由/SVG误拒答、超时诊断、专用意图模型，以及助手HTTP直连和下载入口。更新主应用并刷新页面；环境配置变更后重新创建容器；从已有v0.7.164助手基础升级无新增迁移。下载功能还须将安装包及 `latest.json` 同步到持久化的 `downloads/local-helper/`。现有HTTP兼容助手包仍为v0.7.164开发验证包，本次未构建或部署v0.7.165镜像与安装包；升级与验证边界见[v0.7.165发布说明](releases/v0.7.165-智能路由与助手HTTP下载体验优化.md)。

v0.7.164 增加浏览器独立本机助手入口。主应用升级时须完成 `202611160001_web_local_helper` 迁移并刷新页面，助手安装在用户的 Windows 电脑上，不能用服务器代替执行。后续助手兼容远程 HTTP 直连，需在本机确认具体地址及明文传输；已有配对接口不需新增迁移或改变 HTTP 站点，见[HTTP兼容记录](reports/windows-local-helper-http-20261116.md)。正式助手包需在发布环境签名构建，详见[v0.7.164发布说明](releases/v0.7.164-Windows独立助手与浏览器本机控制.md)和[安装说明](deployment/Windows独立本机助手.md)。本次未构建或部署 v0.7.164 主镜像。

v0.7.162 的 PPT Master 表单、上下文和预算优化需更新 Pivot 主应用镜像并刷新页面；模型窗口和输入输出上限按目标环境实际配置核对，旧任务预算不会自动提高。独立 PPT Master 服务无需因本次优化重建；范围及未完成验收见[v0.7.162发布说明](releases/v0.7.162-PPTMaster预算与制作体验优化.md)。

v0.7.161 修复桌面客户端菜单初始化，需重建并部署 Pivot 主应用镜像，再刷新客户端页面；不需要新增桌面 IPC 或数据库迁移。实际生产客户端点击仍需部署后验证，详见[v0.7.161发布说明](releases/v0.7.161-桌面菜单修复与本地PPT服务验证.md)。

v0.7.160 优化 PPT Master 完整演示制作弹窗与模板库前端体验，需重建并部署主应用镜像、刷新客户端页面；独立 PPT Master 服务继续使用 v0.7.159 修复后的镜像（已核验导出的 `ppt-master:6.8.0` 离线包仍适用，未升级的旧环境需按[PPT Master服务更新方法](deployment/PPTMaster独立服务部署与更新.md)替换）。详情见[v0.7.160发布说明](releases/v0.7.160-PPTMaster制作弹窗与模板页深度优化.md)。

v0.7.159 更新监控发起用户与时间明细、PPT Master配置状态和数据分析参数布局，需重建并部署主应用镜像、刷新页面。PPT Master模板校验问题另需使用修复后的适配代码重建其独立服务镜像；仅更新主应用或重启旧服务不能修复模板工作区校验。升级后新建制作任务，保留原有配置和数据卷，详见[v0.7.159发布说明](releases/v0.7.159-PPT模板校验监控明细与数据分析布局优化.md)与[PPT Master服务更新方法](deployment/PPTMaster独立服务部署与更新.md)。

v0.7.147 增加个人项目表迁移 `202611100001_agent_projects`，并汇总智能体协议、视觉核验和技能资源改造。升级需保留 PostgreSQL、CAS 与技能包目录；技能包默认位于 `DATA_DIR/agent-skills`，已自定义 `AGENT_SKILL_ROOT` 的部署继续保留原挂载。模型网关协议选择、迁移顺序及验收范围见[v0.7.147升级说明](releases/v0.7.147-智能体协议视觉核验与项目技能资源升级.md)。本次源码版本更新不会改写已有镜像、tar或桌面安装包。

v0.7.144 已统一默认主镜像的 SQLite 下载来源、veraPDF 探测与 Git/ripgrep 打包方式；版本范围及验证记录见[发布说明](releases/v0.7.144-Docker单镜像完整打包与运行依赖修复.md)。普通构建命令无需新增参数。

## 一、基础部署（不含客户端下载）

### 智能路由等待与模型配置

新版支持在部署目录的 `.env` 中设置 `PIVOT_CHAT_INTENT_MODEL_ID`，填入“模型管理”中实际配置的低延迟模型 ID；默认 `0` 表示沿用用户当前模型。专用模型须对使用者可见、凭据有效且输入窗口能容纳完整路由上下文，否则仍使用当前模型。它只负责意图判断，回答和任务执行继续使用用户选择的模型，令牌按实际调用模型记账并校验日额度。

`PIVOT_CHAT_INTENT_TIMEOUT_MS` 默认 `30000`，包含上下文、排队和上游调用，支持 `1000`–`120000`。若目标模型需要更长时间，可按实测调整；单纯延长时限不会改善模型吞吐。更新主应用镜像并修改 `.env` 后，执行 `docker compose up -d --force-recreate pivot` 重新创建服务，再刷新页面；仅重启旧容器不会重新导入环境文件。

在系统监控的“24小时决策错误明细”查看新记录的失败阶段、模型排队和上游耗时；历史记录没有分段信息时保持缺失。源码修复与未完成的生产验证见[超时修复记录](reports/chat-intent-timeout-20261116.md)。

```bash
# 1. 构建镜像
docker build -t pivot:latest .

# 2. 启动服务
docker-compose up -d

# 3. 访问系统
# 浏览器打开 http://localhost:3000
```

veraPDF 的启动探测上限为 30 秒，成功结果缓存 60 秒，失败结果仅缓存 5 秒；PDF 工具页的能力查询保留 35 秒等待时间。探测超时会明确提示检查服务器负载并稍后重试；CLI 或 JRE 缺失则提示检查部署配置。更新探测逻辑需要重新构建并交付主应用镜像。

主镜像默认包含 Git、ripgrep 和 `/runner/runner.js` 终端协议入口，仍使用 slim 底座；直接执行上面的 `docker build -t pivot:latest .` 即可全部打包，无需额外构建参数或单独构建终端镜像。构建以非 root 身份自检命令和协议脚本，缺失会直接失败。导出时执行 `docker save -o pivot.tar pivot:latest`，即可将这些运行依赖一并交付。

已启用受控终端的部署可将同一主镜像的完整 ID 或仓库摘要登记为终端执行镜像，命令沿用 `node,/runner/runner.js`；主服务仍默认启动 `server/index.js`，实际终端执行继续由隔离 Worker 承载。镜像信任和授权流程见 [Capability Workers](../docker/capability-workers/README.md)。

## 二、添加客户端下载功能

### 浏览器中文语音

标准主镜像在构建阶段安装 Vosk 离线识别运行库和模型，默认使用 `local`。需要 FunASR 双遍识别时，请部署独立语音网关并准备其模型和依赖。

构建时可通过 `--build-arg NPM_REGISTRY=<受信任的 npm 镜像地址>` 指定依赖源；运行时不从该地址安装依赖。真正离线交付仍需在联网准备机构建并验收镜像，再导入生产环境。

若旧版本构建在下载 `codeload.github.com/WiseLibs/better-sqlite3` 时出现 `ECONNRESET`，请同步更新 `package.json` 和 `package-lock.json` 后重新构建。当前依赖锁定为 npm 已发布的 `better-sqlite3@12.11.1`，安装包可通过 `NPM_REGISTRY` 指定的源下载；Docker 随后使用镜像内 Node 头文件编译 SQLite 绑定并执行内存查询自检。仅修改 registry 或增加重试次数无法替换依赖中写死的 GitHub 下载地址。

此版本没有 Electron 43 预编译包，桌面客户端打包会使用现有源码编译回退，需要目标平台的原生编译工具链；Docker 构建不使用 Electron。

升级时需重新构建镜像并重建容器：

```bash
docker compose build pivot
docker compose up -d --no-deps --force-recreate pivot
```

浏览器需通过安全连接或可信本地地址访问，并允许麦克风。普通局域网 IP 的明文页面通常不具备录音权限，应通过受信的加密反向代理访问。

`PIVOT_SERVER_VOICE_ENABLED=false` 可关闭部署内识别。如显式选择旧 `local` 兼容模式，标准镜像保留的 Vosk Python 和模型分别位于 `/opt/pivot-speech/venv/bin/python`、`/opt/pivot-speech/model`；`PIVOT_SERVER_VOICE_MODEL_PATH` 只用于这条兼容链路，不配置新的三个模型。

中文双遍识别通过独立 `docker-compose.speech.yml` 部署，主服务选择 `gateway` 并配置转写、流式地址及相同的服务密钥。模型通过独立容器只读挂载，详见 [中文语音服务离线部署与验收](deployment/中文语音服务离线部署与验收.md)。

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
