/**
 * scripts/ensure_sqlite_binary.js
 * 确保 better-sqlite3 原生绑定与当前 Node.js 运行时匹配。
 * 在多 Node 矩阵（如 CI Node 20 / Node 22 并行测试）环境中，若依赖预编译包与当前 ABI 不匹配，
 * 自动调用 node-gyp 本地编译并同步到 prebuilds 目录，确保测试平滑执行。
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

function ensureSqliteBinary() {
    try {
        const Sqlite = require('better-sqlite3');
        const db = new Sqlite(':memory:');
        db.close();
        return;
    } catch (err) {
        console.warn(`[better-sqlite3] 当前 Node (${process.version}) 原生绑定不可用 (${err.message})，正在重新编译...`);
    }

    try {
        const pkgDir = path.dirname(require.resolve('better-sqlite3/package.json'));
        cp.execSync('npx --no-install node-gyp rebuild --release --force_build=1', {
            cwd: pkgDir,
            stdio: 'inherit'
        });
        const built = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
        const prebuildTarget = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}.node`);
        if (fs.existsSync(built)) {
            fs.mkdirSync(path.dirname(prebuildTarget), { recursive: true });
            fs.copyFileSync(built, prebuildTarget);
            console.log(`[better-sqlite3] 编译完成并已替换预编译文件: ${prebuildTarget}`);
        }
        delete require.cache[require.resolve('better-sqlite3')];
        delete require.cache[require.resolve('better-sqlite3/lib/binding')];
        delete require.cache[require.resolve('better-sqlite3/lib/database')];
        const Sqlite = require('better-sqlite3');
        const db = new Sqlite(':memory:');
        db.close();
        console.log('[better-sqlite3] 自愈成功，已就绪。');
    } catch (rebuildErr) {
        console.error(`[better-sqlite3] 自动重新编译失败: ${rebuildErr.message}`);
    }
}

if (require.main === module) {
    ensureSqliteBinary();
}

module.exports = { ensureSqliteBinary };
