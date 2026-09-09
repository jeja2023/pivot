const fs = require('fs');
const path = require('path');
const { assertRegistryArtifacts } = require('../server/config/env-registry');

const root = path.resolve(__dirname, '..');
const ignored = JSON.parse(fs.readFileSync(path.join(__dirname, 'env_example_ignored.json'), 'utf8'));

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(target, files);
        else if (entry.isFile() && target.endsWith('.js')) files.push(target);
    }
    return files;
}

function collectEnvironmentReferences() {
    const names = new Set();
    for (const file of [...walk(path.join(root, 'server')), ...walk(path.join(root, 'desktop'))]) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(match[1]);
        for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) names.add(match[1]);
    }
    return names;
}

function declaredEnvironmentNames(text) {
    return new Set([...String(text || '').matchAll(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]+)\s*=/gm)].map(match => match[1]));
}

function main() {
    try {
        assertRegistryArtifacts(root);
    } catch (error) {
        console.error(`类型化配置注册表检查失败：${error.message}`);
        process.exit(1);
    }
    const declared = declaredEnvironmentNames(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
    const missing = [...collectEnvironmentReferences()]
        .filter(name => !declared.has(name) && !Object.prototype.hasOwnProperty.call(ignored, name))
        .sort();
    if (missing.length) {
        console.error(`环境变量模板检查失败：${missing.length} 个 server/desktop 变量未声明。`);
        missing.forEach(name => console.error(` - ${name}`));
        process.exit(1);
    }
    console.log(`环境变量模板检查通过：${declared.size} 个声明，${Object.keys(ignored).length} 个运行时自动变量已登记。`);
}

if (require.main === module) main();

module.exports = { collectEnvironmentReferences, declaredEnvironmentNames };
