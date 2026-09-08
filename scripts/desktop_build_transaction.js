'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANAGED_FILES = Object.freeze(['package.json', 'config.json']);

function statePathFor(rootDir) {
    const root = path.resolve(rootDir);
    const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), `pivot-desktop-build-${key}.json`);
}

function assertManagedPath(root, relative) {
    if (!MANAGED_FILES.includes(relative)) throw new Error(`拒绝恢复未授权的构建文件：${relative}`);
    const target = path.resolve(root, relative);
    if (path.dirname(target) !== root) throw new Error(`拒绝恢复工作区外路径：${target}`);
    return target;
}

function writeState(statePath, state) {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch (_) {}
    fs.renameSync(tempPath, statePath);
    try { fs.chmodSync(statePath, 0o600); } catch (_) {}
}

function recoverPendingDesktopBuildTransaction(rootDir) {
    const root = path.resolve(rootDir);
    const statePath = statePathFor(root);
    if (!fs.existsSync(statePath)) return false;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.root !== root || !state.files || typeof state.files !== 'object') {
        throw new Error(`桌面构建恢复状态无效：${statePath}`);
    }
    for (const [relative, content] of Object.entries(state.files)) {
        const target = assertManagedPath(root, relative);
        if (typeof content !== 'string') throw new Error(`桌面构建恢复内容无效：${relative}`);
        fs.writeFileSync(target, content, 'utf8');
    }
    fs.rmSync(statePath, { force: true });
    console.log('[desktop-build] 已恢复上次被中断的临时构建配置。');
    return true;
}

function beginDesktopBuildTransaction(rootDir) {
    const root = path.resolve(rootDir);
    recoverPendingDesktopBuildTransaction(root);
    const files = Object.fromEntries(MANAGED_FILES.map(relative => {
        const target = assertManagedPath(root, relative);
        return [relative, fs.readFileSync(target, 'utf8')];
    }));
    const statePath = statePathFor(root);
    writeState(statePath, { version: 1, root, files, createdAt: new Date().toISOString() });
    let settled = false;
    return {
        restore() {
            if (settled) return;
            settled = true;
            for (const [relative, content] of Object.entries(files)) {
                fs.writeFileSync(assertManagedPath(root, relative), content, 'utf8');
            }
            fs.rmSync(statePath, { force: true });
        },
        statePath
    };
}

module.exports = {
    beginDesktopBuildTransaction,
    recoverPendingDesktopBuildTransaction,
    statePathFor
};
