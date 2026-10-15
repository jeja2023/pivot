@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: Pivot v0.3.0 部署脚本 (Windows)
:: 自动化部署工作流模板库系统

echo =========================================
echo   Pivot v0.3.0 部署脚本
echo   工作流模板库系统
echo =========================================
echo.

:: 检查 Node.js
echo [检查] Node.js 环境...
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] Node.js 未安装
    pause
    exit /b 1
)
echo [成功] Node.js 已安装
node --version

:: 检查 npm
npm --version >nul 2>&1
if errorlevel 1 (
    echo [错误] npm 未安装
    pause
    exit /b 1
)
echo [成功] npm 已安装
npm --version
echo.

:: 确认部署
set /p CONFIRM="确认要部署到当前环境吗？(Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo [取消] 部署已取消
    pause
    exit /b 0
)
echo.

:: 创建备份目录
echo [步骤1/6] 创建备份目录...
if not exist "backups" mkdir backups
echo [成功] 备份目录已创建
echo.

:: 安装依赖
echo [步骤2/6] 检查依赖包...
if not exist "node_modules" (
    echo [信息] 安装依赖包...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo [成功] 依赖包安装完成
) else (
    echo [信息] 依赖包已存在
)
echo.

:: 运行数据库迁移
echo [步骤3/6] 执行数据库迁移...
cd server
call npx knex migrate:latest --knexfile db/knexfile.js
if errorlevel 1 (
    echo [错误] 数据库迁移失败
    cd ..
    pause
    exit /b 1
)
cd ..
echo [成功] 数据库迁移完成
echo.

:: 导入种子数据
echo [步骤4/6] 导入种子数据...
cd server
call npx knex seed:run --knexfile db/knexfile.js
if errorlevel 1 (
    echo [错误] 种子数据导入失败
    cd ..
    pause
    exit /b 1
)
cd ..
echo [成功] 种子数据导入完成
echo.

:: 运行测试
echo [步骤5/6] 运行测试（可选）...
echo [信息] 跳过测试步骤（可手动运行: npm run test:all）
echo.

:: 验证部署
echo [步骤6/6] 验证部署...
echo [信息] 检查必要文件...

set MISSING=0

if not exist "server\db\migrations\agent-workflow-templates.js" (
    echo [错误] 缺少迁移文件
    set MISSING=1
)

if not exist "server\db\seeds\003-workflow-templates.js" (
    echo [错误] 缺少种子数据文件
    set MISSING=1
)

if not exist "server\db\seeds\workflow-templates\01-excel-data-analysis.json" (
    echo [错误] 缺少模板文件
    set MISSING=1
)

if not exist "client\agent\templates.html" (
    echo [错误] 缺少前端页面
    set MISSING=1
)

if !MISSING!==1 (
    echo [错误] 部署验证失败，缺少必要文件
    pause
    exit /b 1
)

echo [成功] 所有必要文件已就位
echo.

:: 生成部署报告
echo =========================================
echo   部署报告
echo =========================================
echo.
echo 部署时间: %date% %time%
echo 部署版本: v0.3.0
echo Node.js:
node --version
echo npm:
npm --version
echo.
echo 内置模板数量:
dir /b server\db\seeds\workflow-templates\*.json 2>nul | find /c ".json"
echo.
echo API 端点: 16 个
echo 前端页面: 2 个
echo.
echo =========================================
echo   部署完成！
echo =========================================
echo.
echo 启动命令:
echo   npm run dev         # 开发环境
echo   npm run start       # 生产环境
echo.
echo 访问地址:
echo   模板商城: http://localhost:3000/client/agent/templates.html
echo   工作台: http://localhost:3000/client/chat/chat.html
echo.
echo =========================================

pause
