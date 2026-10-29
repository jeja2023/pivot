const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const images = ['pivot-offline-tools:1.0.0', 'yuzutech/kroki:0.28.0', 'yuzutech/kroki-mermaid:0.28.0'];
const { digestFile } = require('../server/services/offline-backup-bundle');

function renderComposeForToolsImage(source, image) {
    if (!/^(?:[a-z0-9][a-z0-9._-]*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image)) {
        throw new Error('工具镜像必须是带标签的有效镜像名。');
    }
    const original = 'image: pivot-offline-tools:1.0.0';
    if (source.split(original).length !== 2) throw new Error('Compose 工具镜像配置不符合预期。');
    return source.replace(original, `image: ${image}`);
}

async function main(args = process.argv.slice(2)) {
    if (args[0] === '--secret') {
        const file = path.resolve('data/secrets/offline-tools-token');
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
        console.log('工具服务密钥已创建，请通过受控渠道录入 Pivot 全局连接凭据。');
        return;
    }
    if (args[0] === '--verify' && args[1]) {
        const root = path.resolve(args[1]);
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'bom.json'), 'utf8'));
        if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 6
            || !Array.isArray(manifest.images) || manifest.images.length !== images.length) throw new Error('离线物料清单无效。');
        const names = new Set();
        for (const item of manifest.files) {
            if (!/^(image-[123]\.tar|docker-compose\.tools\.yml|requirements\.lock|verify_bundle\.py)$/.test(item.path)
                || names.has(item.path) || await digestFile(path.join(root, item.path)) !== item.sha256) throw new Error('离线物料校验失败。');
            names.add(item.path);
        }
        console.log('离线物料摘要校验通过。');
        return;
    }
    if (args[0] !== '--export' || !args[1]) throw new Error('请使用 --secret、--export 新目录 或 --verify 目录。');
    if (args.slice(2).some(arg => !arg.startsWith('--tools-image=')) || args.length > 3) throw new Error('导出仅支持 --tools-image=<本地镜像> 参数。');
    const selectedImage = args[2] ? args[2].slice('--tools-image='.length) : images[0];
    const compose = renderComposeForToolsImage(await fs.readFile('docker-compose.tools.yml', 'utf8'), selectedImage);
    const selectedImages = [selectedImage, ...images.slice(1)];
    const metadata = [];
    for (const image of selectedImages) {
        const inspected = await run('docker', ['image', 'inspect', image], { windowsHide: true });
        const item = JSON.parse(inspected.stdout)[0];
        metadata.push({ image, id: item.Id, architecture: item.Architecture, os: item.Os, repoDigests: item.RepoDigests });
    }
    const root = path.resolve(args[1]);
    await fs.mkdir(root, { mode: 0o700 });
    const files = [];
    for (let index = 0; index < selectedImages.length; index++) {
        const name = `image-${index + 1}.tar`;
        await run('docker', ['save', '--output', path.join(root, name), selectedImages[index]], { windowsHide: true });
        files.push({ path: name, sha256: await digestFile(path.join(root, name)) });
    }
    for (const [source, name] of [['docker-compose.tools.yml', 'docker-compose.tools.yml'], ['docker/offline-tools/requirements.lock', 'requirements.lock'], ['docker/offline-tools/verify_bundle.py', 'verify_bundle.py']]) {
        if (name === 'docker-compose.tools.yml') await fs.writeFile(path.join(root, name), compose, 'utf8');
        else await fs.copyFile(source, path.join(root, name));
        files.push({ path: name, sha256: await digestFile(path.join(root, name)) });
    }
    await fs.writeFile(path.join(root, 'bom.json'), JSON.stringify({ version: 1, images: metadata, files }, null, 2));
    console.log('离线镜像、依赖锁与物料清单已导出，生产密钥未包含在包中。');
}

if (require.main === module) main().catch(() => { console.error('离线物料操作失败，请检查命令参数、目录及镜像是否齐备。'); process.exitCode = 1; });
module.exports = { images, main, renderComposeForToolsImage };
