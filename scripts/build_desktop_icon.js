const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const sourceCandidates = [
    path.join(root, 'client', 'favicon.png'),
    path.join(root, 'client', 'common', 'logo.png')
];
const outputPath = path.join(root, 'desktop', 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function encodeIcoEntry(size, imageSize, imageOffset) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(imageSize, 8);
    entry.writeUInt32LE(imageOffset, 12);
    return entry;
}

async function main() {
    const sourcePath = sourceCandidates.find(candidate => fs.existsSync(candidate));
    if (!sourcePath) {
        throw new Error('No PNG source found for desktop icon.');
    }

    const images = [];
    for (const size of sizes) {
        const buffer = await sharp(sourcePath)
            .resize(size, size, { fit: 'cover' })
            .png()
            .toBuffer();
        images.push({ size, buffer });
    }

    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    let offset = header.length + images.length * 16;
    const entries = images.map(({ size, buffer }) => {
        const entry = encodeIcoEntry(size, buffer.length, offset);
        offset += buffer.length;
        return entry;
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.concat([header, ...entries, ...images.map(item => item.buffer)]));
    console.log(`Desktop icon written: ${path.relative(root, outputPath)}`);
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
