const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronBuilderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const electronBuilderInstallDeps = path.join(root, 'node_modules', 'electron-builder', 'install-app-deps.js');
const projectVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
    console.log(`> ${[command, ...args].join(' ')}`);
    const result = cp.spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false,
        ...options
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const err = new Error(`Command failed with exit code ${result.status}: ${command}`);
        err.status = result.status || 1;
        throw err;
    }
}

function ensureElectronInstalled() {
    try {
        require('electron');
    } catch (err) {
        throw new Error([
            'Electron binary is not installed correctly.',
            'Run: npm rebuild electron',
            err && err.message ? err.message : String(err)
        ].join('\n'));
    }
}

function cleanBuildOutputs() {
    const targets = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('dist-electron'))
        .map(entry => path.join(root, entry.name));

    for (const target of targets) {
        console.log(`> remove ${target}`);
        fs.rmSync(target, { recursive: true, force: true });
    }
}

function normalizeBuilderArgs(rawArgs) {
    const extraArgs = [`-c.extraMetadata.version=${projectVersion}`];
    if (!rawArgs.length) return ['--win', 'nsis', ...extraArgs];
    if (rawArgs.includes('--dir')) return ['--win', '--dir', ...extraArgs];
    return ['--win', ...rawArgs, ...extraArgs];
}

let runError = null;

try {
    ensureElectronInstalled();
    cleanBuildOutputs();
    run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
    run(process.execPath, [electronBuilderInstallDeps]);
    run(process.execPath, [electronBuilderCli, ...normalizeBuilderArgs(process.argv.slice(2))]);
} catch (err) {
    runError = err;
}

if (runError) {
    console.error(runError && runError.stack ? runError.stack : runError);
    process.exit(runError.status || 1);
}
