const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readText(relativePath) {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function writeText(relativePath, text) {
    fs.writeFileSync(path.join(rootDir, relativePath), text, 'utf8');
}

function readJson(relativePath) {
    return JSON.parse(readText(relativePath));
}

function writeJson(relativePath, value) {
    writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getLatestVersionFromChangelog() {
    const changelog = readText('CHANGELOG.md').replace(/^\uFEFF/, '');
    const match = changelog.match(/^##\s*\[?v?(\d+\.\d+\.\d+)\]?\s*-/m);
    if (!match) {
        throw new Error('在 CHANGELOG.md 中未找到最新版本标题');
    }
    return match[1];
}

function syncPackageJson(version) {
    const pkg = readJson('package.json');
    pkg.version = version;
    writeJson('package.json', pkg);
}

function syncPackageLock(version) {
    const lock = readJson('package-lock.json');
    lock.version = version;
    if (lock.packages && lock.packages['']) {
        lock.packages[''].version = version;
    }
    writeJson('package-lock.json', lock);
}

function replaceOrFail(text, pattern, replacement, label) {
    if (!pattern.test(text)) {
        throw new Error(`无法更新 ${label}`);
    }
    return text.replace(pattern, replacement);
}

function syncReadme(version) {
    let readme = readText('README.md');
    readme = replaceOrFail(
        readme,
        /(badge\/%E7%89%88%E6%9C%AC-)(\d+\.\d+\.\d+)(-)/,
        `$1${version}$3`,
        'README version badge'
    );
    readme = replaceOrFail(
        readme,
        /(##\s*[^\r\n]*?)(\d+\.\d+\.\d+)/,
        `$1${version}`,
        'README latest version heading'
    );
    readme = replaceOrFail(
        readme,
        /(\*\*当前版本\*\*：v)(\d+\.\d+\.\d+)/,
        `$1${version}`,
        'README current version footer'
    );
    writeText('README.md', readme);
}

function main() {
    const version = getLatestVersionFromChangelog();
    syncPackageJson(version);
    syncPackageLock(version);
    syncReadme(version);
    console.log(`已根据 CHANGELOG.md 将项目版本同步至 v${version}`);
}

main();
