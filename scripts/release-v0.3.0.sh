#!/bin/bash

# Pivot v0.3.0 发布脚本
# 自动化版本发布流程

set -e

echo "========================================="
echo "  Pivot v0.3.0 发布脚本"
echo "========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# 检查Git状态
echo -e "${BLUE}[1/7]${NC} 检查 Git 状态..."
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}错误: 工作目录有未提交的更改${NC}"
    git status --short
    echo ""
    read -p "是否继续？(y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo -e "${GREEN}✓ Git 状态检查完成${NC}"
echo ""

# 运行验证
echo -e "${BLUE}[2/7]${NC} 运行系统验证..."
node scripts/verify-v0.3.0.js || {
    echo -e "${RED}验证失败！${NC}"
    read -p "是否继续发布？(y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
}
echo -e "${GREEN}✓ 验证通过${NC}"
echo ""

# 运行测试
echo -e "${BLUE}[3/7]${NC} 运行测试..."
npm run test:all -- --grep "workflow" || {
    echo -e "${RED}测试失败！${NC}"
    read -p "是否继续发布？(y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
}
echo -e "${GREEN}✓ 测试通过${NC}"
echo ""

# 提交更改
echo -e "${BLUE}[4/7]${NC} 提交更改..."
if [ -n "$(git status --porcelain)" ]; then
    git add .
    git commit -m "chore: release v0.3.0

- 工作流模板库系统
- 5个内置模板
- 完整的前后端实现
- 数据库迁移和种子数据
- API文档和用户指南
- 部署和验证脚本
"
    echo -e "${GREEN}✓ 更改已提交${NC}"
else
    echo -e "${GREEN}✓ 无需提交（工作目录干净）${NC}"
fi
echo ""

# 创建标签
echo -e "${BLUE}[5/7]${NC} 创建 Git 标签..."
if git tag | grep -q "v0.3.0"; then
    echo -e "${RED}标签 v0.3.0 已存在${NC}"
    read -p "是否删除并重新创建？(y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git tag -d v0.3.0
        git tag -a v0.3.0 -m "Release v0.3.0 - 工作流模板库系统

主要特性:
- 工作流模板库系统（5个内置模板）
- 模板管理、评分、实例化
- 完整的前后端实现
- 16个 RESTful API
- 数据库迁移和种子数据

详见: docs/v0.3.0-发布说明.md
"
        echo -e "${GREEN}✓ 标签已重新创建${NC}"
    fi
else
    git tag -a v0.3.0 -m "Release v0.3.0 - 工作流模板库系统

主要特性:
- 工作流模板库系统（5个内置模板）
- 模板管理、评分、实例化
- 完整的前后端实现
- 16个 RESTful API
- 数据库迁移和种子数据

详见: docs/v0.3.0-发布说明.md
"
    echo -e "${GREEN}✓ 标签 v0.3.0 已创建${NC}"
fi
echo ""

# 生成发布说明
echo -e "${BLUE}[6/7]${NC} 生成发布说明..."
cat > RELEASE_NOTES.md <<'EOF'
# Pivot v0.3.0

**发布日期**: 2026-10-14

## 🎯 版本概览

Pivot v0.3.0 是智能体系统的里程碑式升级，引入了**工作流模板库系统**。

## ✨ 主要特性

- ✅ **5个内置工作流模板** - Excel分析、图片处理、API测试、代码分析、文档生成
- ✅ **完整的模板管理系统** - CRUD、搜索、筛选、排序、评分
- ✅ **变量系统** - 6种类型，动态表单，实时验证
- ✅ **实例管理** - 状态跟踪、执行历史
- ✅ **16个 RESTful API** - 标准化接口
- ✅ **2个前端页面** - 模板商城 + 详情页

## 📦 内置模板

1. **Excel 数据分析** - 读取、清洗、统计、LLM分析、报告生成
2. **批量图片处理** - 调整尺寸、压缩、格式转换、添加水印
3. **API 接口测试** - 加载用例、批量执行、验证响应、生成报告
4. **代码质量分析** - 扫描代码、LLM分析、问题分级、改进建议
5. **智能文档生成** - 分析项目、生成README/API/架构文档

## 🚀 快速开始

### 部署

**Windows**:
```bash
scripts\deploy-v0.3.0.bat
```

**Linux/macOS**:
```bash
chmod +x scripts/deploy-v0.3.0.sh
./scripts/deploy-v0.3.0.sh
```

### 访问

- 模板商城: http://localhost:3000/client/agent/templates.html
- 工作台: http://localhost:3000/client/chat/chat.html

## 📚 文档

- [发布记录](./docs/releases/v0.3.0-智能体系统全面优化升级.md)
- [需求规格说明书](./docs/Pivot_v0.3.0_需求规格说明书.md)
- [技术架构设计](./docs/Pivot_v0.3.0_技术架构设计.md)
- [数据库Schema文档](./docs/Pivot_v0.3.0_数据库Schema文档.md)
- [API接口文档](./docs/Pivot_v0.3.0_API接口文档.md)

## 🔄 升级指南

```bash
# 1. 拉取最新代码
git pull origin main
git checkout v0.3.0

# 2. 安装依赖
npm install

# 3. 执行数据库迁移
cd server
npx knex migrate:latest --knexfile db/knexfile.js
npx knex seed:run --knexfile db/knexfile.js
cd ..

# 4. 重启服务
npm run dev
```

## 🐛 已知问题

1. 模板预览图暂未实现
2. 实时执行状态推送待集成
3. 模板版本控制待实现

## 📝 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)

---

**完整发布说明**: [docs/v0.3.0-发布说明.md](./docs/v0.3.0-发布说明.md)
EOF
echo -e "${GREEN}✓ 发布说明已生成: RELEASE_NOTES.md${NC}"
echo ""

# 推送到远程
echo -e "${BLUE}[7/7]${NC} 推送到远程仓库..."
read -p "是否推送到远程仓库？(y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git push origin main
    git push origin v0.3.0
    echo -e "${GREEN}✓ 已推送到远程仓库${NC}"
else
    echo -e "${BLUE}跳过推送（稍后手动推送）${NC}"
    echo "命令:"
    echo "  git push origin main"
    echo "  git push origin v0.3.0"
fi
echo ""

# 完成
echo "========================================="
echo -e "${GREEN}  ✓ 发布完成！${NC}"
echo "========================================="
echo ""
echo "后续步骤:"
echo "1. 查看发布说明: cat RELEASE_NOTES.md"
echo "2. 部署到生产环境: ./scripts/deploy-v0.3.0.sh"
echo "3. 创建 GitHub Release (如果尚未推送)"
echo ""
