const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'artifacts', 'agent-python-pack');

function resolveConfiguredPython() {
    const configured = String(process.env.PIVOT_AGENT_PYTHON || '').trim();
    if (!configured) return '';
    const candidate = path.resolve(configured);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`PIVOT_AGENT_PYTHON 不存在：${candidate}`);
    return candidate;
}

function main() {
    const executable = resolveConfiguredPython();
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    if (process.argv.includes('--dry-run')) {
        console.log(JSON.stringify({ executable: executable || null, outputRoot, bundled: Boolean(executable) }, null, 2));
        return;
    }
    if (!executable) {
        fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({ bundled: false, source: 'host-python' }, null, 2) + '\n');
        console.log('未配置 PIVOT_AGENT_PYTHON，桌面包保留宿主机 Python 回退。');
        return;
    }
    const sourceRoot = path.dirname(executable);
    // The extraResources target itself is the Python root. Keeping the
    // executable at its root makes the resolver work on both Windows and
    // POSIX builds without a second runtime/ nesting level.
    fs.cpSync(sourceRoot, outputRoot, { recursive: true, force: true, dereference: true });
    fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({
        bundled: true,
        source: executable,
        executable: path.relative(outputRoot, path.join(outputRoot, path.basename(executable)))
    }, null, 2) + '\n');
    console.log(`已打包 Python Runtime：${path.relative(root, outputRoot)}`);
}

main();
