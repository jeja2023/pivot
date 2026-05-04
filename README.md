# Pivot (智枢) —— 企业级 AI 智能中枢管理系统

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.0.5-%2310b981)
![授权](https://img.shields.io/badge/%E6%8E%88%E6%9D%83-%E4%BC%81%E4%B8%9A%E7%BA%A7-blue)

**Pivot (智枢)** 是一款专为企业私有化、离线化环境设计的全栈 AI 对话管理平台。它集成了多模型对接、全链路安全加固、资产归属追踪及高性能持久化存储，致力于为企业提供一个安全、稳定且美观的 AI 交互门户。

## 核心特性

### 1. 效率工具集 (Efficiency Suite)
- **指令中心 (Prompt Center)**：内置常用指令模板，支持 AI 角色（System Prompt）一键切换。
- **全局会话搜索**：集成带防抖逻辑的实时搜索，支持按标题、标签及归档状态快速过滤。
- **会话管理进阶**：支持对话置顶（Pin）、归档（Archive）及多标签管理，适配海量会话场景。

### 2. 企业级运营监控 (Ops & Analytics)
- **实时运营面板**：单行展示 8 大核心指标，实时监控系统活跃度与资源消耗。
- **精准用量统计**：多维度分析用户及模型的 Token 使用趋势，支持最后活动时间追踪。
- **模型连通性监测**：可视化模型 API 状态，支持一键探测延迟（ms）并具备并发保护。
- **细粒度访问控制**：支持模型级别的每日额度限制，并可按部门（Unit）分配模型使用权限。

### 3. 极致交互体验
- **流式响应与性能监测**：支持 SSE 流式实时输出，动态显示推理耗时、Token 长度及 TPS。
- **思维链 (Thought) 深度集成**：完美解析模型思考过程（`<thought>` 标签），提升交互透明度。
- **UI/UX 深度优化**：1450px 宽屏管理面板，全系统自定义弹窗，响应式侧边栏布局。

### 4. 安全、存储与灾备
- **全链路审计日志**：完整记录敏感操作、登录轨迹及 IP 地址，满足合规审计需求。
- **资产确权隔离**：上传文件按“用户/会话”路径物理隔离存储，支持图片压缩与文档预处理。
- **自动灾备方案**：内置数据库字段自动迁移逻辑与定时快照备份脚本。

## 部署指南 (离线/容器化)

### 1. 镜像打包 (需联网环境)
```bash
docker build -t pivot:latest .
docker save -o pivot.tar pivot:latest
```

### 2. 离线部署 (目标局域网)
将 `pivot.tar` 和 `docker-compose.yml` 拷贝至目标服务器：
```bash
docker load -i pivot.tar
docker-compose up -d
```

## 快速启动 (开发环境)

1.  **安装依赖**：`npm install`
2.  **配置环境**：复制 `.env.example` 为 `.env` 并配置 `JWT_SECRET`
3.  **启动服务**：`node server/index.js`
4.  **访问系统**：`http://localhost:3000` (默认管理员账号: admin / admin123)

## 目录结构
- `server/`: 后端核心程序 (Express + SQLite)
- `client/`: 前端静态资源 (完全本地化)
- `data/`: 数据库及自动备份存储
- `uploads/`: 用户附件隔离存储

---
**当前版本**: v0.0.5 (Thought UI & Streaming Optimization Update)
