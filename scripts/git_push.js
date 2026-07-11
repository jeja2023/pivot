// 智枢 (Pivot AI) - GitHub 安全推送脚本
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

process.chdir(path.resolve(__dirname, '..'));

function run(command, args, options = {}) {
    const { capture, ...spawnOptions } = options;
    return spawnSync(command, args, {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
        shell: false,
        ...spawnOptions
    });
}

function output(command, args, message) {
    try {
        return execFileSync(command, args, { encoding: 'utf8' }).trim();
    } catch (error) {
        console.error(`\n[错误] ${message || '命令执行失败。'}`);
        if (error.message) {
            console.error(error.message);
        }
        process.exit(error.status || 1);
    }
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(String(answer || '').trim());
    }));
}

function ensureOk(result, message) {
    if (result.error || result.status !== 0) {
        console.error(`\n[错误] ${message}`);
        if (result.error) {
            console.error(result.error.message);
        }
        process.exit(result.status || 1);
    }
}

function normalizeGitPath(file) {
    return String(file || '')
        .trim()
        .replace(/^"|"$/g, '')
        .replace(/\\/g, '/');
}

function splitRenamePath(rawPath) {
    const normalized = normalizeGitPath(rawPath);
    return normalized.includes(' -> ')
        ? normalized.split(' -> ').map(normalizeGitPath).filter(Boolean)
        : [normalized].filter(Boolean);
}

function pathsFromStatusLine(line) {
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    const paths = splitRenamePath(rawPath);
    const destinationPath = paths[paths.length - 1];

    if (!destinationPath) {
        return [];
    }

    const isUntracked = status === '??';
    const isPureDelete = !isUntracked && status.replace(/ /g, '').split('').every(mark => mark === 'D');
    if (isPureDelete) {
        return [];
    }

    return [destinationPath];
}

function pathsFromNameStatusLine(line) {
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('D')) {
        return [];
    }
    if (status.startsWith('R') || status.startsWith('C')) {
        return parts.slice(-1).map(normalizeGitPath).filter(Boolean);
    }
    return parts.slice(1).map(normalizeGitPath).filter(Boolean);
}

function isRiskyPath(file) {
    const normalized = normalizeGitPath(file);
    return /^(artifacts|data|uploads|logs|node_modules|dist-electron|dist-electron-remote|dist|build)(\/|$)/i.test(normalized)
        || /\.(log|sqlite|sqlite3|db|parquet|exe|msi|dmg|appimage|tar|zip|7z|rar|gz)$/i.test(normalized);
}

function riskyLines(lines, pathReader) {
    return lines.filter(line => pathReader(line).some(isRiskyPath));
}

function ensureNoRiskyFiles(title, lines, pathReader) {
    const risky = riskyLines(lines, pathReader);
    if (risky.length === 0) {
        return;
    }

    console.error(`[错误] ${title}`);
    risky.forEach(line => console.error(`  ${line}`));
    console.error('请先清理、取消暂存或加入 .gitignore，再重新运行脚本。');
    process.exit(1);
}

function ensureImportantFilesLookNormal() {
    const requiredNonEmptyFiles = ['eslint.config.js'];
    const invalidFiles = requiredNonEmptyFiles.filter(file => !fs.existsSync(file) || fs.statSync(file).size === 0);
    if (invalidFiles.length === 0) {
        return;
    }

    console.error('[错误] 检测到关键配置文件缺失或为空：');
    invalidFiles.forEach(file => console.error(`  ${file}`));
    console.error('请先恢复文件内容，再重新运行脚本。');
    process.exit(1);
}

async function main() {
    console.log('==========================================');
    console.log('      智枢 (Pivot AI) - GitHub 安全推送');
    console.log('==========================================\n');

    console.log('[1/6] 检查 Git 仓库状态...');
    ensureOk(run('git', ['rev-parse', '--is-inside-work-tree'], { capture: true }), '当前目录不是 Git 仓库，或未安装 Git。');
    ensureImportantFilesLookNormal();

    const branch = output('git', ['branch', '--show-current'], '无法读取当前 Git 分支。');
    if (branch !== 'main') {
        console.error(`[错误] 当前分支是 ${branch || '(未知)'}，不是 main。请先切换到 main 后再推送。`);
        process.exit(1);
    }

    const remoteUrl = output('git', ['remote', 'get-url', 'origin'], '未找到 origin 远程仓库。');
    console.log(`当前分支：${branch}`);
    console.log(`远程仓库：${remoteUrl}\n`);

    console.log('[2/6] 当前工作区状态：');
    ensureOk(run('git', ['status', '--short']), '无法读取工作区状态。');
    console.log();

    const porcelain = output('git', ['status', '--porcelain=v1'], '无法读取工作区状态。');
    if (porcelain) {
        console.log('[3/6] 检查是否存在容易误提交的文件...');
        ensureNoRiskyFiles('检测到可能不应提交的运行产物或大文件：', porcelain.split(/\r?\n/), pathsFromStatusLine);
        console.log('未发现明显风险文件。\n');

        const addAnswer = await ask('是否暂存当前所有修改并创建提交？输入 y 确认：');
        if (addAnswer.toLowerCase() !== 'y') {
            console.log('已取消。');
            process.exit(0);
        }

        ensureOk(run('git', ['add', '-A']), '暂存失败。');
        console.log('\n将要提交的内容：');
        ensureOk(run('git', ['diff', '--cached', '--stat']), '无法展示暂存内容。');
        ensureOk(run('git', ['diff', '--cached', '--check']), '暂存内容存在空白或格式问题，请修正后重试。');

        const message = await ask('\n请输入中文提交说明（留空使用“更新项目”）：');
        ensureOk(run('git', ['commit', '-m', message || '更新项目']), '提交失败。');
        console.log();
    } else {
        console.log('[3/6] 工作区没有未提交修改，跳过提交。\n');
    }

    console.log('[4/6] 检查本地与远程分支差异...');
    ensureOk(run('git', ['fetch', 'origin', 'main']), '拉取远程分支信息失败，请检查网络连接或 GitHub 权限。');
    const ahead = output('git', ['rev-list', '--count', 'origin/main..HEAD'], '无法计算本地领先提交数量。');
    const behind = output('git', ['rev-list', '--count', 'HEAD..origin/main'], '无法计算本地落后提交数量。');
    console.log(`本地领先远程：${ahead} 个提交`);
    console.log(`本地落后远程：${behind} 个提交\n`);

    if (Number(behind) > 0) {
        console.error('[错误] 远程 main 有本地没有的提交。请先拉取并处理冲突后再推送。');
        process.exit(1);
    }
    if (Number(ahead) === 0) {
        console.log('[5/6] 没有需要推送的新提交。');
        console.log('\n[完成] 本地 main 与 origin/main 已同步。');
        return;
    }

    const outgoingFiles = output('git', ['diff', '--name-status', 'origin/main..HEAD'], '无法检查待推送文件列表。');
    if (outgoingFiles) {
        ensureNoRiskyFiles('待推送提交中包含可能不应上传的运行产物或大文件：', outgoingFiles.split(/\r?\n/), pathsFromNameStatusLine);
    }

    console.log('[5/6] 即将推送以下提交：');
    ensureOk(run('git', ['log', '--oneline', 'origin/main..HEAD']), '无法展示待推送提交。');
    const pushAnswer = await ask('\n确认推送到 origin/main？输入 y 确认：');
    if (pushAnswer.toLowerCase() !== 'y') {
        console.log('已取消推送。');
        process.exit(0);
    }

    console.log('\n[6/6] 正在推送至 GitHub...');
    ensureOk(run('git', ['push', 'origin', 'main']), '推送失败，请检查网络连接、GitHub 权限或远程分支状态。');
    console.log('\n[成功] 已推送至 GitHub。');
}

main().catch(error => {
    console.error('\n[错误] 推送脚本执行失败：');
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
