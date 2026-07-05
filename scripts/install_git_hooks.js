/* Git hooks 安装脚本 Git Hooks Installer */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const hooksDir = path.join(rootDir, '.githooks');
const preCommitPath = path.join(hooksDir, 'pre-commit');

function fail(message) {
    console.error(`Git hooks 安装失败：${message}`);
    process.exit(1);
}

if (!fs.existsSync(path.join(rootDir, '.git'))) {
    fail('当前目录不是 Git 仓库。');
}

if (!fs.existsSync(preCommitPath)) {
    fail('缺少 .githooks/pre-commit。');
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: rootDir,
    stdio: 'inherit'
});

console.log('Git hooks 已启用：core.hooksPath = .githooks');
console.log('提交前会运行：node scripts/check_development_standards.js --staged 与 npm run check:text');
