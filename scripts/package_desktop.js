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
const { createDesktopBuildStaging } = require('./desktop_build_staging');
const { loadDistributionDesktopConfig } = require('./desktop_distribution_config');
const { normalizeWindowsUpdatePublisher } = require('./desktop_update_signing');
const { autoProvisionDesktopEnvironment } = require('./desktop_auto_sign_profile');

const root = path.resolve(__dirname, '..');
const electronBuilderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const electronBuilderInstallDeps = path.join(root, 'node_modules', 'electron-builder', 'install-app-deps.js');
const projectVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const packageScriptArgs = process.argv.slice(2);
const outputArg = packageScriptArgs.find(arg => arg.startsWith('--output-dir='));
const rawBuilderArgs = packageScriptArgs.filter(arg => !arg.startsWith('--output-dir='));

function resolveElectronOutputDir(value = '') {
    const requested = String(value || 'dist-electron-remote').trim();
    const target = path.resolve(root, requested);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('dist-electron')) {
        throw new Error(`桌面构建输出目录必须位于工作区内并以 dist-electron 开头：${requested}`);
    }
    return target;
}

const electronOutputDir = resolveElectronOutputDir(outputArg?.slice('--output-dir='.length));
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
    console.log(`> remove ${electronOutputDir}`);
    fs.rmSync(electronOutputDir, { recursive: true, force: true });
}

function prepareBundledDesktopConfig(options = {}) {
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
    const distribution = loadDistributionDesktopConfig(root, process.env, {
        required: options.requireDistributionConfig === true
    });
    const config = distribution.config || JSON.parse(original);
    delete config.stealthSecret;
    config.stealthSecret = secret;
    if (config.autoUpdate?.enabled === true && options.windowsTarget) {
        if (options.windowsUpdatePublisher) {
            config.autoUpdate.publisherName = options.windowsUpdatePublisher;
        } else {
            // --dir 冒烟包没有发布证书，不能在启动时走一条无法签名校验的更新链。
            config.autoUpdate.enabled = false;
            delete config.autoUpdate.publisherName;
        }
    }
    if (distribution.sourcePath) console.log(`[desktop-config] 使用受控分发配置：${distribution.sourcePath}`);
    return { config };
}

function normalizeBuilderArgs(rawArgs) {
    const extraArgs = [
        `-c.extraMetadata.version=${projectVersion}`,
        `-c.directories.output=${path.relative(root, electronOutputDir)}`
    ];
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

let runError = null;
let desktopBuildStaging = null;

try {
    const buildTarget = assertBuildHost(resolveBuildTarget(rawBuilderArgs));
    const windowsRelease = buildTarget.platform === 'win32' && !rawBuilderArgs.includes('--dir');
    autoProvisionDesktopEnvironment(root, process.env, {
        platform: buildTarget.platform,
        isDirBuild: rawBuilderArgs.includes('--dir'),
        requireTrustedSigning: windowsRelease
    });
    // Electron 包内不会保留构建脚本；在组装 asar 之前必须显式产出全部聊天样式包。
    run(process.execPath, [path.join('scripts', 'build_chat_css.js')]);
    const windowsUpdatePublisher = normalizeWindowsUpdatePublisher(process.env.PIVOT_WINDOWS_UPDATE_PUBLISHER);
    const bundledDesktopConfig = prepareBundledDesktopConfig({
        requireDistributionConfig: !rawBuilderArgs.includes('--dir'),
        windowsTarget: buildTarget.platform === 'win32',
        windowsUpdatePublisher
    });
    desktopBuildStaging = createDesktopBuildStaging(root, {
        bundledConfig: bundledDesktopConfig.config,
        environment: process.env,
        runtimeProfile: { config: bundledDesktopConfig.config },
        windowsRelease
    });
    const desktopRuntimeProfile = desktopBuildStaging.desktopRuntimeProfile;
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (buildTarget.platform === 'linux') assertLinuxPackageMetadata(packageJson, root);
    ensureElectronInstalled();
    cleanBuildOutputs();
    run(process.execPath, [path.join('scripts', 'build_desktop_icon.js')]);
    if (desktopRuntimeProfile.includesBrowserRuntime) {
        run(process.execPath, [path.join('scripts', 'package_browser_runtime.js')]);
    }
    run(process.execPath, [path.join('scripts', 'package_python_runtime.js')]);
    if (desktopRuntimeProfile.includesBrowserRuntime) {
        assertRuntimeManifest(path.join(root, 'artifacts', 'agent-browser-pack', 'manifest.json'), buildTarget);
    }
    assertRuntimeManifest(path.join(root, 'artifacts', 'agent-python-pack', 'manifest.json'), buildTarget, {
        requireBundled: buildTarget.platform === 'linux'
    });
    run(process.execPath, [electronBuilderInstallDeps]);
    const electronExecutable = require('electron');
    run(electronExecutable, [path.join('scripts', 'verify_desktop_runtime.js'), buildTarget.platform, buildTarget.arch], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            PIVOT_VERIFY_DESKTOP_BROWSER_RUNTIME: String(desktopRuntimeProfile.includesBrowserRuntime)
        }
    });
    run(process.execPath, [electronBuilderCli, '--config', desktopBuildStaging.builderConfigPath, ...normalizeBuilderArgs(rawBuilderArgs)]);
    if (windowsRelease) {
        const installerPath = path.join(electronOutputDir, `Pivot Setup ${projectVersion}.exe`);
        const appPath = path.join(electronOutputDir, 'win-unpacked', 'Pivot.exe');
        run(process.execPath, [path.join('scripts', 'verify_windows_update_artifacts.js'), installerPath, appPath, windowsUpdatePublisher]);
    }
    copyReleaseArtifactsToDownloads(rawBuilderArgs, buildTarget);
} catch (err) {
    runError = err;
} finally {
    try { desktopBuildStaging?.cleanup(); } catch (cleanupError) {
        console.error('清理桌面构建 staging 目录失败:', cleanupError);
        if (!runError) runError = cleanupError;
    }
}

if (runError) {
    console.error(runError && runError.stack ? runError.stack : runError);
    process.exit(runError.status || 1);
}
