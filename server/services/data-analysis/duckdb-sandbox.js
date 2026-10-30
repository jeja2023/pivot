const { sqlLiteral } = require('./shared');

// 仅在物化授权输入表后调用；指定输出文件可导出，其余外部访问均被禁用。
async function lockDuckExternalAccess(connection, { allowedPaths = [] } = {}) {
    await connection.run('SET autoinstall_known_extensions=false');
    await connection.run('SET autoload_known_extensions=false');
    if (allowedPaths.length) {
        await connection.run(`SET allowed_paths=[${allowedPaths.map(sqlLiteral).join(',')}]`);
    }
    await connection.run('SET enable_external_access=false');
    await connection.run('SET lock_configuration=true');
}

module.exports = { lockDuckExternalAccess };
