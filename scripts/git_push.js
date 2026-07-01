// 智枢 (Pivot AI) - GitHub 一键推送脚本
const { execSync } = require('child_process');

console.log("==========================================");
console.log("      智枢 (Pivot AI) - GitHub 推送程序");
console.log("==========================================");
console.log();

// 1. 检查当前 Git 仓库状态
console.log("[1/3] 正在检查本地修改状态...");
try {
    execSync('git status', { stdio: 'inherit' });
} catch (err) {
    console.error("[错误] 无法获取 Git 状态，请确保已安装 Git 并在仓库目录下。");
    process.exit(1);
}
console.log();

// 2. 自动暂存与提交
console.log("[2/3] 正在自动暂存并提交修改...");
try {
    execSync('git add .', { stdio: 'inherit' });
    execSync('git commit -m "更新项目"', { stdio: 'inherit' });
} catch (err) {
    console.log("[提示] 没有检测到新的修改，或已完成提交。");
}
console.log();

// 3. 执行推送
console.log("[3/3] 正在推送至 GitHub 远程仓库...");
try {
    execSync('git push origin main', { stdio: 'inherit' });
    console.log();
    console.log("[成功] 代码已成功推送至 GitHub！");
} catch (err) {
    console.error("[错误] 推送失败，请检查您的网络连接或 GitHub 访问权限。");
    process.exit(1);
}

console.log();
console.log("==========================================");
