// 智枢 (Pivot AI) - 桌面端一键打包脚本
const { execSync } = require('child_process');

console.log("==========================================");
console.log("      智枢 (Pivot AI) - 桌面端打包程序");
console.log("==========================================");
console.log();

// 1. 检查并安装项目依赖
console.log("[1/2] 正在检查并安装项目依赖...");
try {
    execSync('npm install', { stdio: 'inherit' });
} catch (err) {
    console.error("[错误] 依赖安装失败，请检查您的网络连接或 Node.js 环境！");
    process.exit(1);
}
console.log();

// 2. 执行编译打包
console.log("[2/2] 正在将项目打包为 Windows 安装包，请稍候...");
try {
    execSync('npm run dist:win', { stdio: 'inherit' });
    console.log();
    console.log("[成功] 智枢安装包已打包成功！");
    console.log("[提示] 安装包位于项目根目录下的 dist-electron-remote 文件夹中。");
} catch (err) {
    console.error("[失败] 打包过程中发生错误，请检查具体的错误提示。");
    process.exit(1);
}

console.log();
console.log("==========================================");
