const { sqlLiteral } = require('./bi/sql-expressions');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// 仅在物化授权输入表后调用；指定输出文件可导出，其余外部访问均被禁用。
async function lockDuckExternalAccess(connection, { allowedPaths = [], spillDirectory = '' } = {}) {
    const spill = spillDirectory || await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-duck-spill-'));
    await fs.mkdir(spill, { recursive: true, mode: 0o700 });
    const cleanup = spillDirectory ? async () => {} : () => fs.rm(spill, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try {
        await connection.run('SET autoinstall_known_extensions=false');
        await connection.run('SET autoload_known_extensions=false');
        // DuckDB 可继承临时目录白名单，锁定前必须清除旧授权，不能只追加本次输出路径。
        await connection.run('SET allowed_directories=[]');
        await connection.run(`SET allowed_paths=[${allowedPaths.map(sqlLiteral).join(',')}]`);
        // 禁用外部访问会自动授权当前溢写目录，必须先换成操作独占目录。
        if (!spillDirectory) await connection.run(`SET temp_directory=${sqlLiteral(spill)}`);
        await connection.run('SET enable_external_access=false');
        await connection.run('SET lock_configuration=true');
        return cleanup;
    } catch (error) { await cleanup(); throw error; }
}

module.exports = { lockDuckExternalAccess };
