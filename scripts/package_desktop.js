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
const {
    assertProductionUpdateReleasePolicy,
    loadDistributionDesktopConfig
} = require('./desktop_distribution_config');
const { normalizeWindowsUpdatePublisher } = require('./desktop_update_signing');
const { autoProvisionDesktopEnvironment } = require('./desktop_auto_sign_profile');
const {
    isTrustedWindowsRelease,
    isWindowsIntranetRelease,
    isWindowsUpdateRelease,
    resolveWindowsReleaseChannel,
    stripWindowsReleaseChannelArgs
} = require('./desktop_release_channel');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
}
const electronBuilderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const electronBuilderInstallDeps = path.join(root, 'node_modules', 'electron-builder', 'install-app-deps.js');
const projectVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const packageScriptArgs = process.argv.slice(2);
const outputArg = packageScriptArgs.find(arg => arg.startsWith('--output-dir='));
const isIntranetBuild = isWindowsIntranetRelease(packageScriptArgs, process.env);
if (isIntranetBuild) {
    process.env.PIVOT_ALLOW_INTRANET_SELF_SIGNED = 'true';
}
const windowsReleaseChannel = resolveWindowsReleaseChannel(packageScriptArgs);
const rawBuilderArgs = stripWindowsReleaseChannelArgs(packageScriptArgs)
    .filter(arg => !arg.startsWith('--output-dir='));

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
    if (options.windowsTarget) {
        if (options.windowsUpdateRelease === true) {
            assertProductionUpdateReleasePolicy(config);
            if (!options.windowsUpdatePublisher || (options.windowsUpdatePublisher === 'Pivot Local Dev' && !options.allowIntranetSelfSigned)) {
                throw new Error('Windows 自动更新发布必须使用受信任签名发布者，不能使用 Pivot Local Dev。');
            }
            config.autoUpdate = {
                ...config.autoUpdate,
                publisherName: options.windowsUpdatePublisher,
                allowUntrustedRoot: options.allowIntranetSelfSigned === true
            };
        } else {
            // 开发、冒烟和离线安装包绝不携带可用更新链，防止自签名构建覆盖
            // 生产 downloads/latest.yml 后被已安装客户端误下载。
            config.autoUpdate = {
                ...(config.autoUpdate || {}),
                enabled: false,
                url: '',
                publisherName: '',
                allowedOrigins: []
            };
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

function copyReleaseArtifactsToDownloads(rawArgs, buildTarget, { publishWindowsUpdates = false } = {}) {
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

    if (!publishWindowsUpdates) {
        console.log('> 跳过开发或离线构建的 Windows 自动更新源发布');
        return;
    }

    const installerName = `Pivot Setup ${projectVersion}.exe`;
    const requiredArtifacts = [installerName, `${installerName}.blockmap`, 'latest.yml'];
    fs.mkdirSync(downloadsDir, { recursive: true });

    const copyAtomically = (source, target) => {
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        fs.copyFileSync(source, temporary);
        fs.renameSync(temporary, target);
    };
    const copied = [];
    // 必须最后替换 latest.yml：客户端只会在元数据出现后下载对应安装器，避免
    // 网络卷或 bind mount 读到指向尚未就绪文件的发布描述。
    const artifactFiles = requiredArtifacts.filter(fileName => fileName !== 'latest.yml');
    for (const fileName of artifactFiles) {
        const source = path.join(electronOutputDir, fileName);
        if (!fs.existsSync(source)) {
            throw new Error(`未生成预期的桌面打包产物: ${source}`);
        }
        const target = path.join(downloadsDir, fileName);
        copyAtomically(source, target);
        copied.push(path.relative(root, target));
    }

    const installerSource = path.join(electronOutputDir, installerName);
    const latestInstallerTarget = path.join(downloadsDir, 'Pivot-Setup.exe');
    copyAtomically(installerSource, latestInstallerTarget);
    copied.push(path.relative(root, latestInstallerTarget));

    const latestSource = path.join(electronOutputDir, 'latest.yml');
    const latestTarget = path.join(downloadsDir, 'latest.yml');
    copyAtomically(latestSource, latestTarget);
    copied.push(path.relative(root, latestTarget));

    const checksumFiles = [...requiredArtifacts, 'Pivot-Setup.exe'];
    const checksums = writePlatformChecksumManifest(downloadsDir, checksumFiles, buildTarget);
    copied.push(path.join('downloads', checksums.manifestName), path.join('downloads', 'SHA256SUMS.txt'));

    console.log(`> copied desktop update artifacts to downloads: ${copied.join(', ')}`);
}

let runError = null;
let desktopBuildStaging = null;

try {
    const buildTarget = assertBuildHost(resolveBuildTarget(rawBuilderArgs));
    const isWindowsTarget = buildTarget.platform === 'win32';
    const isDirBuild = rawBuilderArgs.includes('--dir');
    if (isWindowsTarget && isDirBuild && isTrustedWindowsRelease(windowsReleaseChannel)) {
        throw new Error('Windows 自动更新或离线正式发布不能使用 --dir；请生成 NSIS 安装器。');
    }
    const windowsRelease = isWindowsTarget && !isDirBuild && isTrustedWindowsRelease(windowsReleaseChannel);
    const windowsUpdateRelease = isWindowsTarget && !isDirBuild && isWindowsUpdateRelease(windowsReleaseChannel);
    autoProvisionDesktopEnvironment(root, process.env, {
        platform: buildTarget.platform,
        isDirBuild,
        requireTrustedSigning: windowsRelease,
        requireDistributionConfig: windowsRelease,
        allowIntranetSelfSigned: isIntranetBuild
    });
    // Electron 包内不会保留构建脚本；在组装 asar 之前必须显式产出全部聊天样式包。
    run(process.execPath, [path.join('scripts', 'build_chat_css.js')]);
    const windowsUpdatePublisher = normalizeWindowsUpdatePublisher(process.env.PIVOT_WINDOWS_UPDATE_PUBLISHER);
    const bundledDesktopConfig = prepareBundledDesktopConfig({
        requireDistributionConfig: windowsRelease && !isIntranetBuild,
        windowsTarget: isWindowsTarget,
        windowsUpdateRelease,
        windowsUpdatePublisher,
        allowIntranetSelfSigned: isIntranetBuild
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
    if (windowsUpdateRelease) {
        run(process.execPath, [
            path.join('scripts', 'verify_desktop_update_release.js'),
            electronOutputDir,
            path.join(electronOutputDir, 'win-unpacked', 'resources'),
            projectVersion,
            windowsUpdatePublisher
        ]);
    }
    // 只有构建输出的签名、元数据、feed 和客户端内嵌配置已完整通过验收后，
    // 才允许将其发布到生产 downloads/。latest.yml 在复制函数内最后原子替换。
    copyReleaseArtifactsToDownloads(rawBuilderArgs, buildTarget, { publishWindowsUpdates: windowsUpdateRelease });
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
