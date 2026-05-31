/* JavaScript 语法检查脚本 JavaScript Syntax Check Script */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const includeDirs = ['server', 'client', 'scripts', 'tests', 'updater'];
const ignoredDirs = new Set(['node_modules', 'data', 'uploads']);

function collectJsFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name)) collectJsFiles(fullPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
}

const files = includeDirs.flatMap(dir => {
    const fullPath = path.join(rootDir, dir);
    return fs.existsSync(fullPath) ? collectJsFiles(fullPath) : [];
});

console.log('正在检查项目 JavaScript 语法...');

let hasError = false;
files.forEach(filePath => {
    const relativePath = path.relative(rootDir, filePath);
    try {
        const code = fs.readFileSync(filePath, 'utf8');
        new vm.Script(code, { filename: relativePath });
        console.log(`  通过 ${relativePath}`);
    } catch (error) {
        console.error(`  失败 ${relativePath}`);
        console.error(error.message);
        hasError = true;
    }
});

if (hasError) {
    console.error('\n检测到语法错误，请检查上述文件。');
    process.exit(1);
} else {
    console.log(`\n所有文件语法校验通过，共检查 ${files.length} 个 JS 文件。`);
}
