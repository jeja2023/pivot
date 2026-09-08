const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const confirmed = process.argv.includes('--yes');
const artifactsRoot = path.join(root, 'artifacts');

function bytesOf(target) {
    try {
        const stat = fs.lstatSync(target);
        if (!stat.isDirectory()) return stat.size;
        return fs.readdirSync(target, { withFileTypes: true })
            .reduce((total, entry) => total + bytesOf(path.join(target, entry.name)), 0);
    } catch (_) {
        return 0;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let index = -1;
    do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function collectTargets() {
    const targets = ['.codex-tmp', '.tmp']
        .map(name => path.join(root, name))
        .filter(target => fs.existsSync(target));
    if (fs.existsSync(artifactsRoot)) {
        for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
            if (!/^(?:data-cleaning-test-|data-analysis-test-|.+-test-|server-.+\.log$)/.test(entry.name)) continue;
            targets.push(path.join(artifactsRoot, entry.name));
        }
    }
    return targets;
}

function isSafeTarget(target) {
    const resolved = path.resolve(target);
    if (resolved === path.join(root, '.codex-tmp') || resolved === path.join(root, '.tmp')) return true;
    return path.dirname(resolved) === artifactsRoot
        && /^(?:data-cleaning-test-|data-analysis-test-|.+-test-|server-.+\.log$)/.test(path.basename(resolved));
}

function main() {
    const targets = collectTargets();
    const total = targets.reduce((sum, target) => sum + bytesOf(target), 0);
    if (!targets.length) {
        console.log('工作区清理：没有可清理的临时产物。');
        return;
    }
    console.log(`工作区清理${confirmed ? '将执行' : '预览'}：${targets.length} 个目标，约 ${formatBytes(total)}。`);
    targets.forEach(target => console.log(` - ${path.relative(root, target)}`));
    console.log('受保护构建输入：artifacts/agent-browser-pack、artifacts/agent-python-pack、artifacts/release 不会被删除。');
    if (!confirmed) {
        console.log('确认删除请运行：npm run clean:workspace -- --yes');
        return;
    }
    for (const target of targets) {
        if (!isSafeTarget(target)) throw new Error(`拒绝清理未验证路径：${target}`);
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
    console.log(`工作区清理完成，已释放约 ${formatBytes(total)}。`);
}

if (require.main === module) main();

module.exports = { collectTargets, isSafeTarget };
