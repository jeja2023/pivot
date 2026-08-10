const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronBuilderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const electronBuilderInstallDeps = path.join(root, 'node_modules', 'electron-builder', 'install-app-deps.js');
const projectVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const electronOutputDir = path.join(root, 'dist-electron-remote');
const downloadsDir = path.join(root, 'downloads');

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
    const isLinuxTarget = rawArgs.some(arg => arg === 'deb' || arg === '--linux' || arg.startsWith('-c.linux') || arg === '--loong64' || arg === '--arm64');
    if (isLinuxTarget) {
        if (!rawArgs.includes('--linux')) {
            return ['--linux', ...rawArgs, ...extraArgs];
        }
        return [...rawArgs, ...extraArgs];
    }
    if (rawArgs.includes('--dir')) return ['--win', '--dir', ...extraArgs];
    if (rawArgs.includes('nsis') || rawArgs.includes('--win')) return ['--win', ...rawArgs, ...extraArgs];
    return ['--win', ...rawArgs, ...extraArgs];
}

function copyReleaseArtifactsToDownloads(rawArgs) {
    if (rawArgs.includes('--dir')) {
        console.log('> skip downloads release artifacts for unpacked build');
        return;
    }

    const isLinuxTarget = rawArgs.some(arg => arg === 'deb' || arg === '--linux' || arg === '--loong64' || arg === '--arm64');
    if (isLinuxTarget) {
        fs.mkdirSync(downloadsDir, { recursive: true });
        const files = fs.readdirSync(electronOutputDir);
        const linuxArtifacts = files.filter(f => f.endsWith('.deb') || f.endsWith('.AppImage') || f.endsWith('.yml'));
        const copied = [];
        for (const fileName of linuxArtifacts) {
            const source = path.join(electronOutputDir, fileName);
            const target = path.join(downloadsDir, fileName);
            fs.copyFileSync(source, target);
            copied.push(path.relative(root, target));
        }
        if (copied.length > 0) {
            const checksumLines = linuxArtifacts.map((fileName) => {
                const content = fs.readFileSync(path.join(downloadsDir, fileName));
                const digest = crypto.createHash('sha256').update(content).digest('hex');
                return `${digest}  ${fileName}`;
            });
            const checksumTarget = path.join(downloadsDir, 'SHA256SUMS.txt');
            fs.writeFileSync(checksumTarget, `${checksumLines.join('\n')}\n`, 'utf8');
            copied.push(path.relative(root, checksumTarget));
            console.log(`> copied linux desktop release artifacts to downloads: ${copied.join(', ')}`);
        } else {
            console.log('> no linux release artifacts found to copy to downloads');
        }
        return;
    }

    const installerName = `Pivot Setup ${projectVersion}.exe`;
    const requiredArtifacts = [installerName, `${installerName}.blockmap`, 'latest.yml'];
    fs.mkdirSync(downloadsDir, { recursive: true });

    const copied = [];
    for (const fileName of requiredArtifacts) {
        const source = path.join(electronOutputDir, fileName);
        if (!fs.existsSync(source)) {
            throw new Error(`Expected desktop release artifact was not generated: ${source}`);
        }
        const target = path.join(downloadsDir, fileName);
        fs.copyFileSync(source, target);
        copied.push(path.relative(root, target));
    }

    const installerSource = path.join(electronOutputDir, installerName);
    const latestInstallerTarget = path.join(downloadsDir, 'Pivot-Setup.exe');
    fs.copyFileSync(installerSource, latestInstallerTarget);
    copied.push(path.relative(root, latestInstallerTarget));

    const checksumFiles = [...requiredArtifacts, 'Pivot-Setup.exe'];
    const checksumLines = checksumFiles.map((fileName) => {
        const content = fs.readFileSync(path.join(downloadsDir, fileName));
        const digest = crypto.createHash('sha256').update(content).digest('hex');
        return `${digest}  ${fileName}`;
    });
    const checksumTarget = path.join(downloadsDir, 'SHA256SUMS.txt');
    fs.writeFileSync(checksumTarget, `${checksumLines.join('\n')}\n`, 'utf8');
    copied.push(path.relative(root, checksumTarget));

    console.log(`> copied desktop update artifacts to downloads: ${copied.join(', ')}`);
}

const rawBuilderArgs = process.argv.slice(2);
let runError = null;

try {
    ensureElectronInstalled();
    cleanBuildOutputs();
    run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
    run(process.execPath, [electronBuilderInstallDeps]);
    run(process.execPath, [electronBuilderCli, ...normalizeBuilderArgs(rawBuilderArgs)]);
    copyReleaseArtifactsToDownloads(rawBuilderArgs);
} catch (err) {
    runError = err;
}

if (runError) {
    console.error(runError && runError.stack ? runError.stack : runError);
    process.exit(runError.status || 1);
}
