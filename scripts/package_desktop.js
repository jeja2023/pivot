const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
    assertBuildHost,
    assertLinuxPackageMetadata,
    assertRuntimeManifest,
    resolveBuildTarget,
    writePlatformChecksumManifest
} = require('./desktop-build-support');

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

function prepareBundledDesktopConfig() {
    const configPath = path.join(root, 'config.json');
    const original = fs.readFileSync(configPath, 'utf8');
    const envFile = path.join(root, '.env');
    const parsedEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile, 'utf8')) : {};
    const secret = String(
        process.env.PIVOT_DISTRIBUTION_STEALTH_SECRET
        || process.env.PIVOT_STEALTH_SECRET
        || parsedEnv.PIVOT_STEALTH_SECRET
        || ''
    ).trim();
    if (!secret) {
        throw new Error('桌面发布包必须显式提供 PIVOT_DISTRIBUTION_STEALTH_SECRET 或 PIVOT_STEALTH_SECRET。');
    }
    const config = JSON.parse(original);
    config.stealthSecret = secret;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return () => fs.writeFileSync(configPath, original, 'utf8');
}

function normalizeBuilderArgs(rawArgs) {
    const extraArgs = [`-c.extraMetadata.version=${projectVersion}`];
    if (!rawArgs.length) return ['--win', 'nsis', ...extraArgs];
    const isLinuxTarget = rawArgs.some(arg => arg === 'deb' || arg.toLowerCase() === 'appimage' || arg === '--linux' || arg.startsWith('-c.linux') || arg === '--loong64' || arg === '--arm64');
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

function copyReleaseArtifactsToDownloads(rawArgs, buildTarget) {
    if (rawArgs.includes('--dir')) {
        console.log('> skip downloads release artifacts for unpacked build');
        return;
    }

    const isLinuxTarget = buildTarget.platform === 'linux';
    if (isLinuxTarget) {
        fs.mkdirSync(downloadsDir, { recursive: true });
        const files = fs.readdirSync(electronOutputDir);
        const linuxArtifacts = files.filter(fileName => (
            fileName.endsWith('.deb')
            || fileName.endsWith('.AppImage')
            || /^latest-linux(?:-[a-z0-9]+)?\.yml$/i.test(fileName)
        ));
        if (linuxArtifacts.length === 0) throw new Error(`未生成 ${buildTarget.key} 发布产物。`);
        const copied = [];
        for (const fileName of linuxArtifacts) {
            const source = path.join(electronOutputDir, fileName);
            const target = path.join(downloadsDir, fileName);
            fs.copyFileSync(source, target);
            copied.push(path.relative(root, target));
        }
        const checksums = writePlatformChecksumManifest(downloadsDir, linuxArtifacts, buildTarget);
        copied.push(path.join('downloads', checksums.manifestName), path.join('downloads', 'SHA256SUMS.txt'));
        console.log(`> copied linux desktop release artifacts to downloads: ${copied.join(', ')}`);
        return;
    }

    const installerName = `Pivot Setup ${projectVersion}.exe`;
    const requiredArtifacts = [installerName, `${installerName}.blockmap`, 'latest.yml'];
    fs.mkdirSync(downloadsDir, { recursive: true });

    const copied = [];
    for (const fileName of requiredArtifacts) {
        const source = path.join(electronOutputDir, fileName);
        if (!fs.existsSync(source)) {
            throw new Error(`未生成预期的桌面打包产物: ${source}`);
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
    const checksums = writePlatformChecksumManifest(downloadsDir, checksumFiles, buildTarget);
    copied.push(path.join('downloads', checksums.manifestName), path.join('downloads', 'SHA256SUMS.txt'));

    console.log(`> copied desktop update artifacts to downloads: ${copied.join(', ')}`);
}

const rawBuilderArgs = process.argv.slice(2);
let runError = null;
let restoreBundledDesktopConfig = () => {};

try {
    const buildTarget = assertBuildHost(resolveBuildTarget(rawBuilderArgs));
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    restoreBundledDesktopConfig = prepareBundledDesktopConfig();
    if (buildTarget.platform === 'linux') assertLinuxPackageMetadata(packageJson, root);
    ensureElectronInstalled();
    cleanBuildOutputs();
    run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
    run(process.execPath, [path.join('scripts', 'package_browser_runtime.js')]);
    run(process.execPath, [path.join('scripts', 'package_python_runtime.js')]);
    assertRuntimeManifest(path.join(root, 'artifacts', 'agent-browser-pack', 'manifest.json'), buildTarget);
    assertRuntimeManifest(path.join(root, 'artifacts', 'agent-python-pack', 'manifest.json'), buildTarget, {
        requireBundled: buildTarget.platform === 'linux'
    });
    run(process.execPath, [electronBuilderInstallDeps]);
    const electronExecutable = require('electron');
    run(electronExecutable, [path.join('scripts', 'verify_desktop_runtime.js'), buildTarget.platform, buildTarget.arch], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    run(process.execPath, [electronBuilderCli, ...normalizeBuilderArgs(rawBuilderArgs)]);
    copyReleaseArtifactsToDownloads(rawBuilderArgs, buildTarget);
} catch (err) {
    runError = err;
} finally {
    try {
        restoreBundledDesktopConfig();
    } catch (restoreError) {
        console.error('恢复仓库内桌面配置失败:', restoreError);
        if (!runError) runError = restoreError;
    }
}

if (runError) {
    console.error(runError && runError.stack ? runError.stack : runError);
    process.exit(runError.status || 1);
}
