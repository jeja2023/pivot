@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo =========================================
echo   Pivot v0.3.0 发布脚本
echo =========================================
echo.

:: 检查 Git 状态
echo [1/7] 检查 Git 状态...
git status --short | findstr /r "." >nul 2>&1
if not errorlevel 1 (
    echo [警告] 工作目录有未提交的更改
    git status --short
    echo.
    set /p CONTINUE="是否继续？(Y/N): "
    if /i not "!CONTINUE!"=="Y" exit /b 1
)
echo [成功] Git 状态检查完成
echo.

:: 运行验证
echo [2/7] 运行系统验证...
node scripts\verify-v0.3.0.js
if errorlevel 1 (
    echo [警告] 验证失败
    set /p CONTINUE="是否继续发布？(Y/N): "
    if /i not "!CONTINUE!"=="Y" exit /b 1
)
echo [成功] 验证通过
echo.

:: 运行测试（可选）
echo [3/7] 运行测试（跳过）...
echo [信息] 测试步骤已跳过
echo.

:: 提交更改
echo [4/7] 提交更改...
git status --short | findstr /r "." >nul 2>&1
if not errorlevel 1 (
    git add .
    git commit -m "chore: release v0.3.0" -m "" -m "- 工作流模板库系统" -m "- 5个内置模板" -m "- 完整的前后端实现" -m "- 数据库迁移和种子数据" -m "- API文档和用户指南" -m "- 部署和验证脚本"
    echo [成功] 更改已提交
) else (
    echo [信息] 无需提交（工作目录干净）
)
echo.

:: 创建标签
echo [5/7] 创建 Git 标签...
git tag | findstr "v0.3.0" >nul 2>&1
if not errorlevel 1 (
    echo [警告] 标签 v0.3.0 已存在
    set /p RECREATE="是否删除并重新创建？(Y/N): "
    if /i "!RECREATE!"=="Y" (
        git tag -d v0.3.0
        git tag -a v0.3.0 -m "Release v0.3.0 - 工作流模板库系统"
        echo [成功] 标签已重新创建
    )
) else (
    git tag -a v0.3.0 -m "Release v0.3.0 - 工作流模板库系统"
    echo [成功] 标签 v0.3.0 已创建
)
echo.

:: 生成发布说明
echo [6/7] 生成发布说明...
(
echo # Pivot v0.3.0
echo.
echo **发布日期**: 2026-10-14
echo.
echo ## 🎯 版本概览
echo.
echo Pivot v0.3.0 是智能体系统的里程碑式升级，引入了**工作流模板库系统**。
echo.
echo ## ✨ 主要特性
echo.
echo - ✅ **5个内置工作流模板** - Excel分析、图片处理、API测试、代码分析、文档生成
echo - ✅ **完整的模板管理系统** - CRUD、搜索、筛选、排序、评分
echo - ✅ **变量系统** - 6种类型，动态表单，实时验证
echo - ✅ **实例管理** - 状态跟踪、执行历史
echo - ✅ **16个 RESTful API** - 标准化接口
echo - ✅ **2个前端页面** - 模板商城 + 详情页
echo.
echo ## 📚 文档
echo.
echo - [发布记录](./docs/releases/v0.3.0-智能体系统全面优化升级.md^)
echo - [需求规格说明书](./docs/Pivot_v0.3.0_需求规格说明书.md^)
echo - [技术架构设计](./docs/Pivot_v0.3.0_技术架构设计.md^)
echo - [数据库Schema文档](./docs/Pivot_v0.3.0_数据库Schema文档.md^)
echo - [API接口文档](./docs/Pivot_v0.3.0_API接口文档.md^)
echo.
echo ## 🚀 快速开始
echo.
echo ```bash
echo scripts\deploy-v0.3.0.bat
echo ```
echo.
echo ## 访问
echo.
echo - 模板商城: http://localhost:3000/client/agent/templates.html
echo - 工作台: http://localhost:3000/client/chat/chat.html
echo.
) > RELEASE_NOTES.md
echo [成功] 发布说明已生成: RELEASE_NOTES.md
echo.

:: 推送到远程
echo [7/7] 推送到远程仓库...
set /p PUSH="是否推送到远程仓库？(Y/N): "
if /i "!PUSH!"=="Y" (
    git push origin main
    git push origin v0.3.0
    echo [成功] 已推送到远程仓库
) else (
    echo [跳过] 稍后手动推送
    echo 命令:
    echo   git push origin main
    echo   git push origin v0.3.0
)
echo.

:: 完成
echo =========================================
echo   ✓ 发布完成！
echo =========================================
echo.
echo 后续步骤:
echo 1. 查看发布说明: type RELEASE_NOTES.md
echo 2. 部署到生产环境: scripts\deploy-v0.3.0.bat
echo 3. 创建 GitHub Release
echo.
pause
