const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronBuilderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');

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

function normalizeBuilderArgs(rawArgs) {
    if (!rawArgs.length) return ['--win', 'nsis'];
    if (rawArgs.includes('--dir')) return ['--win', '--dir'];
    return ['--win', ...rawArgs];
}

ensureElectronInstalled();
run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
run(process.execPath, [electronBuilderCli, ...normalizeBuilderArgs(process.argv.slice(2))]);
