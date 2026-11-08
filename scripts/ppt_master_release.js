'use strict';

const builder = require('./lib/ppt_master_release');
function argumentsFor(args) {
    const result = {};
    for (let index = 0; index < args.length; index++) {
        const name = args[index];
        if (name === '--skip-build') { result.skipBuild = true; continue; }
        const key = { '--checkout': 'checkout', '--output': 'output', '--signing-key': 'signingKey', '--image': 'image', '--python': 'python' }[name];
        if (!key || !args[index + 1] || args[index + 1].startsWith('--') || result[key]) throw new Error('请使用--checkout、--output、--signing-key、--image、--python或--skip-build。');
        result[key] = args[++index];
    }
    if (!result.output) throw new Error('请通过--output指定新的离线包输出目录。');
    return result;
}
async function main(args = process.argv.slice(2)) {
    const options = argumentsFor(args);
    process.stdout.write('正在构建并核对固定PPT引擎，随后导出镜像和签名更新包。\n');
    const result = await builder.completeRelease(options, await builder.release(options));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n离线包已生成；发布私钥保留在构建机，生产只需登记一次可信公钥。\n');
    return result;
}
if (require.main === module) main().catch(error => { process.stderr.write('PPT离线包生成失败：' + error.message + '\n'); process.exitCode = 1; });
module.exports = { argumentsFor, main };
