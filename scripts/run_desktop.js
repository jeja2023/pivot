const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
const electronBuilderInstallDeps = path.join(root, 'node_modules', 'electron-builder', 'install-app-deps.js');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function run(command, args) {
    console.log(`> ${[command, ...args].join(' ')}`);
    const result = cp.spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const err = new Error(`Command failed with exit code ${result.status}: ${command}`);
        err.status = result.status || 1;
        throw err;
    }
}

function rebuildForCurrentNode() {
    run(process.execPath, [npmCli, 'rebuild', 'better-sqlite3', 'sharp', '@duckdb/node-api']);
}

let runError = null;
try {
    run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
    run(process.execPath, [electronBuilderInstallDeps]);
    run(process.execPath, [electronCli, '.']);
} catch (err) {
    runError = err;
} finally {
    try {
        rebuildForCurrentNode();
    } catch (err) {
        console.warn('Failed to rebuild native modules for the current Node runtime.');
        console.warn(err && err.message ? err.message : String(err));
        if (!runError) runError = err;
    }
}

if (runError) {
    console.error(runError && runError.stack ? runError.stack : runError);
    process.exit(runError.status || 1);
}
