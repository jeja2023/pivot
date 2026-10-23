const fs = require('fs/promises'); const path = require('path'); const { promisify } = require('util');
const run = promisify(require('child_process').execFile);
const { digestFile } = require('../server/services/offline-backup-bundle');

async function main(args = process.argv.slice(2)) {
    const root = path.resolve(args[1] || '');
    if (!['--export', '--verify'].includes(args[0]) || !args[1]) throw new Error('请使用 --export 新目录 或 --verify 目录。');
    if (args[0] === '--verify') {
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'bom.json'), 'utf8'));
        if (manifest.version !== 1 || manifest.files.length !== 10) throw new Error('扩展交付清单不完整。');
        const allowed = new Set(['tts-image.tar', 'docker-compose.tts.yml', 'requirements.lock', 'verify_bundle.py', 'tts-models/model.onnx', 'tts-models/voices.bin', 'tts-models/config.json', 'tts-models/MODEL_CARD.md', 'tts-models/manifest.json', '部署说明.md']);
        for (const item of manifest.files) {
            if (!allowed.delete(item.path) || await digestFile(path.join(root, item.path)) !== item.sha256) throw new Error('扩展交付文件摘要不一致。');
        }
        console.log('扩展交付物料摘要校验通过。'); return;
    }
    const image = JSON.parse((await run('docker', ['image', 'inspect', 'pivot-tts:1.0.0'], { windowsHide: true })).stdout)[0];
    const modelRoot = path.resolve('artifacts/tts-models');
    const models = JSON.parse(await fs.readFile(path.join(modelRoot, 'manifest.json'), 'utf8'));
    if (models.license !== 'Apache-2.0' || models.files.length !== 4) throw new Error('中文模型或授权记录不完整。');
    for (const item of models.files) if (!['model.onnx', 'voices.bin', 'config.json', 'MODEL_CARD.md'].includes(item.path)
        || await digestFile(path.join(modelRoot, item.path)) !== item.sha256) throw new Error('中文模型摘要校验失败。');
    await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(path.join(root, 'tts-models'));
    await run('docker', ['save', '--output', path.join(root, 'tts-image.tar'), 'pivot-tts:1.0.0'], { windowsHide: true });
    const sources = [['docker-compose.tts.yml', 'docker-compose.tts.yml'], ['docker/tts-service/requirements.lock', 'requirements.lock'], ['docker/tts-service/verify_bundle.py', 'verify_bundle.py'],
        ['docs/deployment/离线办公增强部署与验收.md', '部署说明.md'], ...models.files.map(item => [path.join(modelRoot, item.path), `tts-models/${item.path}`]), [path.join(modelRoot, 'manifest.json'), 'tts-models/manifest.json']];
    const files = [{ path: 'tts-image.tar', sha256: await digestFile(path.join(root, 'tts-image.tar')) }];
    for (const [source, name] of sources) { await fs.copyFile(source, path.join(root, name)); files.push({ path: name, sha256: await digestFile(path.join(root, name)) }); }
    await fs.writeFile(path.join(root, 'bom.json'), JSON.stringify({ version: 1, imageId: image.Id, architecture: image.Architecture, model: models.model, modelLicense: models.license, files }, null, 2));
    console.log('中文朗读镜像、固定模型及扩展物料已导出，密钥未包含在包中。');
}
if (require.main === module) main().catch(() => { console.error('办公扩展物料操作失败，请核对镜像、模型、清单及输出目录。'); process.exitCode = 1; });
module.exports = { main };
